import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { annotatePlace } from "../../src/tools/annotate-place.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import type { QuillDelta, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const DAY = "2026-06-01";
const DAY_INDEX = 2;

function makeFakeContext(trip: TripPlan = checklistTrip) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const submitted: Json0Op[][] = [];
  const ctx = {
    userId: 1,
    rest: {
      searchPlacesAutocomplete: async () => [{ place_id: "p", description: "Louvre" }],
      getPlaceDetails: async () => ({ name: "Louvre", place_id: "p" }),
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
  const day = () => entry.snapshot.itinerary.sections[DAY_INDEX]!.blocks;
  return { ctx, entry, submitted, day };
}

describe("markdown in note-writing tools", () => {
  it("add_note renders bold and links, with exactly one trailing newline", async () => {
    const { ctx, day } = makeFakeContext();
    await addNote(ctx, {
      trip_key: "T",
      text: "Take **tram 28** — see [map](https://example.com)",
      day: DAY,
    });
    const text = (day().at(-1) as { text: QuillDelta }).text;
    expect(text.ops).toEqual([
      { insert: "Take " },
      { insert: "tram 28", attributes: { bold: true } },
      { insert: " — see " },
      { insert: "map", attributes: { link: "https://example.com" } },
      { insert: "\n" },
    ]);
  });

  it("format: plain keeps markers verbatim", async () => {
    const { ctx, day } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "2 * 3 = **6**", day: DAY, format: "plain" });
    expect((day().at(-1) as { text: QuillDelta }).text.ops).toEqual([
      { insert: "2 * 3 = **6**\n" },
    ]);
  });

  it("bullet lists put the list attribute on each line's newline", async () => {
    const { ctx, day } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "- Ramen\n- Gyoza", day: DAY });
    expect((day().at(-1) as { text: QuillDelta }).text.ops).toEqual([
      { insert: "Ramen" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "Gyoza" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
  });

  it("add_place writes a markdown note on the place itself", async () => {
    const { ctx, day } = makeFakeContext();
    await addPlace(ctx, { trip_key: "T", place: "Louvre", day: DAY, note: "*Book* ahead" });
    expect((day().at(-1) as { text: QuillDelta }).text.ops).toEqual([
      { insert: "Book", attributes: { italic: true } },
      { insert: " ahead\n" },
    ]);
  });

  it("annotate_place replaces the whole note, formatting included", async () => {
    const trip = structuredClone(checklistTrip);
    (trip.itinerary.sections[DAY_INDEX]!.blocks[0] as { text: QuillDelta }).text = {
      ops: [{ insert: "Old", attributes: { bold: true } }, { insert: "\n" }],
    };
    const { ctx, day } = makeFakeContext(trip);
    const result = await annotatePlace(ctx, {
      trip_key: "T",
      place: "Park Güell",
      note: "**New**",
    });
    expect(result.isError).toBeUndefined();
    expect((day()[0] as { text: QuillDelta }).text.ops).toEqual([
      { insert: "New", attributes: { bold: true } },
      { insert: "\n" },
    ]);
  });

  it("edit_note keeps the formatting of the text it replaces", async () => {
    const { ctx, day } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "Meet at **gate 3** at noon", day: DAY });
    await editNote(ctx, { trip_key: "T", old_text: "gate 3", new_text: "gate 5" });
    expect((day().at(-1) as { text: QuillDelta }).text.ops).toEqual([
      { insert: "Meet at " },
      { insert: "gate 5", attributes: { bold: true } },
      { insert: " at noon\n" },
    ]);
  });
});

describe("markdown edge cases (Phase 3 review)", () => {
  it("does not turn '>30 min' into a quote", async () => {
    const { ctx, day } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: ">30 min walk", day: DAY });
    expect((day().at(-1) as { text: QuillDelta }).text.ops).toEqual([{ insert: ">30 min walk\n" }]);
  });
});
