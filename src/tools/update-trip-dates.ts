import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { Section, TripPlan } from "../types.js";
import { generateBlockId, submitOp, isValidDate, validateDateRange } from "./shared.js";

export const updateTripDatesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to update."),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("New first day of the trip, YYYY-MM-DD."),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("New last day of the trip, YYYY-MM-DD. Must be >= start_date."),
  force: z
    .boolean()
    .default(false)
    .describe(
      "If true, allows the update even when it would delete days that currently contain places. DEFAULT false — the tool refuses destructive removes with a helpful error listing what would be lost, so the user can move content first.",
    ),
};

export const updateTripDatesDescription = `
Changes the date range of an existing Wanderlog trip. Preserves content on days that remain
in the new range (they're kept in place with their blocks intact), adds empty day sections for
newly-included days, and removes day sections for days no longer in range.

SAFETY: If the new range would delete days that currently contain places or notes, the tool
refuses by default and returns a list of the content that would be lost. Pass force: true to
override, or move the content to other days first.

Does not affect the Hotels, Flights, Transit, or Places-to-visit sections — only the
per-day sections are added/removed.

Repair: if a date has more than one day section (left by an interrupted edit), they are merged
into one, keeping every item. Calling with the trip's current dates performs only this repair.
`.trim();

type Args = {
  trip_key: string;
  start_date: string;
  end_date: string;
  force?: boolean;
};

/**
 * Expands an inclusive date range [start, end] into an array of ISO dates.
 * Uses UTC to avoid DST / timezone surprises.
 */
export function enumerateDates(start: string, end: string): string[] {
  const startMs = Date.UTC(
    Number.parseInt(start.slice(0, 4), 10),
    Number.parseInt(start.slice(5, 7), 10) - 1,
    Number.parseInt(start.slice(8, 10), 10),
  );
  const endMs = Date.UTC(
    Number.parseInt(end.slice(0, 4), 10),
    Number.parseInt(end.slice(5, 7), 10) - 1,
    Number.parseInt(end.slice(8, 10), 10),
  );
  if (endMs < startMs) return [];

  const dates: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = startMs; t <= endMs; t += dayMs) {
    const d = new Date(t);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

/** Builds an empty dayPlan section matching Wanderlog's real shape. */
export function buildEmptyDaySection(date: string): Section {
  return {
    id: generateBlockId(),
    type: "normal",
    mode: "dayPlan",
    heading: "",
    // Server-side validation requires text on sections — an li without it gets
    // silently dropped (no ack, submit times out).
    text: { ops: [{ insert: "\n" }] },
    date,
    blocks: [],
    placeMarkerColor: "#3498db",
    placeMarkerIcon: "map-marker",
  } as Section;
}

/**
 * Finds the array index at which a new dayPlan section with `newDate`
 * should be inserted to keep the day sections in ascending date order.
 * Returns `sections.length` if it belongs at the end.
 */
export function findDayInsertIndex(sections: readonly Section[], newDate: string): number {
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.mode === "dayPlan" && s.date && s.date > newDate) {
      return i;
    }
  }
  return sections.length;
}

export type DuplicateRepair = { date: string; removedSections: number; movedBlocks: number };

/**
 * Ops that collapse duplicate day sections (two dayPlan sections with the same
 * date, left behind by an interrupted or corrupted edit — upstream issue #58).
 * Nothing is lost: the duplicates' blocks are appended to the surviving
 * section (the one with the most blocks) before the duplicates are deleted, so
 * no confirmation is needed. A heading only a duplicate has is carried over.
 */
