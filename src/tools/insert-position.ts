import { z } from "zod";
import { WanderlogValidationError } from "../errors.js";
import type { TripPlan } from "../types.js";
import { UNORDERED_SECTION_TYPES } from "../formatters/trip-summary.js";
import { blockName, formatSection, resolveUniqueBlockInSection } from "./block-refs.js";

/**
 * Where in the target day/section a new block goes. At most one is given;
 * none appends at the end (the historical behaviour). Positions use the same
 * numbering wanderlog_get_trip prints for days and lists, which counts every
 * block (notes and checklists included), so "between items 3 and 4" is
 * position 4.
 */
export type InsertAnchor = { position?: number; before?: string; after?: string };

export const insertAnchorSchema = {
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Optional 1-based position for the new item within the target day or list, using the numbers wanderlog_get_trip shows (notes and checklists count). The item becomes number N and everything from N on shifts down; to go between items 3 and 4, use 4. Omit position/before/after to append at the end.",
    ),
  before: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional: insert immediately before this place in the same day/list (natural reference, e.g. 'Louvre', '2nd café').",
    ),
  after: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional: insert immediately after this place in the same day/list (natural reference).",
    ),
};

export function validateInsertAnchor(anchor: InsertAnchor): void {
  const given = [anchor.position, anchor.before, anchor.after].filter((v) => v !== undefined);
  if (given.length > 1) {
    throw new WanderlogValidationError("Provide at most one of position, before, or after.");
  }
}

export function hasInsertAnchor(anchor: InsertAnchor): boolean {
  return anchor.position !== undefined || anchor.before !== undefined || anchor.after !== undefined;
}

export type InsertionPoint = {
  /** Raw index in section.blocks where the new block is inserted. */
  index: number;
  /** Human description for the confirmation, e.g. "at position 4 (after Louvre)". */
  description: string;
};

export function resolveInsertionPoint(
  trip: TripPlan,
  sectionIndex: number,
  anchor: InsertAnchor,
): InsertionPoint {
  validateInsertAnchor(anchor);
  const section = trip.itinerary.sections[sectionIndex]!;
  const count = section.blocks.length;
  if (hasInsertAnchor(anchor) && UNORDERED_SECTION_TYPES.has(section.type)) {
    throw new WanderlogValidationError(
      `${formatSection(section)} is kept in date order by Wanderlog, so position/before/after do not apply there.`,
    );
  }

  if (anchor.position !== undefined) {
    if (anchor.position > count + 1) {
      throw new WanderlogValidationError(
        `Position ${anchor.position} is outside ${formatSection(section)}, which has ${count} item${count === 1 ? "" : "s"}.`,
        `Use a position from 1 to ${count + 1} (${count + 1} appends at the end), or before/after with a place in that day/list.`,
      );
    }
    return { index: anchor.position - 1, description: `at position ${anchor.position}` };
  }

  const relation =
    anchor.before !== undefined ? "before" : anchor.after !== undefined ? "after" : null;
  if (!relation) return { index: count, description: `at the end (position ${count + 1})` };

  const target = resolveUniqueBlockInSection(
    trip,
    sectionIndex,
    (anchor.before ?? anchor.after)!,
    `${relation} target`,
  );
  const index = relation === "before" ? target.blockIndex : target.blockIndex + 1;
  return {
    index,
    description: `at position ${index + 1} (${relation} ${blockName(target.block)})`,
  };
}
