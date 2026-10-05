import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { formatTrip } from "../../src/formatters/trip-summary.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { deleteSection } from "../../src/tools/delete-section.ts";
import { moveBlock } from "../../src/tools/move-block.ts";
import { reorderSections } from "../../src/tools/reorder-sections.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";

function makeFakeContext(trip: TripPlan = checklistTrip) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const submitted: Json0Op[][] = [];
  const ctx = {
    userId: 1,
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
  return { ctx, entry, submitted };
}

describe("move_block to another day or list", () => {
  it("moves a place to another day, intact, in one submit", async () => {
    const { ctx, entry, submitted } = makeFakeContext();
    const before = structuredClone(entry.snapshot.itinerary.sections[2]!.blocks[0]!);

    const result = await moveBlock(ctx, {
      trip_key: "T",
      block: "Park Güell",
      to_day: "2026-06-02",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("from day 2026-06-01 (position 1) to day 2026-06-02");
    expect(submitted).toHaveLength(1);
    expect(entry.snapshot.itinerary.sections[2]!.blocks.some((b) => b.id === before.id)).toBe(
      false,
    );
    expect(entry.snapshot.itinerary.sections[3]!.blocks).toEqual([before]);
  });

  it("honours position inside the destination", async () => {
    const { ctx, entry } = makeFakeContext();
    await moveBlock(ctx, {
      trip_key: "T",
      block: "Sagrada Familia",
      to_day: "2026-06-01",
      position: 2,
    });
    const lines = formatTrip(entry.snapshot, "concise", entry.snapshot.itinerary.sections[2]).split(
      "\n",
    );
    expect(lines[2]).toMatch(/^2\. La Sagrada Familia/);
  });

  it("moves a place from a day into Places to visit", async () => {
    const { ctx, entry } = makeFakeContext();
    await moveBlock(ctx, {
      trip_key: "T",
      block: "Park Güell",
      to_section: "Places to visit",
      position: 1,
    });
    expect(
      (entry.snapshot.itinerary.sections[1]!.blocks[0] as { place: { name: string } }).place.name,
    ).toBe("Park Güell");
  });

  it("keeps reservations in their own sections", async () => {
    const { ctx, submitted } = makeFakeContext(mixedBlocksTrip);
    const result = await moveBlock(ctx, {
      trip_key: "T",
      block: "the hotel",
      to_day: "2025-11-14",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("stays in its own section");
    expect(submitted).toHaveLength(0);
  });

  it("refuses the notes area and points same-section moves at the plain form", async () => {
    const { ctx } = makeFakeContext();
    const notes = await moveBlock(ctx, { trip_key: "T", block: "Park Güell", to_section: "notes" });
    expect(notes.content[0]!.text).toContain("free-text notes area");
    const same = await moveBlock(ctx, { trip_key: "T", block: "Park Güell", to_day: "2026-06-01" });
    expect(same.content[0]!.text).toContain("already in day 2026-06-01");
  });

  it("still requires exactly one anchor for a move within the section", async () => {
    const { ctx } = makeFakeContext();
    const result = await moveBlock(ctx, { trip_key: "T", block: "Park Güell" });
    expect(result.isError).toBe(true);
  });
});

describe("reorder_sections", () => {
  it("moves a custom list among custom lists only", async () => {
    const trip = structuredClone(checklistTrip);
    const list = (id: number, heading: string) =>
      ({ id, type: "normal", mode: "placeList", heading, date: null, blocks: [] }) as never;
    trip.itinerary.sections.push(list(901, "Food"), list(902, "Bars"), list(903, "Shops"));
    const { ctx, entry } = makeFakeContext(trip);

    const result = await reorderSections(ctx, { trip_key: "T", section: "Shops", position: 1 });

    expect(result.isError).toBeUndefined();
    const custom = entry.snapshot.itinerary.sections.filter((s) => [901, 902, 903].includes(s.id));
    expect(custom.map((s) => s.heading)).toEqual(["Shops", "Food", "Bars"]);
    expect(entry.snapshot.itinerary.sections.slice(0, 6).map((s) => s.id)).toEqual(
      checklistTrip.itinerary.sections.map((s) => s.id),
    );
  });
});

describe("delete_section and the notes area", () => {
  it("refuses to delete the trip's notes area", async () => {
    const { ctx, submitted } = makeFakeContext();
    const result = await deleteSection(ctx, { trip_key: "T", section: "Notes" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cannot be deleted");
    expect(submitted).toHaveLength(0);
  });
});
