import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { NoteBlock, QuillDelta, TripPlan } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const removeNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  text: z
    .string()
    .min(1)
    .optional()
    .describe("Substring to match against note content (case-insensitive)."),
  note_ids: z
    .array(z.number().int())
    .min(1)
    .optional()
    .describe(
      "Exact note block ids to remove (shown as [id …] by wanderlog_get_trip with response_format 'detailed'). Removes all of them in one change; use instead of text when several notes share wording.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to search. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to search the entire trip.",
    ),
};

export const removeNoteDescription = `
Removes a note from a Wanderlog trip by matching a substring of its text content: either a note
block in a day or list, or a paragraph of the trip's free-text Notes area.

The match is case-insensitive. If exactly one note matches, it is deleted. If no notes match,
an error is returned. If multiple notes match, a list of previews is returned — supply a more
specific substring to narrow to one.

Use the optional 'day' filter to limit the search to a specific day. To remove specific note
blocks (or several at once) pass note_ids from wanderlog_get_trip's detailed output instead.
`.trim();

type Args = {
  trip_key: string;
  text?: string;
  note_ids?: number[];
  day?: string;
};

export type NoteMatch = {
  sectionIndex: number;
  blockIndex: number;
  plainText: string;
  block: NoteBlock;
};

export function extractDeltaText(delta: QuillDelta | undefined): string {
  const ops = delta?.ops ?? [];
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

/** Object (embed) placeholder: Quill counts an embed as one character. */
export const EMBED_CHAR = "\uFFFC";

/**
 * Plain text whose offsets match Quill's: embeds (images, mentions) count as
 * one character. Use this, not extractDeltaText, to compute retain/delete
 * offsets for rich-text ops.
 */
export function deltaOffsetText(delta: QuillDelta | undefined): string {
  const ops = delta?.ops ?? [];
  return ops
    .map((op) => (typeof op.insert === "string" ? op.insert : op.insert ? EMBED_CHAR : ""))
    .join("");
}

/** Paragraphs of a free-text notes area containing `query` (case-insensitive). */
export function findNoteParagraphs(
  delta: QuillDelta | undefined,
  query: string,
): Array<{ offset: number; length: number; text: string }> {
  const text = deltaOffsetText(delta);
  const lowerQuery = query.toLowerCase();
  const paragraphs: Array<{ offset: number; length: number; text: string }> = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const length = line.length + 1;
    if (line.trim() && line.toLowerCase().includes(lowerQuery)) {
      paragraphs.push({ offset: start, length, text: line });
    }
    start += length;
  }
  return paragraphs;
}

export function extractPlainText(block: NoteBlock): string {
  return extractDeltaText(block.text);
}

export function findNoteMatches(trip: TripPlan, query: string, day?: string): NoteMatch[] {
  const lowerQuery = query.toLowerCase();
  const sections = trip.itinerary.sections;
  const matches: NoteMatch[] = [];

  let sectionIndices: number[];
  if (day) {
    const resolved = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, resolved.date!);
    if (!found) return [];
    sectionIndices = [found.index];
  } else {
    sectionIndices = Array.from({ length: sections.length }, (_, i) => i);
  }

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (block.type !== "note") continue;
      const noteBlock = block as NoteBlock;
      const plainText = extractPlainText(noteBlock);
      if (plainText.toLowerCase().includes(lowerQuery)) {
        matches.push({ sectionIndex, blockIndex, plainText, block: noteBlock });
      }
    }
  }

  return matches;
}

