import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { listTripAttachments } from "../resolvers/attachment-ref.js";

export const listAttachmentsInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose attachments to list."),
  response_format: z
    .enum(["concise", "detailed"])
    .default("concise")
    .describe(
      "Output verbosity. 'concise' shows one row per file. 'detailed' adds the storage key and the list of places each file is attached to.",
    ),
};

export const listAttachmentsDescription = `
Lists every file that's been uploaded to a Wanderlog trip — even if a file is currently
attached to multiple places, it appears once with the count of references.

Useful for:
  - Knowing what's already uploaded before deciding whether to re-upload.
  - Picking an existing file to attach to another place via
    wanderlog_attach_file with the 'attachment' parameter.

Detailed mode prints the storage key (use it as the most reliable 'attachment' arg) and the
list of places each file is currently linked to.
`.trim();

type Args = {
  trip_key: string;
  response_format?: "concise" | "detailed";
};

function describeSection(section: {
  type?: string;
  mode?: string;
  heading?: string;
  date?: string | null;
}): string {
  if (section.mode === "dayPlan" && section.date) return `day ${section.date}`;
  if (section.heading) return `"${section.heading}"`;
  return `"${section.type ?? "section"}"`;
}

export async function listAttachments(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const attachments = listTripAttachments(trip);

    if (attachments.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `"${trip.title}" has no attachments yet. Use wanderlog_attach_file with file_path to upload one.`,
          },
        ],
      };
    }

    const format = args.response_format ?? "concise";
    const lines: string[] = [
      `📎 Attachments on "${trip.title}" — ${attachments.length} file${attachments.length === 1 ? "" : "s"}`,
      "",
    ];

    for (const a of attachments) {
      const refs = a.places.length;
      if (format === "concise") {
        lines.push(
          `  • ${a.fileName} [${a.contentType}] — referenced ${refs} place${refs === 1 ? "" : "s"}`,
        );
      } else {
        lines.push(`  • ${a.fileName} [${a.contentType}]`);
        lines.push(`      key: ${a.key}`);
        const placeLines = a.places.map(
          (p) => `        - ${p.placeName} (${describeSection(p.section)})`,
        );
        lines.push(...placeLines);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
