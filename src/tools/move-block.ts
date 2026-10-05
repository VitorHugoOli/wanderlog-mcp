import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { blockName, formatSection, resolveUniqueBlock } from "./block-refs.js";
import { resolveInsertionPoint } from "./insert-position.js";
import {
  findBlockById,
  findBlockTargetSection,
  findTargetSection,
  isSystemSection,
  submitOp,
} from "./shared.js";

export const moveBlockInputSchema = z
  .object({
    trip_key: z.string().min(1).describe("The trip containing the block."),
    block: z
      .string()
      .min(1)
      .describe(
        "Natural-language reference to the place or reservation block to move. Uses the same names, role keywords, day filters, and ordinal prefixes as wanderlog_remove_place.",
      ),
    position: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Move to this 1-based position in the section — the numbers wanderlog_get_trip shows for each day/list, which count notes and checklists.",
      ),
    before: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move immediately before this naturally referenced place or reservation block in the same section. Notes and checklists are not valid targets.",
      ),
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move immediately after this naturally referenced place or reservation block in the same section. Notes and checklists are not valid targets.",
      ),
    to_day: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move the place to another day ('day 3', 'May 4', '2026-05-04'). Combine with position/before/after to place it within that day; omit them to append. Only places move across sections.",
      ),
    to_section: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Move the place to an undated list such as 'Places to visit' or a custom list (by heading). Combine with position/before/after, or omit them to append.",
      ),
  })
  .refine(
    (args) => {
      const anchors = [args.position, args.before, args.after].filter((v) => v !== undefined);
      if (args.to_day !== undefined && args.to_section !== undefined) return false;
      return args.to_day !== undefined || args.to_section !== undefined
        ? anchors.length <= 1
        : anchors.length === 1;
    },
    {
      message:
        "Provide exactly one of position, before or after — or a to_day/to_section destination (not both) with at most one of them.",
    },
  );

export const moveBlockDescription = `
Moves an existing place or reservation block to another position within its current Wanderlog
section without deleting or recreating it. The original block ID, notes, images, times, booking
details, and other metadata are preserved.

Select the block using the same natural-language references as wanderlog_remove_place, including
day filters and ordinal prefixes. Choose exactly one destination:
  - position: a 1-based position in the section's complete displayed block order
  - before: another place or reservation block in the same section
  - after: another place or reservation block in the same section

Positions count all displayed blocks, including notes and checklists — but notes and checklists
cannot be used as before/after targets, which resolve only to place or reservation blocks.

To move a place to another day or list, pass to_day or to_section (optionally with position,
before or after inside the destination). The block keeps its ID, note, times and photos. Never
emulate a move by removing and re-adding the place, which discards all of that. Reservations
(hotels, flights, transit, rental cars) stay in their own sections. If a reference is ambiguous,
nothing is changed and the tool returns candidates for a more specific retry.
`.trim();

type Args = z.infer<typeof moveBlockInputSchema>;

type MoveOutcome = {
  moved: boolean;
  blockName: string;
  sectionLabel: string;
  tripTitle: string;
  fromPosition: number;
  toPosition: number;
};

