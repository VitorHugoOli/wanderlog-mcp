import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addJournal } from "../../src/tools/add-journal.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { attachFile } from "../../src/tools/attach-file.ts";
import { createTrip } from "../../src/tools/create-trip.ts";
import { listAttachments } from "../../src/tools/list-attachments.ts";
import { assertTestTrip } from "./guard.ts";

/** Live: upload a PDF to a place and a photo to a journal stop. */
describe("attachments and journal photos (live)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;
  const DAY = "2099-09-01";
  const dir = mkdtempSync(join(tmpdir(), "wl-live-upload-"));

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) throw new Error("WANDERLOG_COOKIE must be set");
    ctx = createContext();
    ctx.userId = (await ctx.rest.getUser()).id;
    const created = await createTrip(ctx, {
      destination: "Lisbon",
      start_date: DAY,
      end_date: DAY,
      title: `WANDERDOG_TEST_${Date.now()}`,
      privacy: "private",
    });
    tripKey = created.content[0]!.text.match(/Key: (\w+)/)?.[1];
    assertTestTrip(await ctx.rest.getTrip(tripKey!));
    writeFileSync(
      join(dir, "ticket.pdf"),
      "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    );
    // 1x1 transparent PNG.
    writeFileSync(
      join(dir, "photo.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
  }, 30_000);

  afterAll(async () => {
    ctx?.pool.closeAll();
    if (tripKey) await ctx.rest.deleteTrip(tripKey).catch(() => {});
  });

  const ok = (r: { isError?: boolean; content: Array<{ text: string }> }) => {
    if (r.isError) throw new Error(r.content[0]!.text);
    return r.content[0]!.text;
  };

  it("attaches an uploaded PDF to a place and lists it", async () => {
    ok(await addPlace(ctx, { trip_key: tripKey!, place: "Torre de Belém", day: DAY }));
    expect(
      ok(
        await attachFile(ctx, {
          trip_key: tripKey!,
          place_ref: "Belém",
          file_path: join(dir, "ticket.pdf"),
        }),
      ),
    ).toContain("ticket.pdf");

    const trip = await ctx.rest.getTrip(tripKey!);
    const block = trip.itinerary.sections.find((s) => s.date === DAY)!.blocks[0] as unknown as {
      attachments: Array<{ fileName: string; key: string }>;
    };
    expect(block.attachments).toHaveLength(1);
    expect(block.attachments[0]!.fileName).toBe("ticket.pdf");
    expect(ok(await listAttachments(ctx, { trip_key: tripKey! }))).toContain("ticket.pdf");
  }, 120_000);

  it("adds a journal stop with an uploaded photo", async () => {
    ok(
      await addJournal(ctx, {
        trip_key: tripKey!,
        place: "Belém",
        photo_paths: [join(dir, "photo.png")],
      }),
    );
    const trip = await ctx.rest.getTrip(tripKey!);
    const stops =
      (
        trip.itinerary as unknown as {
          journal?: { stops?: Array<{ media?: Array<Record<string, unknown>> }> };
        }
      ).journal?.stops ?? [];
    expect(stops).toHaveLength(1);
    expect(stops[0]!.media).toEqual([
      expect.objectContaining({ type: "uploaded", width: 1, height: 1, mediaType: "image" }),
    ]);
  }, 120_000);
});
