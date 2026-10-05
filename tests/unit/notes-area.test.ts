import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import { removeNote } from "../../src/tools/remove-note.ts";
import type { QuillDelta, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

/**
 * Wanderlog's trip-level notes area is a textOnly section whose content is
 * free rich text in section.text (no blocks), with a localized heading.
 */
function tripWithNotes(text: QuillDelta | undefined, heading = "Notas"): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections[0] = { ...trip.itinerary.sections[0]!, heading, text } as never;
  return trip;
}

function makeFakeContext(trip: TripPlan) {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 1,
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
      refresh: async () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;
  const notesText = () =>
    (entry.snapshot.itinerary.sections[0]!.text?.ops ?? [])
      .map((op) => (typeof op.insert === "string" ? op.insert : "￼"))
      .join("");
  return { ctx, submittedOps, notesText };
}

const doc = (text: string): QuillDelta => ({ ops: [{ insert: text }] });

describe("add_note to the notes area", () => {
  it("finds a localized notes area by the 'notes' alias and fills an empty one", async () => {
    const { ctx, notesText } = makeFakeContext(tripWithNotes(doc("\n")));
    const result = await addNote(ctx, { trip_key: "T", text: "Passport copies", section: "notes" });
    expect(result.content[0]!.text).toContain('section "Notas"');
    expect(notesText()).toBe("Passport copies\n");
  });

  it("appends a new paragraph after existing text", async () => {
    const { ctx, notesText } = makeFakeContext(tripWithNotes(doc("First\n")));
    await addNote(ctx, { trip_key: "T", text: "Second", section: "Notas" });
    expect(notesText()).toBe("First\nSecond\n");
  });

  it("does not add the same paragraph twice", async () => {
    const { ctx, submittedOps } = makeFakeContext(tripWithNotes(doc("First\nSecond\n")));
    const result = await addNote(ctx, { trip_key: "T", text: " Second ", section: "notes" });
    expect(submittedOps).toHaveLength(0);
    expect(result.content[0]!.text).toContain("is already in");
  });

  it("rejects position/before/after, which a free-text area cannot honour", async () => {
    const { ctx, submittedOps } = makeFakeContext(tripWithNotes(doc("First\n")));
    const result = await addNote(ctx, { trip_key: "T", text: "x", section: "notes", position: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("free text");
    expect(submittedOps).toHaveLength(0);
  });
});

describe("edit_note / remove_note in the notes area", () => {
  it("edits text inside the notes area", async () => {
    const { ctx, notesText } = makeFakeContext(tripWithNotes(doc("Bring cash\nVisa needed\n")));
    const result = await editNote(ctx, { trip_key: "T", old_text: "cash", new_text: "euros" });
    expect(result.isError).toBeUndefined();
    expect(notesText()).toBe("Bring euros\nVisa needed\n");
  });

  it("removes a whole paragraph", async () => {
    const { ctx, notesText } = makeFakeContext(
      tripWithNotes(doc("Bring cash\nVisa needed\nSIM card\n")),
    );
    await removeNote(ctx, { trip_key: "T", text: "visa" });
    expect(notesText()).toBe("Bring cash\nSIM card\n");
  });

  it("keeps the document's final newline when removing the only paragraph", async () => {
    const { ctx, notesText } = makeFakeContext(tripWithNotes(doc("Only line\n")));
    await removeNote(ctx, { trip_key: "T", text: "only" });
    expect(notesText()).toBe("\n");
  });

  it("counts an embedded image as one character when computing offsets", async () => {
    const withImage: QuillDelta = {
      ops: [{ insert: "A" }, { insert: { image: "x.png" } } as never, { insert: "B target\n" }],
    };
    const { ctx, submittedOps } = makeFakeContext(tripWithNotes(withImage));
    await editNote(ctx, { trip_key: "T", old_text: "target", new_text: "goal" });
    expect(submittedOps[0]![0]).toMatchObject({
      p: ["itinerary", "sections", 0, "text"],
      t: "rich-text",
      o: [{ retain: 4 }, { delete: 6 }, { insert: "goal" }],
    });
  });

  it("asks for a more specific query when a block note and a notes paragraph both match", async () => {
    const trip = tripWithNotes(doc("Don't forget the passport\n"));
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await removeNote(ctx, { trip_key: "T", text: "don't forget" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("matches 2 notes");
    expect(submittedOps).toHaveLength(0);
  });
});

describe("notes area last paragraph (Phase 3 review)", () => {
  it("removing the last paragraph leaves no empty trailing line", async () => {
    const { ctx, notesText } = makeFakeContext(tripWithNotes(doc("Keep\nGone\n")));
    await removeNote(ctx, { trip_key: "T", text: "gone" });
    expect(notesText()).toBe("Keep\n");
  });
});
