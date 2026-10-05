import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { isPlaceBlock, type PlaceBlock } from "../types.js";
import { formatSection } from "./block-refs.js";
import { findDuplicatePlace } from "./duplicate-guard.js";
import { findTargetSection, isSystemSection, submitOp } from "./shared.js";

export const removeDuplicatePlacesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to clean up."),
  day: z
    .string()
    .optional()
    .describe("Only this day ('day 2', '2026-05-04'). Omit for the whole trip."),
  apply: z
    .boolean()
    .optional()
    .describe("false (default) only lists the duplicates; true removes them."),
};

export const removeDuplicatePlacesDescription = `
Finds places that appear more than once in the same day or list at the same start time — the
typical leftover of a retried add — and, with apply: true, removes the extra copies, keeping
the first (idea from timoranjes' remove_duplicate_places). The same place at different times,
or on different days, is a real second visit and is left alone. Run without apply first and
show the user what would go.
`.trim();

type Args = { trip_key: string; day?: string; apply?: boolean };

export async function removeDuplicatePlaces(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const scope =
        args.day !== undefined
          ? [findTargetSection(trip, args.day).index]
          : trip.itinerary.sections.map((_s, i) => i);
      const extras: Array<{ sectionIndex: number; blockIndex: number; block: PlaceBlock }> = [];
      for (const sectionIndex of scope) {
        const section = trip.itinerary.sections[sectionIndex]!;
        if (isSystemSection(section)) continue;
        section.blocks.forEach((block, blockIndex) => {
          if (!isPlaceBlock(block)) return;
          const earlier = { ...section, blocks: section.blocks.slice(0, blockIndex) };
          if (findDuplicatePlace(earlier, block.place, block.startTime ?? undefined)) {
            extras.push({ sectionIndex, blockIndex, block });
          }
        });
      }
      const lines = extras.map(
        (e) =>
          `${e.block.place.name}${e.block.startTime ? ` at ${e.block.startTime}` : ""} — ${formatSection(trip.itinerary.sections[e.sectionIndex]!)} (item ${e.blockIndex + 1})`,
      );
      if (args.apply && extras.length > 0) {
        const ops: Json0Op[] = [...extras]
          .sort((a, b) => b.sectionIndex - a.sectionIndex || b.blockIndex - a.blockIndex)
          .map((e) => ({
            p: ["itinerary", "sections", e.sectionIndex, "blocks", e.blockIndex],
            ld: e.block,
          }));
        await submit(ops);
      }
      return { lines, tripTitle: trip.title };
    });
    if (result.lines.length === 0) {
      return { content: [{ type: "text", text: `No duplicate places in "${result.tripTitle}".` }] };
    }
    const head = args.apply
      ? `Removed ${result.lines.length} duplicate place(s) from "${result.tripTitle}" (kept the first of each):`
      : `${result.lines.length} duplicate place(s) in "${result.tripTitle}" — call again with apply: true to remove them (the first of each is kept):`;
    return { content: [{ type: "text", text: `${head}\n  ${result.lines.join("\n  ")}` }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
