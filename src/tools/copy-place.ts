import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import { isPlaceBlock } from "../types.js";
import { blockName, formatSection, resolveUniqueBlock } from "./block-refs.js";
import { insertAnchorSchema, resolveInsertionPoint, type InsertAnchor } from "./insert-position.js";
import {
  findBlockTargetSection,
  findTargetSection,
  generateBlockId,
  isSystemSection,
  submitOp,
} from "./shared.js";

export const copyPlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip."),
  place: z
    .string()
    .min(1)
    .describe(
      "The place to copy (same references as wanderlog_remove_place, e.g. 'Louvre on day 2').",
    ),
  to_day: z.string().min(1).optional().describe("Day to copy it to."),
  to_section: z.string().min(1).optional().describe("Or an undated list to copy it to."),
  keep_times: z
    .boolean()
    .optional()
    .describe("Also copy its start/end times (default false: a second visit usually has its own)."),
  ...insertAnchorSchema,
};

export const copyPlaceDescription = `
Copies a place already in the trip to another day or list (a second visit, or adding a saved
place to a day), keeping its note and photos; idea from timmy0519's copy_place. The original
stays where it is. Use wanderlog_move_block instead to move it.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  to_day?: string;
  to_section?: string;
  keep_times?: boolean;
} & InsertAnchor;

export async function copyPlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if ((args.to_day === undefined) === (args.to_section === undefined)) {
      throw new WanderlogValidationError("Give exactly one of to_day or to_section.");
    }
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const source = resolveUniqueBlock(trip, args.place, "place");
      if (!isPlaceBlock(source.block) || isSystemSection(source.section)) {
        throw new WanderlogValidationError(
          `${blockName(source.block)} is a reservation; only places can be copied.`,
        );
      }
      const target =
        args.to_day !== undefined
          ? findTargetSection(trip, args.to_day)
          : findBlockTargetSection(trip, { section: args.to_section }, "place");
      if (isSystemSection(target.section)) {
        throw new WanderlogValidationError(`${formatSection(target.section)} holds reservations.`);
      }
      const point = resolveInsertionPoint(trip, target.index, args);
      const copy: Record<string, unknown> = {
        ...structuredClone(source.block),
        id: generateBlockId(),
      };
      if (!args.keep_times) {
        delete copy.startTime;
        delete copy.endTime;
      }
      await submit([
        { p: ["itinerary", "sections", target.index, "blocks", point.index], li: copy },
      ]);
      return {
        name: blockName(source.block),
        to: `${formatSection(target.section)} ${point.description}`,
        tripTitle: trip.title,
      };
    });
    return {
      content: [
        { type: "text", text: `Copied ${result.name} to ${result.to} in "${result.tripTitle}".` },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
