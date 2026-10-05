import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addJournal } from "../../src/tools/add-journal.ts";
import { readUploadableFile } from "../../src/tools/uploads.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

// A 2x3 PNG: signature + IHDR with width 2, height 3.
function png(): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(3, 20);
  return b;
}

const dir = mkdtempSync(join(tmpdir(), "wl-upload-"));
writeFileSync(join(dir, "ticket.pdf"), "%PDF-1.4");
writeFileSync(join(dir, "photo.png"), png());
writeFileSync(join(dir, "id_rsa"), "secret");
writeFileSync(join(dir, "creds.json"), "{}");
mkdirSync(join(dir, ".ssh"));
writeFileSync(join(dir, ".ssh", "key.pdf"), "x");

describe("upload guards", () => {
  it("accepts travel documents and photos", async () => {
    await expect(readUploadableFile(join(dir, "ticket.pdf"))).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses other file types, hidden folders and relative paths", async () => {
    await expect(readUploadableFile(join(dir, "id_rsa"))).rejects.toThrow(/Only travel documents/);
    await expect(readUploadableFile(join(dir, "creds.json"))).rejects.toThrow(
      /Only travel documents/,
    );
    await expect(readUploadableFile(join(dir, ".ssh", "key.pdf"))).rejects.toThrow(/hidden/);
    await expect(readUploadableFile("ticket.pdf")).rejects.toThrow(/absolute/);
  });
});

describe("journal photos", () => {
  it("uploads first and stores media with the photo's dimensions", async () => {
    const trip: TripPlan = { ...structuredClone(checklistTrip), journal: { stops: [] } } as never;
    (trip.itinerary as Record<string, unknown>).journal = { stops: [], summary: "" };
    const entry = { snapshot: trip, version: 1, geos: [] };
    const uploads: string[] = [];
    const ctx = {
      userId: 1,
      rest: {
        uploadMedia: async (_k: string, files: Array<{ fileName: string }>) => {
          uploads.push(...files.map((f) => f.fileName));
          return files.map((_f, i) => ({ type: "image", key: `K${i}` }));
        },
      },
      pool: { get: () => ({ isSubscribed: true, version: 1, submit: async () => {} }) },
      tripCache: {
        getEntry: async () => entry,
        applyLocalOp: (_k: string, ops: Json0Op[], v: number) => {
          entry.snapshot = applyOp(entry.snapshot, ops);
          entry.version = v;
        },
        invalidate: () => {},
      },
    } as unknown as AppContext;

    const result = await addJournal(ctx, {
      trip_key: "T",
      place: "Park Güell",
      photo_paths: [join(dir, "photo.png")],
    });
    expect(result.isError).toBeUndefined();
    expect(uploads).toEqual(["photo.png"]);
    const stop = (
      entry.snapshot.itinerary as unknown as { journal: { stops: Array<{ media: unknown[] }> } }
    ).journal.stops[0]!;
    expect(stop.media).toEqual([
      { type: "uploaded", key: "K0", width: 2, height: 3, mediaType: "image" },
    ]);
  });
});