export function buildDuplicateDayRepairOps(trip: TripPlan): {
  ops: Json0Op[];
  repairs: DuplicateRepair[];
} {
  const byDate = new Map<string, number[]>();
  trip.itinerary.sections.forEach((section, index) => {
    if (section.mode === "dayPlan" && section.date) {
      byDate.set(section.date, [...(byDate.get(section.date) ?? []), index]);
    }
  });

  const appendOps: Json0Op[] = [];
  const headingOps: Json0Op[] = [];
  const removals: Array<{ index: number; section: Section }> = [];
  const repairs: DuplicateRepair[] = [];
  for (const [date, indices] of byDate) {
    if (indices.length < 2) continue;
    const sections = trip.itinerary.sections;
    const survivorIndex = indices.reduce((best, i) =>
      sections[i]!.blocks.length > sections[best]!.blocks.length ? i : best,
    );
    const survivor = sections[survivorIndex]!;
    const seenIds = new Set(survivor.blocks.map((b) => b.id as number));
    let appendAt = survivor.blocks.length;
    let moved = 0;
    let headingCarried = Boolean(survivor.heading?.trim());
    for (const i of indices) {
      if (i === survivorIndex) continue;
      const duplicate = sections[i]!;
      for (const block of duplicate.blocks) {
        // A cloned day carries the same blocks (same ids): appending them again
        // would leave two blocks sharing an id, which breaks id-based lookups.
        const sameId = survivor.blocks.find((b) => b.id === block.id);
        if (sameId && isDeepStrictEqual(sameId, block)) continue;
        if (seenIds.has(block.id as number) && !sameId) continue;
        const copy = structuredClone(block);
        if (sameId || seenIds.has(copy.id as number)) copy.id = generateBlockId();
        seenIds.add(copy.id as number);
        appendOps.push({
          p: ["itinerary", "sections", survivorIndex, "blocks", appendAt++],
          li: copy,
        });
        moved++;
      }
      if (!headingCarried && duplicate.heading?.trim()) {
        headingCarried = true;
        headingOps.push({
          p: ["itinerary", "sections", survivorIndex, "heading"],
          od: survivor.heading,
          oi: duplicate.heading,
        });
      }
      removals.push({ index: i, section: duplicate });
    }
    repairs.push({ date, removedSections: indices.length - 1, movedBlocks: moved });
  }
  // Appends and heading edits first (indices still valid), then deletions from
  // the highest index down so each ld leaves the next one's index intact.
  const deleteOps: Json0Op[] = removals
    .sort((a, b) => b.index - a.index)
    .map(({ index, section }) => ({ p: ["itinerary", "sections", index], ld: section }));
  return { ops: [...appendOps, ...headingOps, ...deleteOps], repairs };
}

export type DayDiff = {
  toAdd: string[];
  toRemove: Array<{ date: string; index: number; section: Section }>;
};

export function diffDays(trip: TripPlan, newStart: string, newEnd: string): DayDiff {
  const targetDates = new Set(enumerateDates(newStart, newEnd));
  const currentByDate = new Map<string, { index: number; section: Section }>();

  trip.itinerary.sections.forEach((section, index) => {
    if (section.mode === "dayPlan" && section.date) {
      currentByDate.set(section.date, { index, section });
    }
  });

  const toRemove: DayDiff["toRemove"] = [];
  for (const [date, { index, section }] of currentByDate) {
    if (!targetDates.has(date)) {
      toRemove.push({ date, index, section });
    }
  }

  const toAdd: string[] = [];
  for (const date of targetDates) {
    if (!currentByDate.has(date)) toAdd.push(date);
  }
  toAdd.sort();

  return { toAdd, toRemove };
}

/**
 * Pure op-builder. Given a trip and new dates, produces the JSON0 ops required
 * to bring the trip into the new state, without touching the network.
 *
 * Throws WanderlogValidationError with a helpful list if destructive removes
 * would drop non-empty day sections and `force` is false.
 */
