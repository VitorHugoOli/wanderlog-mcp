import { describe, expect, it } from "vitest";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { invertOps } from "../../src/ot/invert.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const day = ["itinerary", "sections", 2, "blocks"];

function roundTrip(ops: Json0Op[], doc: TripPlan = checklistTrip) {
  const before = structuredClone(doc);
  const inverse = invertOps(before, ops);
  expect(inverse).not.toBeNull();
  const after = applyOp(before, ops);
  expect(after).not.toEqual(before);
  expect(applyOp(after, inverse!)).toEqual(before);
}

describe("invertOps", () => {
  it("inverts inserts, deletes, moves and field sets", () => {
    roundTrip([
      { p: [...day, 0], li: { id: 1, type: "note", text: { ops: [{ insert: "x\n" }] } } },
    ]);
    roundTrip([{ p: [...day, 0], ld: checklistTrip.itinerary.sections[2]!.blocks[0] }]);
    roundTrip([{ p: [...day, 0], lm: 2 }]);
    roundTrip([{ p: ["title"], od: checklistTrip.title, oi: "Renamed" }]);
    roundTrip([{ p: [...day, 0, "startTime"], oi: "09:00" }]);
  });

  it("inverts a multi-component batch where later parts touch what earlier parts created", () => {
    roundTrip([
      { p: [...day, 1], li: { id: 9, type: "note", text: { ops: [{ insert: "\n" }] } } },
      {
        p: [...day, 1, "text"],
        t: "rich-text",
        o: [{ insert: "Hi", attributes: { bold: true } }, { insert: "\n" }, { delete: 1 }],
      },
      { p: [...day, 0, "startTime"], oi: "10:00" },
    ]);
  });

  it("restores formatted rich text after an edit", () => {
    const doc = structuredClone(checklistTrip);
    (doc.itinerary.sections[2]!.blocks[1] as { text: unknown }).text = {
      ops: [{ insert: "Keep " }, { insert: "bold", attributes: { bold: true } }, { insert: "\n" }],
    };
    roundTrip(
      [
        {
          p: [...day, 1, "text"],
          t: "rich-text",
          o: [{ retain: 5 }, { delete: 4 }, { insert: "plain" }],
        },
      ],
      doc,
    );
  });

  it("refuses ops it cannot invert", () => {
    expect(invertOps(checklistTrip, [{ p: [...day, 1, "text"], t: "text0", o: [] }])).toBeNull();
  });
});
