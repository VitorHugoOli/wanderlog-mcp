import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { listTripAttachments, resolveAttachmentRef } from "../../src/resolvers/attachment-ref.ts";
import { attachFile } from "../../src/tools/attach-file.ts";
import { listAttachments } from "../../src/tools/list-attachments.ts";
import type { TripPlan } from "../../src/types.ts";

function makeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  uploadCalls: Array<{ fileName: string }>;
} {
  const submittedOps: Json0Op[][] = [];
  const uploadCalls: Array<{ fileName: string }> = [];
  const ctx = {
    rest: {
      async uploadAttachment(_tripKey: string, file: { fileName: string }) {
        uploadCalls.push({ fileName: file.fileName });
        return { key: "NEWUPLOADKEY", mimeType: "application/pdf" };
      },
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
      get: async () => structuredClone(trip),
      getEntry: async () => ({ snapshot: structuredClone(trip), version: 1, geos: [] }),
      applyLocalOp: () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, uploadCalls };
}

function tripWithAttachments(): TripPlan {
  return {
    id: 1,
    key: "k",
    title: "Trip",
    userId: 1,
    privacy: "private",
    startDate: "2026-06-01",
    endDate: "2026-06-02",
    days: 2,
    placeCount: 2,
    schemaVersion: 2,
    createdAt: "",
    updatedAt: "",
    itinerary: {
      sections: [
        {
          id: 1,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [
            {
              id: 100,
              type: "place",
              place: { name: "Hauptbahnhof", place_id: "p1" },
              // Two attachments on this place — shared with the other place
              attachments: [
                {
                  type: "file",
                  key: "AAA111",
                  contentType: "application/pdf",
                  fileName: "ticket.pdf",
                },
                {
                  type: "file",
                  key: "BBB222",
                  contentType: "image/jpeg",
                  fileName: "map screenshot.jpg",
                },
              ],
            } as unknown as TripPlan["itinerary"]["sections"][0]["blocks"][0],
          ],
        },
        {
          id: 2,
          type: "normal",
          mode: "dayPlan",
          heading: "",
          date: "2026-06-01",
          blocks: [
            {
              id: 200,
              type: "place",
              place: { name: "Tokyo Tower", place_id: "p2" },
              attachments: [
                // Shared with Hauptbahnhof — same key, different place
                {
                  type: "file",
                  key: "AAA111",
                  contentType: "application/pdf",
                  fileName: "ticket.pdf",
                },
              ],
            } as unknown as TripPlan["itinerary"]["sections"][1]["blocks"][0],
          ],
        },
      ],
    },
  };
}

function tripWithNoAttachments(): TripPlan {
  return {
    id: 1,
    key: "k",
    title: "Empty",
    userId: 1,
    privacy: "private",
    startDate: "2026-06-01",
    endDate: "2026-06-02",
    days: 2,
    placeCount: 1,
    schemaVersion: 2,
    createdAt: "",
    updatedAt: "",
    itinerary: {
      sections: [
        {
          id: 1,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [{ id: 1, type: "place", place: { name: "Hauptbahnhof", place_id: "p1" } }],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// listTripAttachments (resolver)
// ---------------------------------------------------------------------------

describe("listTripAttachments", () => {
  it("de-duplicates by key and tracks every referencing place", () => {
    const trip = tripWithAttachments();
    const atts = listTripAttachments(trip);
    expect(atts).toHaveLength(2);
    const ticket = atts.find((a) => a.key === "AAA111")!;
    expect(ticket.places).toHaveLength(2);
    expect(ticket.places.map((p) => p.placeName).sort()).toEqual(["Hauptbahnhof", "Tokyo Tower"]);
    const map = atts.find((a) => a.key === "BBB222")!;
    expect(map.places).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveAttachmentRef
// ---------------------------------------------------------------------------

describe("resolveAttachmentRef", () => {
  it("matches by exact storage key first", () => {
    const r = resolveAttachmentRef(tripWithAttachments(), "AAA111");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.fileName).toBe("ticket.pdf");
  });
  it("matches by exact filename (case-insensitive)", () => {
    const r = resolveAttachmentRef(tripWithAttachments(), "Ticket.PDF");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.key).toBe("AAA111");
  });
  it("matches by filename substring", () => {
    const r = resolveAttachmentRef(tripWithAttachments(), "screenshot");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.match.key).toBe("BBB222");
  });
  it("returns none for empty trip", () => {
    const r = resolveAttachmentRef(tripWithNoAttachments(), "anything");
    expect(r.kind).toBe("none");
  });
  it("returns none for unmatched", () => {
    const r = resolveAttachmentRef(tripWithAttachments(), "zzzz");
    expect(r.kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// list-attachments tool
// ---------------------------------------------------------------------------

describe("listAttachments", () => {
  it("returns a placeholder message when there are no attachments", async () => {
    const { ctx } = makeContext(tripWithNoAttachments());
    const result = await listAttachments(ctx, { trip_key: "k" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("no attachments");
  });

  it("lists unique files with reference counts (concise)", async () => {
    const { ctx } = makeContext(tripWithAttachments());
    const result = await listAttachments(ctx, { trip_key: "k" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("2 files");
    expect(text).toContain("ticket.pdf");
    expect(text).toContain("referenced 2 places");
    expect(text).toContain("map screenshot.jpg");
    expect(text).toContain("referenced 1 place");
  });

  it("shows storage key + place list in detailed mode", async () => {
    const { ctx } = makeContext(tripWithAttachments());
    const result = await listAttachments(ctx, {
      trip_key: "k",
      response_format: "detailed",
    });
    const text = result.content[0]!.text;
    expect(text).toContain("key: AAA111");
    expect(text).toContain("Hauptbahnhof");
    expect(text).toContain("Tokyo Tower");
  });
});

// ---------------------------------------------------------------------------
// attach_file — reference mode (new)
// ---------------------------------------------------------------------------

describe("attachFile — reference mode (existing attachment)", () => {
  it("attaches an existing file by storage key without re-uploading", async () => {
    // Hauptbahnhof has BBB222 already; attach BBB222 (the map screenshot) to Tokyo Tower.
    const { ctx, submittedOps, uploadCalls } = makeContext(tripWithAttachments());
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Tokyo Tower",
      attachment: "BBB222",
    });
    expect(result.isError).toBeUndefined();
    expect(uploadCalls).toHaveLength(0);
    const op = submittedOps[0]![0] as { p: unknown[]; li: { key: string; fileName: string } };
    // Tokyo Tower already had ticket.pdf (AAA111): the map is appended with li
    // after it, so a concurrent attach elsewhere cannot drop either.
    expect(op.p.at(-1)).toBe(1);
    expect(op.li.key).toBe("BBB222");
  });

  it("attaches by filename substring", async () => {
    const { ctx, uploadCalls, submittedOps } = makeContext(tripWithAttachments());
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Tokyo Tower",
      attachment: "screenshot",
    });
    expect(result.isError).toBeUndefined();
    expect(uploadCalls).toHaveLength(0);
    const op = submittedOps[0]![0] as { li: { key: string } };
    expect(op.li.key).toBe("BBB222");
  });

  it("rejects when both file_path and attachment are given", async () => {
    const { ctx, submittedOps, uploadCalls } = makeContext(tripWithAttachments());
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Hauptbahnhof",
      file_path: "C:/file.pdf",
      attachment: "BBB222",
    });
    expect(result.isError).toBe(true);
    expect(uploadCalls).toHaveLength(0);
    expect(submittedOps).toHaveLength(0);
  });

  it("rejects when neither file_path nor attachment is given", async () => {
    const { ctx, submittedOps, uploadCalls } = makeContext(tripWithAttachments());
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Hauptbahnhof",
    });
    expect(result.isError).toBe(true);
    expect(uploadCalls).toHaveLength(0);
    expect(submittedOps).toHaveLength(0);
  });

  it("returns helpful error when attachment ref doesn't match", async () => {
    const { ctx, submittedOps, uploadCalls } = makeContext(tripWithAttachments());
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Hauptbahnhof",
      attachment: "no-such-file",
    });
    expect(result.isError).toBe(true);
    expect(uploadCalls).toHaveLength(0);
    expect(submittedOps).toHaveLength(0);
    expect(result.content[0]!.text).toContain("No attachment matching");
  });

  it("returns no-change when the file is already attached to that place", async () => {
    const { ctx, submittedOps, uploadCalls } = makeContext(tripWithAttachments());
    // ticket.pdf (AAA111) is already on Hauptbahnhof
    const result = await attachFile(ctx, {
      trip_key: "k",
      place_ref: "Hauptbahnhof",
      attachment: "AAA111",
    });
    expect(result.isError).toBeUndefined();
    expect(uploadCalls).toHaveLength(0);
    expect(submittedOps).toHaveLength(0);
    expect(result.content[0]!.text).toContain("already attached");
  });
});