export function buildUpdateDatesOps(
  trip: TripPlan,
  newStartDate: string,
  newEndDate: string,
  force: boolean,
): Json0Op[] {
  if (newEndDate < newStartDate) {
    throw new WanderlogValidationError(
      `end_date (${newEndDate}) is before start_date (${newStartDate})`,
    );
  }

  const diff = diffDays(trip, newStartDate, newEndDate);

  // Safety: check for destructive removes
  if (!force) {
    const nonEmpty = diff.toRemove.filter((r) => r.section.blocks && r.section.blocks.length > 0);
    if (nonEmpty.length > 0) {
      const lines = nonEmpty
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((r) => `  ${r.date}: ${r.section.blocks.length} block(s)`)
        .join("\n");
      throw new WanderlogValidationError(
        `Shortening "${trip.title}" (${trip.startDate} → ${trip.endDate}) to ${newStartDate} → ${newEndDate} would delete content from ${nonEmpty.length} day(s):\n${lines}`,
        {
          hint: "Pass force: true to delete anyway, or move the content to other days first.",
          followUps: [
            "Retry wanderlog_update_trip_dates with force: true if the user confirms the deletions are OK.",
            "Or call wanderlog_remove_place to clear the affected days before shortening.",
          ],
        },
      );
    }
  }

  const ops: Json0Op[] = [];

  // 1. Deletions in reverse index order so each ld doesn't invalidate the next
  const removesByDesc = [...diff.toRemove].sort((a, b) => b.index - a.index);
  for (const r of removesByDesc) {
    ops.push({
      p: ["itinerary", "sections", r.index],
      ld: r.section,
    });
  }

  // 2. Insertions — compute positions against the post-deletion state.
  //    Simulate the array locally so multi-insert cases get correct indices.
  const removedSet = new Set(diff.toRemove.map((r) => r.section));
  const simulated: Section[] = trip.itinerary.sections.filter((s) => !removedSet.has(s));

  for (const date of diff.toAdd) {
    const newSection = buildEmptyDaySection(date);
    const insertIndex = findDayInsertIndex(simulated, date);
    ops.push({
      p: ["itinerary", "sections", insertIndex],
      li: newSection,
    });
    simulated.splice(insertIndex, 0, newSection);
  }

  // 3. Top-level field updates — od+oi pairs (what we've observed in ShareDB)
  if (trip.startDate !== newStartDate) {
    ops.push({
      p: ["startDate"],
      od: trip.startDate,
      oi: newStartDate,
    });
  }
  if (trip.endDate !== newEndDate) {
    ops.push({
      p: ["endDate"],
      od: trip.endDate,
      oi: newEndDate,
    });
  }
  const newDays = enumerateDates(newStartDate, newEndDate).length;
  if (trip.days !== newDays) {
    ops.push({
      p: ["days"],
      od: trip.days,
      oi: newDays,
    });
  }

  return ops;
}

export async function updateTripDates(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!isValidDate(args.start_date)) {
      throw new WanderlogValidationError(
        `Invalid start_date: "${args.start_date}". Must be a valid calendar date.`,
      );
    }
    if (!isValidDate(args.end_date)) {
      throw new WanderlogValidationError(
        `Invalid end_date: "${args.end_date}". Must be a valid calendar date.`,
      );
    }
    validateDateRange(args.start_date, args.end_date);
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const repair = buildDuplicateDayRepairOps(entry.snapshot);
      if (repair.ops.length > 0) {
        await submit(repair.ops);
        const dates = entry.snapshot.itinerary.sections
          .filter((section) => section.mode === "dayPlan" && section.date)
          .map((section) => section.date);
        if (new Set(dates).size !== dates.length) {
          throw new WanderlogError("Duplicate day sections are still present", "stale_target");
        }
      }
      const trip = entry.snapshot;
      const ops = buildUpdateDatesOps(trip, args.start_date, args.end_date, args.force ?? false);
      if (ops.length === 0 && repair.repairs.length > 0) {
        return {
          diff: { toAdd: [], toRemove: [] },
          repairs: repair.repairs,
          tripTitle: trip.title,
        };
      }
      if (ops.length === 0) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `"${trip.title}" already has dates ${args.start_date} → ${args.end_date}. No changes made.`,
              },
            ],
          },
        };
      }
      const diff = diffDays(trip, args.start_date, args.end_date);
      const removedSectionIds = new Set(diff.toRemove.map(({ section }) => section.id));
      await submit(ops);
      if (entry.snapshot.itinerary.sections.some((section) => removedSectionIds.has(section.id))) {
        throw new WanderlogError("A removed day section is still present", "stale_target");
      }
      return { diff, repairs: repair.repairs, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;
    const datesChanged = result.diff.toAdd.length > 0 || result.diff.toRemove.length > 0;
    const summary: string[] = [
      datesChanged || result.repairs.length === 0
        ? `Updated "${result.tripTitle}" to ${args.start_date} → ${args.end_date}.`
        : `Repaired duplicate days in "${result.tripTitle}" (dates unchanged).`,
    ];
    if (result.diff.toAdd.length > 0) {
      summary.push(`  Added ${result.diff.toAdd.length} day(s): ${result.diff.toAdd.join(", ")}`);
    }
    for (const r of result.repairs) {
      summary.push(
        `  Repaired ${r.date}: merged ${r.removedSections} duplicate day section(s) into one, keeping all ${r.movedBlocks} of their item(s).`,
      );
    }
    if (result.diff.toRemove.length > 0) {
      summary.push(
        `  Removed ${result.diff.toRemove.length} day(s): ${result.diff.toRemove.map((r) => r.date).join(", ")}`,
      );
    }
    return { content: [{ type: "text", text: summary.join("\n") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
