import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { buildDuplicateDayRepairOps, updateTripDates } from "../../src/tools/update-trip-dates.ts";
import type { Section, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

// checklistTrip: days 2026-06-01 (3 blocks, "Arrival day") .. 2026-06-04.
const day = (id: number, date: string, blocks: unknown[] = [], heading = ""): Section =>
  ({ id, type: "normal", mode: "dayPlan", date, heading, blocks }) as never;
const note = (id: number) => ({ id, type: "note", text: { ops: [{ insert: `n${id}\n` }] } });

function withExtraSections(...extra: Section[]): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections.push(...extra);
  return trip;
}

function makeFakeContext(trip: TripPlan) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const submitted: Json0Op[][] = [];
  const ctx = {
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submitted.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_k: string, ops: Json0Op[], v: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = v;
      },
      refresh: async () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;
  const daysOn = (date: string) =>
    entry.snapshot.itinerary.sections.filter((s) => s.mode === "dayPlan" && s.date === date);
  return { ctx, entry, submitted, daysOn };
}

describe("duplicate day repair (upstream issue #58)", () => {
  it("does nothing on a healthy trip", () => {
    expect(buildDuplicateDayRepairOps(checklistTrip)).toEqual({ ops: [], repairs: [] });
  });

  it("merges an empty duplicate away, keeping the populated day", async () => {
    const { ctx, daysOn } = makeFakeContext(withExtraSections(day(990, "2026-06-01")));
    const result = await updateTripDates(ctx, {
      trip_key: "T",
      start_date: "2026-06-01",
      end_date: "2026-06-04",
    });
    expect(result.content[0]!.text).toContain("Repaired duplicate days");
    expect(daysOn("2026-06-01")).toHaveLength(1);
    expect(daysOn("2026-06-01")[0]!.blocks).toHaveLength(3);
  });

  it("keeps every block when both duplicates have content, in either order", async () => {
    for (const order of ["dup-first", "dup-last"] as const) {
      const trip = structuredClone(checklistTrip);
      const dup = day(991, "2026-06-02", [note(1), note(2)], "Day trip");
      if (order === "dup-first") trip.itinerary.sections.splice(3, 0, dup);
      else trip.itinerary.sections.push(dup);
      trip.itinerary.sections
        .find((s) => s.id !== 991 && s.date === "2026-06-02")!
        .blocks.push(note(3) as never);
      const { ctx, daysOn } = makeFakeContext(trip);
      await updateTripDates(ctx, {
        trip_key: "T",
        start_date: "2026-06-01",
        end_date: "2026-06-04",
      });
      const [only] = daysOn("2026-06-02");
      expect(daysOn("2026-06-02")).toHaveLength(1);
      expect(only!.blocks.map((b) => b.id).sort()).toEqual([1, 2, 3]);
      expect(only!.heading).toBe("Day trip");
    }
  });

  it("repairs duplicates that share a section id", async () => {
    const trip = structuredClone(checklistTrip);
    const original = trip.itinerary.sections[3]!;
    trip.itinerary.sections.push({ ...structuredClone(original), blocks: [note(7) as never] });
    const { ctx, daysOn } = makeFakeContext(trip);
    const result = await updateTripDates(ctx, {
      trip_key: "T",
      start_date: "2026-06-01",
      end_date: "2026-06-04",
    });
    expect(result.isError).toBeUndefined();
    expect(daysOn(original.date!)).toHaveLength(1);
    expect(daysOn(original.date!)[0]!.blocks.map((b) => b.id)).toEqual([7]);
  });

  it("repairs before changing dates in the same call", async () => {
    const { ctx, daysOn } = makeFakeContext(withExtraSections(day(992, "2026-06-03", [note(9)])));
    const result = await updateTripDates(ctx, {
      trip_key: "T",
      start_date: "2026-06-01",
      end_date: "2026-06-05",
    });
    expect(result.content[0]!.text).toContain("Updated");
    expect(result.content[0]!.text).toContain("Repaired 2026-06-03");
    expect(daysOn("2026-06-03")).toHaveLength(1);
    expect(daysOn("2026-06-05")).toHaveLength(1);
  });
});
