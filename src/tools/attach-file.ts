import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveAttachmentRef } from "../resolvers/attachment-ref.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { findBlockById, submitOp } from "./shared.js";
import { readUploadableFile } from "./uploads.js";

export const attachFileInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the place."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place to attach the file to. Same syntax as remove_place — name, 'the hotel', ordinal prefixes, day filters.",
    ),
  file_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path on the local filesystem to upload (PDF, image, document). Mutually exclusive with 'attachment'. Read by the MCP server process — must be accessible to it.",
    ),
  attachment: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Reference to a file already uploaded on this trip — either the storage key (preferred, get it from wanderlog_list_attachments detailed) or a substring of the filename. Mutually exclusive with 'file_path'. Use this to link an existing file to a different place without re-uploading.",
    ),
  file_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional display name override (upload mode only). Defaults to the basename of file_path.",
    ),
  content_type: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional MIME type override (upload mode only). If omitted, the server detects it from the bytes.",
    ),
};

// Ported from pharkrum@ec393e3 / @b0e5822, reworked onto submitOp with
// upload path guards (src/tools/uploads.ts).
export const attachFileDescription = `
Attaches a file (PDF, image, document) to a place in a Wanderlog trip — same as the
"Attach file" action in the Wanderlog UI. Useful for trip docs: booking confirmations,
boarding passes, museum tickets, hotel vouchers.

Two modes:
  - **Upload mode** (file_path): reads a local file, uploads it via
    POST /api/tripPlans/{key}/attachment, then attaches it to the place.
  - **Reference mode** (attachment): links an *already-uploaded* file to another place
    without re-uploading. Wanderlog stores attachments at trip scope and lets places
    reference the same storage key. Use wanderlog_list_attachments to find existing files.

Exactly one of file_path or attachment must be provided. file_path must be an absolute
path; remote files must be downloaded locally first.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  file_path?: string;
  attachment?: string;
  file_name?: string;
  content_type?: string;
};

// Best-effort MIME type guess from extension. The server has its own
// detection — this is just a sensible hint when the caller didn't override.
function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

type Attachment = {
  type: string;
  key: string;
  contentType: string;
  fileName: string;
};

export async function attachFile(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (args.file_path && args.attachment) {
      throw new WanderlogValidationError(
        "Provide either 'file_path' (upload) or 'attachment' (reference an existing file), not both.",
      );
    }
    if (!args.file_path && !args.attachment) {
      throw new WanderlogValidationError(
        "attach_file requires either 'file_path' (to upload a new file) or 'attachment' (to reference an existing one).",
      );
    }

    const trip = await ctx.tripCache.get(args.trip_key);
    const placeResult = resolvePlaceRef(trip, args.place_ref);
    if (placeResult.kind === "none") {
      throw new WanderlogNotFoundError("place", args.place_ref);
    }
    if (placeResult.kind === "ambiguous") {
      const lines = placeResult.candidates
        .slice(0, 10)
        .map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : `${c.block.type} block`;
          return `  ${i + 1}. ${name}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `"${args.place_ref}" matches ${placeResult.candidates.length} places:\n${lines}\n\nRetry with a more specific reference.`,
          },
        ],
        isError: true,
      };
    }

    // Produce the attachment object: either from uploading a local file or
    // by referencing an already-uploaded one on this trip.
    let newAttachment: Attachment;
    let summary: string;

    if (args.file_path) {
      const bytes = await readUploadableFile(args.file_path);
      const fileName = args.file_name ?? path.basename(args.file_path);
      const contentType = args.content_type ?? guessContentType(args.file_path);
      // Upload first; if it fails we never touch the trip doc.
      const { key, mimeType } = await ctx.rest.uploadAttachment(args.trip_key, {
        fileName,
        contentType,
        bytes,
      });
      newAttachment = { type: "file", key, contentType: mimeType, fileName };
      const sizeKb = (bytes.length / 1024).toFixed(1);
      summary = `Uploaded and attached "${fileName}" (${sizeKb} KB, ${mimeType})`;
    } else {
      // Reference mode — find an existing attachment on the trip.
      const ref = args.attachment!;
      const existing = resolveAttachmentRef(trip, ref);
      if (existing.kind === "none") {
        return {
          content: [
            {
              type: "text",
              text: `No attachment matching "${ref}" on "${trip.title}". Use wanderlog_list_attachments to see what's available, or pass file_path to upload a new one.`,
            },
          ],
          isError: true,
        };
      }
      if (existing.kind === "ambiguous") {
        const lines = existing.candidates
          .slice(0, 10)
          .map((a, i) => `  ${i + 1}. ${a.fileName} (key: ${a.key.slice(0, 12)}…)`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `"${ref}" matches ${existing.candidates.length} attachments:\n${lines}\n\nRetry with a more specific filename or the full storage key.`,
            },
          ],
          isError: true,
        };
      }
      newAttachment = {
        type: existing.match.type,
        key: existing.match.key,
        contentType: existing.match.contentType,
        fileName: existing.match.fileName,
      };
      summary = `Attached existing file "${existing.match.fileName}"`;
    }

    // Check whether this file is ALREADY on this exact place — refuse to
    // add a duplicate reference (matches the UI, which dedupes by key).
    const blockId = placeResult.match.block.id;
    const blockLabel = isPlaceBlock(placeResult.match.block)
      ? placeResult.match.block.place.name
      : `${placeResult.match.block.type} block`;
    // The upload can take a while: re-find the block by id under the trip lock
    // so the op targets its current position and current attachment list.
    const outcome = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const located = findBlockById(entry.snapshot, blockId);
      if (!located) {
        throw new WanderlogError(`${blockLabel} is no longer in the trip`, "stale_target");
      }
      const blockRaw = located.block as Record<string, unknown>;
      const oldAttachments: Attachment[] = Array.isArray(blockRaw.attachments)
        ? ((blockRaw.attachments as unknown[]).filter(
            (a) => typeof a === "object" && a !== null,
          ) as Attachment[])
        : [];
      // The UI dedupes by key on one place; so do we.
      if (oldAttachments.some((a) => a.key === newAttachment.key)) return "already";
      const attachPath = [
        "itinerary",
        "sections",
        located.sectionIndex,
        "blocks",
        located.blockIndex,
        "attachments",
      ];
      const newAttachments = [...oldAttachments, newAttachment];
      await submit([
        "attachments" in blockRaw
          ? { p: attachPath, od: blockRaw.attachments, oi: newAttachments }
          : { p: attachPath, oi: newAttachments },
      ]);
      return "attached";
    });
    const text =
      outcome === "already"
        ? `"${newAttachment.fileName}" is already attached to ${blockLabel}.`
        : `${summary} → ${blockLabel} in "${trip.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
