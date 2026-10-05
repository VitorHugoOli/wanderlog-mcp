import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { formatTrip } from "../../src/formatters/trip-summary.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addPlaces } from "../../src/tools/add-places.ts";
import { copyPlace } from "../../src/tools/copy-place.ts";
import { removeDuplicatePlaces } from "../../src/tools/remove-duplicate-places.ts";
import type { PlaceSuggestion, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const DAY = "2026-06-01";
const DAY_INDEX = 2;
const PLACES: Record<string, { name: string; place_id: string }> = {
  louvre: { name: "Louvre Museum", place_id: "louvre" },
  orsay: { name: "Musée d'Orsay", place_id: "orsay" },
};

function makeFakeContext(trip: TripPlan = checklistTrip) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const submitted: Json0Op[][] = [];
  const ctx = {
    userId: 1,
    rest: {
      searchPlacesAutocomplete: async ({ input }: { input: string }) => {
        const key = input.toLowerCase().includes("orsay")
          ? "orsay"
          : input.toLowerCase().includes("louvre")
            ? "louvre"
            : null;
        if (!key) return [];
        return [
          {
            place_id: key,
            structured_formatting: { main_text: PLACES[key]!.name },
          } as PlaceSuggestion,
        ];
      },
      getPlaceDetails: async (id: string) => PLACES[id]!,
      getPlacePhotos: async () => [],
    },
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
  const lines = (index = DAY_INDEX) =>
    formatTrip(entry.snapshot, "concise", entry.snapshot.itinerary.sections[index])
      .split("\n")
      .slice(1);
  return { ctx, entry, submitted, lines };
}

describe("add_places", () => {
  it("adds several places in order in one submit, skipping what cannot be resolved", async () => {
    const { ctx, submitted, lines } = makeFakeContext();
    const result = await addPlaces(ctx, {
      trip_key: "T",
      day: DAY,
      position: 2,
      places: [
        { place: "Louvre", start_time: "09:00", note: "**Book**" },
        { place: "Nowhere at all" },
        { place: "Orsay" },
        { place: "Louvre", start_time: "09:00" },
      ],
    });
    expect(submitted).toHaveLength(1);
    expect(
      lines()
        .filter((l) => /^\d+\. /.test(l))
        .slice(0, 3),
    ).toEqual([
      "1. Park Güell",
      expect.stringMatching(/^2\. 09:00 Louvre Museum/),
      "3. Musée d'Orsay",
    ]);
    const text = result.content[0]!.text;
    expect(text).toContain("Added 2 place(s)");
    expect(text).toContain("Nowhere at all: no match");
    expect(text).toContain("Louvre Museum: already in");
  });
});

describe("copy_place", () => {
  it("copies a place to another day with a new id, keeping the note but not the times", async () => {
    const trip = structuredClone(checklistTrip);
    Object.assign(trip.itinerary.sections[DAY_INDEX]!.blocks[0]!, { startTime: "10:00" });
    const { ctx, entry } = makeFakeContext(trip);
    const original = entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks[0]!;
    const result = await copyPlace(ctx, {
      trip_key: "T",
      place: "Park Güell",
      to_day: "2026-06-02",
    });
    expect(result.isError).toBeUndefined();
    const copy = entry.snapshot.itinerary.sections[3]!.blocks[0]! as Record<string, unknown>;
    expect(copy.id).not.toBe(original.id);
    expect(copy.place).toEqual((original as Record<string, unknown>).place);
    expect(copy.startTime).toBeUndefined();
    expect(entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks[0]!.id).toBe(original.id);
  });
});

describe("remove_duplicate_places", () => {
  it("lists by default and removes extras (keeping the first) with apply", async () => {
    const trip = structuredClone(checklistTrip);
    const day = trip.itinerary.sections[DAY_INDEX]!;
    const park = day.blocks[0]!;
    day.blocks.push({ ...structuredClone(park), id: 7001 }, {
      ...structuredClone(park),
      id: 7002,
      startTime: "18:00",
    } as never);
    const { ctx, entry, submitted } = makeFakeContext(trip);

    const dry = await removeDuplicatePlaces(ctx, { trip_key: "T" });
    expect(dry.content[0]!.text).toContain("1 duplicate place(s)");
    expect(submitted).toHaveLength(0);

    await removeDuplicatePlaces(ctx, { trip_key: "T", apply: true });
    const ids = entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks.map((b) => b.id);
    expect(ids).toContain(park.id);
    expect(ids).not.toContain(7001);
    expect(ids).toContain(7002);
  });
});