export async function moveBlock(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    // The MCP SDK unwraps refined Zod objects before protocol validation.
    const parsed = moveBlockInputSchema.safeParse(args);
    if (!parsed.success) {
      throw new WanderlogValidationError(
        parsed.error.issues[0]?.message ?? "Invalid move destination.",
      );
    }

    const data = parsed.data;
    if (data.to_day !== undefined || data.to_section !== undefined) {
      return await moveAcrossSections(ctx, data);
    }
    const outcome = await submitOp(ctx, parsed.data.trip_key, async (entry, submit) => {
      const prepared = buildMove(entry.snapshot, parsed.data);
      if (prepared.ops.length === 0) {
        return prepared.afterApply(entry.snapshot);
      }

      await submit(prepared.ops);
      try {
        return prepared.afterApply(entry.snapshot);
      } catch (err) {
        ctx.tripCache.invalidate(parsed.data.trip_key);
        throw err;
      }
    });

    const text = outcome.moved
      ? `Moved ${outcome.blockName} from position ${outcome.fromPosition} to position ${outcome.toPosition} in ${outcome.sectionLabel} of "${outcome.tripTitle}".`
      : `${outcome.blockName} is already at position ${outcome.toPosition} in ${outcome.sectionLabel} of "${outcome.tripTitle}". No changes made.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

function buildMove(
  trip: TripPlan,
  args: Args,
): {
  ops: Json0Op[];
  afterApply: (snapshot: TripPlan) => MoveOutcome;
} {
  const source = resolveUniqueBlock(trip, args.block, "block");
  const sourceIndex = source.blockIndex;
  let destinationIndex: number;

  if (args.position !== undefined) {
    if (args.position > source.section.blocks.length) {
      throw new WanderlogValidationError(
        `Position ${args.position} is outside ${formatSection(source.section)}, which has ${source.section.blocks.length} blocks.`,
        `Use a position from 1 to ${source.section.blocks.length}, or use before/after with another block in the section.`,
      );
    }
    destinationIndex = args.position - 1;
  } else {
    const relation = args.before !== undefined ? "before" : "after";
    const targetRef = args.before ?? args.after!;
    const target = resolveUniqueBlock(trip, targetRef, `${relation} target`);

    if (target.sectionIndex !== source.sectionIndex) {
      throw new WanderlogValidationError(
        `Cannot move ${blockName(source.block)} ${relation} ${blockName(target.block)} because they are in different sections.`,
        "Cross-section moves are not supported. Choose a target in the same day or section.",
      );
    }
    if (target.block.id === source.block.id) {
      throw new WanderlogValidationError(
        `Cannot move ${blockName(source.block)} ${relation} itself.`,
      );
    }

    const targetIndex = target.blockIndex;
    if (relation === "before") {
      destinationIndex = targetIndex < sourceIndex ? targetIndex : targetIndex - 1;
    } else {
      destinationIndex = targetIndex < sourceIndex ? targetIndex + 1 : targetIndex;
    }
  }

  const originalBlock = structuredClone(source.block);
  const outcome: MoveOutcome = {
    moved: destinationIndex !== sourceIndex,
    blockName: blockName(source.block),
    sectionLabel: formatSection(source.section),
    tripTitle: trip.title,
    fromPosition: sourceIndex + 1,
    toPosition: destinationIndex + 1,
  };
  const ops: Json0Op[] =
    destinationIndex === sourceIndex
      ? []
      : [
          {
            p: ["itinerary", "sections", source.sectionIndex, "blocks", sourceIndex],
            lm: destinationIndex,
          },
        ];

  return {
    ops,
    afterApply: (snapshot) => {
      const section = snapshot.itinerary.sections.find(
        (candidate) => candidate.id === source.section.id,
      );
      const movedBlock = section?.blocks[destinationIndex];
      if (
        !movedBlock ||
        movedBlock.id !== originalBlock.id ||
        !isDeepStrictEqual(movedBlock, originalBlock)
      ) {
        throw new WanderlogError(
          `The move was accepted but could not be verified. It may have been applied; refresh "${trip.title}" before retrying.`,
          "move_verification_failed",
          "Use wanderlog_get_trip to inspect the current itinerary order before making another move.",
        );
      }
      return outcome;
    },
  };
}

async function moveAcrossSections(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
    const trip = entry.snapshot;
    const source = resolveUniqueBlock(trip, args.block, "block");
    if (!isPlaceBlock(source.block) || isSystemSection(source.section)) {
      throw new WanderlogValidationError(
        `${blockName(source.block)} is a reservation and stays in its own section; only places move between days and lists.`,
      );
    }
    const destination =
      args.to_day !== undefined
        ? findTargetSection(trip, args.to_day)
        : findBlockTargetSection(trip, { section: args.to_section }, "place");
    if (isSystemSection(destination.section)) {
      throw new WanderlogValidationError(
        `${formatSection(destination.section)} holds reservations; move places to a day or a list.`,
      );
    }
    if (destination.index === source.sectionIndex) {
      throw new WanderlogValidationError(
        `${blockName(source.block)} is already in ${formatSection(source.section)}.`,
        "To reorder within the same day or list, call again without to_day/to_section.",
      );
    }

    const point = resolveInsertionPoint(trip, destination.index, args);
    const block = structuredClone(source.block);
    // Two sections, two arrays: removing from the source does not shift the
    // destination index, and one submit makes the move all-or-nothing.
    await submit([
      {
        p: ["itinerary", "sections", source.sectionIndex, "blocks", source.blockIndex],
        ld: source.block,
      },
      { p: ["itinerary", "sections", destination.index, "blocks", point.index], li: block },
    ]);

    const moved = findBlockById(entry.snapshot, block.id as number);
    const landed = moved && entry.snapshot.itinerary.sections[moved.sectionIndex]?.id;
    if (!moved || landed !== destination.section.id || !isDeepStrictEqual(moved.block, block)) {
      throw new WanderlogError(
        `The move was sent but could not be verified. Check "${trip.title}" with wanderlog_get_trip before retrying.`,
        "move_verification_failed",
      );
    }
    return {
      name: blockName(block),
      from: `${formatSection(source.section)} (position ${source.blockIndex + 1})`,
      to: `${formatSection(destination.section)} ${point.description}`,
      tripTitle: trip.title,
    };
  });
  return {
    content: [
      {
        type: "text",
        text: `Moved ${result.name} from ${result.from} to ${result.to} in "${result.tripTitle}", keeping its note, times and photos.`,
      },
    ],
  };
}
