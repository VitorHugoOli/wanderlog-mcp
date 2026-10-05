import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { TripPlan } from "../types.js";
import { ALLOW_DUPLICATE_HINT, findDuplicateNote } from "./duplicate-guard.js";
import { deltaOffsetText, findNoteParagraphs } from "./remove-note.js";
import { hasInsertAnchor, insertAnchorSchema, resolveInsertionPoint } from "./insert-position.js";
import {
  buildNoteBlock,
  findBlockTargetSection,
  requireUserId,
  submitOp,
  type TargetSection,
} from "./shared.js";

export const addNoteInputSchema = z.object({
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add the note to. Use wanderlog_list_trips if you don't know the key."),
  text: z.string().min(1).describe("The note text. Plain text — can be multi-line."),
  day: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional day to add the note to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. If 'section' is also provided, the section takes precedence. Omit both to add to the 'Places to visit' list.",
    ),
  section: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional undated section to add the note to, identified by its heading (e.g. 'Food & Drink', 'Places to visit', or 'Notes' / 'Notas' for the trip's free-text notes area, where the note becomes a new paragraph). Matching is case-insensitive and takes precedence over 'day'. Omit both to add to the 'Places to visit' list.",
    ),
  ...insertAnchorSchema,
  allow_duplicate: z
    .boolean()
    .optional()
    .describe(
      "Set true to add the note even if a note with identical text is already in that day/section. Default false: an identical repeat is reported as already there.",
    ),
});

export const addNoteDescription = `
Adds a text note to a Wanderlog trip. Notes appear inline between places in a day, acting as
the connective tissue of the itinerary. Every well-built day should have notes between stops.
Supply "day" for a dated itinerary day or "section" for an undated section such as "Notes"
or "Food & Drink". When both are provided, "section" takes precedence. Omit both to add to
the default "Places to visit" list.

When to add a note (do this after adding each place or group of places):
- How to get there: "Walk 15 min along the South Bank, or take the Jubilee line one stop"
- Practical tips: "Book tickets online at least 2 days ahead — sells out in summer"
- Food/drink recs: "Try the salt beef bagel at Beigel Bake — cash only, open 24hrs"
- Time guidance: "Budget 2-3 hours here. Open 10am-6pm, closed Tuesdays"
- Neighborhood context: "This area is great for wandering — no rush, just explore the lanes"

Placement: by default the note goes at the end of the day/section. Pass ONE of "position" (the
number wanderlog_get_trip shows; between items 3 and 4 is 4), "before" or "after" (a place in
the same day/section) to put it elsewhere — e.g. after: "Louvre" for directions to the next stop.

A note whose text is identical to one already in that day/section is not added again (so a retry
after an unclear error never duplicates it); pass allow_duplicate: true if it is intended.

Returns a confirmation of where the note was added.
`.trim();

type Args = z.infer<typeof addNoteInputSchema>;

export async function addNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const target = findBlockTargetSection(trip, args, "note");
      if (target.section.type === "textOnly") {
        return appendToNotesArea(trip, target, args, submit);
      }
      if (!args.allow_duplicate && findDuplicateNote(target.section, args.text)) {
        return { added: false, targetLabel: target.label, placement: "", tripTitle: trip.title };
      }
      const point = resolveInsertionPoint(trip, target.index, args);
      // Insert and text in one submit, so the note can never land empty.
      const blockPath = ["itinerary", "sections", target.index, "blocks", point.index];
      const ops: Json0Op[] = [
        { p: blockPath, li: buildNoteBlock(userId) },
        { p: [...blockPath, "text"], t: "rich-text", o: [{ insert: `${args.text}\n` }] },
      ];
      await submit(ops);
      return {
        added: true,
        targetLabel: target.label,
        placement: hasInsertAnchor(args) ? ` ${point.description}` : "",
        tripTitle: trip.title,
      };
    });

    const preview = args.text.length > 60 ? `${args.text.slice(0, 57)}…` : args.text;
    const text = result.added
      ? `Added note "${preview}" to ${result.targetLabel}${result.placement} in "${result.tripTitle}".`
      : `A note "${preview}" is already in ${result.targetLabel} in "${result.tripTitle}" — nothing added. ${ALLOW_DUPLICATE_HINT}`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/**
 * The trip-level notes area is free rich text (section.text), not a list of
 * note blocks, so a note is appended there as a new paragraph.
 */
async function appendToNotesArea(
  trip: TripPlan,
  target: TargetSection,
  args: Args,
  submit: (ops: Json0Op[]) => Promise<void>,
) {
  const label = `section "${target.section.heading || "Notes"}"`;
  if (hasInsertAnchor(args)) {
    throw new WanderlogValidationError(
      `${label} is free text, so position/before/after do not apply — the note is added as a new paragraph at the end.`,
    );
  }
  const text = args.text.trim();
  if (
    !args.allow_duplicate &&
    findNoteParagraphs(target.section.text, text).some((p) => p.text.trim() === text)
  ) {
    return { added: false, targetLabel: label, placement: "", tripTitle: trip.title };
  }
  const existing = deltaOffsetText(target.section.text);
  const textPath = ["itinerary", "sections", target.index, "text"];
  let ops: Json0Op[];
  if (!target.section.text) {
    ops = [{ p: textPath, oi: { ops: [{ insert: `${text}\n` }] } }];
  } else {
    // Insert before the document's final newline; start a new paragraph unless
    // the area is empty.
    const end = Math.max(0, existing.length - 1);
    const insert = existing.trim() ? `\n${text}` : text;
    ops = [
      { p: textPath, t: "rich-text", o: end > 0 ? [{ retain: end }, { insert }] : [{ insert }] },
    ];
  }
  await submit(ops);
  return { added: true, targetLabel: label, placement: "", tripTitle: trip.title };
}
