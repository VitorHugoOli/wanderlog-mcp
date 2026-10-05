import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { ALLOW_DUPLICATE_HINT, findDuplicateNote } from "./duplicate-guard.js";
import { hasInsertAnchor, insertAnchorSchema, resolveInsertionPoint } from "./insert-position.js";
import { buildNoteBlock, findBlockTargetSection, requireUserId, submitOp } from "./shared.js";

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
      "Optional undated section to add the note to, identified by its heading (e.g. 'Notes', 'Food & Drink', or 'Places to visit'). Matching is case-insensitive and takes precedence over 'day'. Omit both to add to the 'Places to visit' list.",
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
