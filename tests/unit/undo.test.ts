import { beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { moveBlock } from "../../src/tools/move-block.ts";
import { clearUndo } from "../../src/tools/shared.ts";
import { undo } from "../../src/tools/undo.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const DAY = "2026-06-01";

function makeFakeContext(trip: TripPlan = checklistTrip) {
  const entry = { snapshot: structuredClone(trip), version: 10, geos: [] };
  const client = {
    isSubscribed: true,
    version: 10,
    async submit(_ops: Json0Op[]) {
      client.version += 1;
    },
  };
  const ctx = {
    userId: 1,
    pool: { get: () => client },
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
  /** Simulate an edit made elsewhere (app or another session). */
  const remoteEdit = () => {
    client.version += 1;
    entry.version = client.version;
  };
  return { ctx, entry, remoteEdit };
}

describe("undo", () => {
  beforeEach(() => clearUndo("T"));

  it("reverts the last change exactly", async () => {
    const { ctx, entry } = makeFakeContext();
    const original = structuredClone(entry.snapshot);
    await addNote(ctx, { trip_key: "T", text: "**temporary**", day: DAY });
    expect(entry.snapshot).not.toEqual(original);

    const result = await undo(ctx, { trip_key: "T" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Undid 1 change(s)");
    expect(entry.snapshot).toEqual(original);
  });

  it("undoes several changes newest first", async () => {
    const { ctx, entry } = makeFakeContext();
    const original = structuredClone(entry.snapshot);
    await addNote(ctx, { trip_key: "T", text: "one", day: DAY });
    await moveBlock(ctx, { trip_key: "T", block: "Park Güell", position: 3 });
    await undo(ctx, { trip_key: "T", steps: 2 });
    expect(entry.snapshot).toEqual(original);
  });

  it("refuses when the trip changed elsewhere after the edit", async () => {
    const { ctx, entry, remoteEdit } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "mine", day: DAY });
    const afterEdit = structuredClone(entry.snapshot);
    remoteEdit();
    const result = await undo(ctx, { trip_key: "T" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("was changed after that edit");
    expect(entry.snapshot).toEqual(afterEdit);
  });

  it("says when there is nothing to undo", async () => {
    const { ctx } = makeFakeContext();
    const result = await undo(ctx, { trip_key: "T" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing to undo");
  });
});

describe("undo summary", () => {
  beforeEach(() => clearUndo("T"));
  it("describes an added place as one added item", async () => {
    const { ctx } = makeFakeContext();
    await addNote(ctx, { trip_key: "T", text: "x", day: DAY });
    const result = await undo(ctx, { trip_key: "T" });
    expect(result.content[0]!.text).toContain("(added an item)");
  });
});