/** Paragraphs of the trip's free-text Notes area(s) that contain the query. */
function findNotesAreaParagraphs(trip: TripPlan, query: string) {
  return trip.itinerary.sections.flatMap((section, sectionIndex) =>
    section.type === "textOnly" && section.text
      ? findNoteParagraphs(section.text, query).map((paragraph) => ({
          sectionIndex,
          paragraph,
          docLength: deltaOffsetText(section.text).length,
        }))
      : [],
  );
}

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export async function removeNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (args.note_ids) return await removeNotesById(ctx, args.trip_key, args.note_ids);
    if (!args.text) {
      throw new WanderlogValidationError("Give either text (a substring) or note_ids.");
    }
    const query = args.text;
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const matches = findNoteMatches(trip, query, args.day);
      const paragraphs = args.day ? [] : findNotesAreaParagraphs(trip, query);
      const total = matches.length + paragraphs.length;
      if (total === 0) {
        throw new WanderlogNotFoundError("Note", args.text);
      }
      if (total === 1 && paragraphs.length === 1) {
        const { sectionIndex, paragraph, docLength } = paragraphs[0]!;
        // Never delete the document's final newline (a Quill doc must end with
        // one). For the last paragraph, take the newline before it instead, so
        // no empty line (or empty bullet) is left behind.
        const isLast = paragraph.offset + paragraph.length >= docLength;
        let start = paragraph.offset;
        let length = paragraph.length;
        if (isLast) {
          length -= 1;
          if (start > 0) {
            start -= 1;
            length += 1;
          }
        }
        const o: Array<Record<string, unknown>> = [];
        if (start > 0) o.push({ retain: start });
        o.push({ delete: length });
        await submit([{ p: ["itinerary", "sections", sectionIndex, "text"], t: "rich-text", o }]);
        return { plainText: paragraph.text, tripTitle: trip.title };
      }
      if (total > 1) {
        const lines = [
          ...matches.map((m) => m.plainText),
          ...paragraphs.map((p) => p.paragraph.text),
        ]
          .slice(0, 5)
          .map((text, i) => `  ${i + 1}. "${notePreview(text)}"`)
          .join("\n");
        const suffix = total > 5 ? `\n  (${total - 5} more…)` : "";
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `"${args.text}" matches ${total} notes:\n${lines}${suffix}\n\nCall again with a more specific substring to identify the one you want.`,
              },
            ],
            isError: true,
          },
        };
      }
      const { sectionIndex, blockIndex, block, plainText } = matches[0]!;
      const blockId = block.id;
      const ops: Json0Op[] = [
        { p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex], ld: block },
      ];
      await submit(ops);
      const remains = entry.snapshot.itinerary.sections.some((section) =>
        section.blocks.some((candidate) => candidate.id === blockId),
      );
      if (remains) throw new WanderlogError("Removed note is still present", "stale_target");
      return { plainText, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;
    const text = `Removed note "${notePreview(result.plainText)}" from "${result.tripTitle}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/** Remove note blocks by exact id, all in one submit (wcrusher@92dc395 idea). */
async function removeNotesById(
  ctx: AppContext,
  tripKey: string,
  ids: number[],
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const result = await submitOp(ctx, tripKey, async (entry, submit) => {
    const trip = entry.snapshot;
    const wanted = new Set(ids);
    const found: Array<{ sectionIndex: number; blockIndex: number; block: NoteBlock }> = [];
    trip.itinerary.sections.forEach((section, sectionIndex) =>
      section.blocks.forEach((block, blockIndex) => {
        if (block.type === "note" && wanted.has(block.id as number)) {
          found.push({ sectionIndex, blockIndex, block: block as NoteBlock });
        }
      }),
    );
    const missing = ids.filter((id) => !found.some((f) => f.block.id === id));
    if (missing.length > 0) {
      throw new WanderlogNotFoundError("Note", missing.map((id) => `id ${id}`).join(", "));
    }
    // Highest index first within each section so each ld keeps the next valid.
    const ops: Json0Op[] = [...found]
      .sort((a, b) => b.sectionIndex - a.sectionIndex || b.blockIndex - a.blockIndex)
      .map((f) => ({
        p: ["itinerary", "sections", f.sectionIndex, "blocks", f.blockIndex],
        ld: f.block,
      }));
    await submit(ops);
    return {
      previews: found.map((f) => notePreview(extractPlainText(f.block))),
      tripTitle: trip.title,
    };
  });
  return {
    content: [
      {
        type: "text",
        text: `Removed ${result.previews.length} note(s) from "${result.tripTitle}": ${result.previews.map((p) => `"${p}"`).join(", ")}.`,
      },
    ],
  };
}
