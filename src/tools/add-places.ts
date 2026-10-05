import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { fillNewBlockTextOps, noteTextToDelta } from "../ot/rich-text.js";
import type { PlaceData } from "../types.js";
import { findDuplicatePlace } from "./duplicate-guard.js";
import {
  hasInsertAnchor,
  insertAnchorSchema,
  resolveInsertionPoint,
  type InsertAnchor,
} from "./insert-position.js";
import { resolvePlaceQuery, suggestionName } from "./place-resolution.js";
import {
  buildPlaceBlock,
  findBlockTargetSection,
  findTripCenter,
  requireUserId,
  submitOp,
  validateTimeInputs,
} from "./shared.js";

const placeItem = z.object({
  place: z.string().min(1).optional().describe("Place name to search for."),
  place_id: z
    .string()
    .min(1)
    .optional()
    .describe("Exact Google place_id (from wanderlog_search_places, detailed format)."),
  note: z.string().optional().describe("Inline note on the place (markdown)."),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional(),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional(),
});

export const addPlacesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add to."),
  places: z
    .array(placeItem)
    .min(1)
    .max(15)
    .describe("Places to add, in order (1–15). Each needs place or place_id."),
  day: z
    .string()
    .optional()
    .describe("Day to add them to ('day 2', 'May 4', '2026-05-04'). Omit for Places to visit."),
  section: z.string().min(1).optional().describe("Or an undated list by heading."),
  ...insertAnchorSchema,
};

export const addPlacesDescription = `
Adds several places to one day or list in a single call (idea from timoranjes' batch_add_places):
each is resolved like wanderlog_add_place, then all are written together in one change, in the
given order. Use it to lay out a day quickly. position/before/after place the first one; the
rest follow it. A place that cannot be resolved confidently, or is already there at the same
time, is skipped and reported — the others are still added.
`.trim();

type Item = z.infer<typeof placeItem>;
type Args = {
  trip_key: string;
  places: Item[];
  day?: string;
  section?: string;
} & InsertAnchor;

export async function addPlaces(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    for (const item of args.places) {
      if (!item.place && !item.place_id) {
        throw new WanderlogValidationError("Every entry in places needs place or place_id.");
      }
      validateTimeInputs(item.start_time, item.end_time);
    }
    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const center = findTripCenter(entry.snapshot, entry.geos);

    // Resolve one at a time: a burst of parallel lookups is what Wanderlog
    // rate-limits.
    const resolved: Array<{ item: Item; detail: PlaceData; imageKeys: unknown[] }> = [];
    const skipped: string[] = [];
    for (const item of args.places) {
      const label = item.place ?? item.place_id!;
      try {
        let detail: PlaceData;
        if (item.place_id) {
          detail = await ctx.rest.getPlaceDetails(item.place_id);
        } else {
          if (!center) throw new WanderlogValidationError("trip has no location anchor");
          const outcome = await resolvePlaceQuery(ctx, item.place!, center, entry.geos);
          if (outcome.kind === "none") throw new WanderlogValidationError("no match");
          if (outcome.kind === "ambiguous") {
            const names = outcome.candidates.slice(0, 3).map((c) => suggestionName(c.suggestion));
            throw new WanderlogValidationError(`ambiguous (${names.join(" / ")})`);
          }
          detail = outcome.detail;
        }
        resolved.push({ item, detail, imageKeys: await ctx.rest.getPlacePhotos(detail) });
      } catch (err) {
        skipped.push(`${label}: ${err instanceof WanderlogError ? err.message : "lookup failed"}`);
      }
    }
    if (resolved.length === 0) {
      throw new WanderlogValidationError(
        `None of the places could be added:\n  ${skipped.join("\n  ")}`,
      );
    }

    const outcome = await submitOp(ctx, args.trip_key, async (locked, submit) => {
      const trip = locked.snapshot;
      const target = findBlockTargetSection(trip, args, "place");
      const start = resolveInsertionPoint(trip, target.index, args);
      const ops: Json0Op[] = [];
      const added: string[] = [];
      let index = start.index;
      const inBatch = new Set<string>();
      for (const { item, detail, imageKeys } of resolved) {
        const key = `${detail.place_id ?? detail.name}@${item.start_time ?? ""}`;
        if (findDuplicatePlace(target.section, detail, item.start_time) || inBatch.has(key)) {
          skipped.push(`${detail.name}: already in ${target.label}`);
          continue;
        }
        inBatch.add(key);
        const path = ["itinerary", "sections", target.index, "blocks", index];
        ops.push({ p: path, li: buildPlaceBlock(detail, userId) });
        if (imageKeys.length > 0) ops.push({ p: [...path, "imageKeys"], oi: imageKeys });
        if (item.note) {
          ops.push({
            p: [...path, "text"],
            t: "rich-text",
            o: fillNewBlockTextOps(noteTextToDelta(item.note)),
          });
        }
        if (item.start_time) ops.push({ p: [...path, "startTime"], oi: item.start_time });
        if (item.end_time) ops.push({ p: [...path, "endTime"], oi: item.end_time });
        added.push(detail.name ?? "place");
        index++;
      }
      if (ops.length > 0) await submit(ops);
      return {
        added,
        where: `${target.label}${hasInsertAnchor(args) ? ` from ${start.description}` : ""}`,
        tripTitle: trip.title,
      };
    });

    const lines = [
      outcome.added.length > 0
        ? `Added ${outcome.added.length} place(s) to ${outcome.where} in "${outcome.tripTitle}": ${outcome.added.join(", ")}.`
        : `Nothing added to "${outcome.tripTitle}".`,
    ];
    if (skipped.length > 0) lines.push(`Skipped:\n  ${skipped.join("\n  ")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
