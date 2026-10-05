import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { formatTrip } from "../../src/formatters/trip-summary.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import { removeNote } from "../../src/tools/remove-note.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const DAY_INDEX = 2;
const note = (id: number, text: string) => ({
  id,
  type: "note",
  text: { ops: [{ insert: `${text}\n` }] },
});

function tripWithNotes(): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections[DAY_INDEX]!.blocks.push(
    note(501, "Take the metro") as never,
    note(502, "Take the metro") as never,
  );
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
  return { ctx, entry, submitted };
}

describe("block ids", () => {
  it("are shown only in detailed get_trip output", () => {
    const trip = tripWithNotes();
    const day = trip.itinerary.sections[DAY_INDEX];
    expect(formatTrip(trip, "detailed", day)).toContain("📝 Take the metro [id 501]");
    expect(formatTrip(trip, "concise", day)).not.toContain("[id ");
  });

  it("let remove_note delete several identical notes at once", async () => {
    const { ctx, entry, submitted } = makeFakeContext(tripWithNotes());
    const ambiguous = await removeNote(ctx, { trip_key: "T", text: "take the metro" });
    expect(ambiguous.isError).toBe(true);

    const result = await removeNote(ctx, { trip_key: "T", note_ids: [501, 502] });
    expect(result.isError).toBeUndefined();
    expect(submitted).toHaveLength(1);
    const ids = entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks.map((b) => b.id);
    expect(ids).not.toContain(501);
    expect(ids).not.toContain(502);
  });

  it("reports unknown ids without removing anything", async () => {
    const { ctx, submitted } = makeFakeContext(tripWithNotes());
    const result = await removeNote(ctx, { trip_key: "T", note_ids: [501, 999] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("id 999");
    expect(submitted).toHaveLength(0);
  });

  it("let edit_note target one of several identical notes", async () => {
    const { ctx, entry } = makeFakeContext(tripWithNotes());
    const result = await editNote(ctx, {
      trip_key: "T",
      old_text: "metro",
      new_text: "tram",
      note_id: 502,
    });
    expect(result.isError).toBeUndefined();
    const texts = entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks.filter(
      (b) => b.id === 501 || b.id === 502,
    ).map((b) => (b as { text: { ops: Array<{ insert: string }> } }).text.ops[0]!.insert);
    expect(texts).toEqual(["Take the metro\n", "Take the tram\n"]);
  });
});
