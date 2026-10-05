import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { WanderlogError } from "../../src/errors.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { findDuplicateNote, findDuplicatePlace } from "../../src/tools/duplicate-guard.ts";
import type { Section, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const LOUVRE = {
  name: "Musée du Louvre",
  place_id: "louvre-id",
  geometry: { location: { lat: 48.86, lng: 2.34 } },
};

function makeFakeContext(trip: TripPlan) {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 3656632,
    rest: {
      searchPlacesAutocomplete: async () => [{ place_id: "louvre-id", description: "Louvre" }],
      getPlaceDetails: async () => LOUVRE,
      getPlacePhotos: async () => [],
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, entry };
}

const section = (blocks: unknown[]) => ({ blocks }) as unknown as Section;

describe("findDuplicatePlace", () => {
  const block = (place: object, startTime?: string) => ({ type: "place", place, startTime });

  it("matches by place_id, and by accent/case-insensitive name without one", () => {
    expect(findDuplicatePlace(section([block(LOUVRE)]), LOUVRE)).toEqual({ blockIndex: 0 });
    expect(
      findDuplicatePlace(section([block({ name: "MUSEE DU  LOUVRE" })]), {
        name: "Musée du Louvre",
      }),
    ).toEqual({ blockIndex: 0 });
    expect(findDuplicatePlace(section([block({ ...LOUVRE, place_id: "other" })]), LOUVRE)).toBe(
      undefined,
    );
  });

  it("treats a different start time as a real second visit", () => {
    const s = section([block(LOUVRE, "09:00")]);
    expect(findDuplicatePlace(s, LOUVRE, "09:00")).toEqual({ blockIndex: 0 });
    expect(findDuplicatePlace(s, LOUVRE, "18:00")).toBe(undefined);
    expect(findDuplicatePlace(s, LOUVRE)).toBe(undefined);
  });
});

describe("findDuplicateNote", () => {
  it("matches identical text ignoring surrounding whitespace", () => {
    const s = section([{ type: "note", text: { ops: [{ insert: "Take the metro\n\n" }] } }]);
    expect(findDuplicateNote(s, "  Take the metro ")).toEqual({ blockIndex: 0 });
    expect(findDuplicateNote(s, "Take the bus")).toBe(undefined);
    expect(findDuplicateNote(s, "   ")).toBe(undefined);
  });
});

describe("insert tools skip an identical repeat", () => {
  it("does not add the same note twice to one section", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const args = { trip_key: "T", text: "Keep passport copies here", section: "notes" };

    await addNote(ctx, args);
    const second = await addNote(ctx, args);

    expect(submittedOps).toHaveLength(1);
    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("is already in");
    expect(second.content[0]!.text).toContain("allow_duplicate");

    await addNote(ctx, { ...args, allow_duplicate: true });
    expect(submittedOps).toHaveLength(2);
  });

  it("does not add the same place twice at the same time, but allows a second visit", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const args = { trip_key: "T", place: "Louvre" };

    await addPlace(ctx, args);
    const repeat = await addPlace(ctx, args);
    expect(submittedOps).toHaveLength(1);
    expect(repeat.content[0]!.text).toContain("already in places to visit");

    await addPlace(ctx, { ...args, start_time: "18:00" });
    await addPlace(ctx, { ...args, allow_duplicate: true });
    expect(submittedOps).toHaveLength(3);
  });

  it("writes the place, its note and its times in a single submit", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    await addPlace(ctx, {
      trip_key: "T",
      place: "Louvre",
      note: "Book ahead",
      start_time: "09:00",
      end_time: "11:00",
    });
    expect(submittedOps).toHaveLength(1);
    const keys = submittedOps[0]!.map((op) => op.p.at(-1));
    expect(keys).toEqual([expect.any(Number), "text", "startTime", "endTime"]);
  });
});

describe("ambiguous submit failures", () => {
  it("tell the agent the change may have been saved", async () => {
    const { ctx } = makeFakeContext(checklistTrip);
    (ctx.pool as unknown as { get: () => unknown }).get = () => ({
      isSubscribed: true,
      version: 1,
      async submit() {
        throw new WanderlogError("Submit op timeout", "submit_timeout");
      },
    });
    const result = await addNote(ctx, { trip_key: "T", text: "Will it land?" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("may already have been saved");
    expect(result.content[0]!.text).toContain("wanderlog_get_trip");
  });
});
