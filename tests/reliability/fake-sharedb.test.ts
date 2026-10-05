import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createContext, type AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { ShareDBClient } from "../../src/transport/sharedb.ts";
import type { TripPlan } from "../../src/types.ts";

/**
 * A minimal in-process Wanderlog: REST for the trip/user endpoints and a
 * ShareDB-speaking WebSocket (init → hs → s → op/ack) that applies ops with
 * the same json0 implementation. Faults are injected per test so the real
 * client, cache and tools are exercised against connection failures that are
 * impossible to trigger on demand against wanderlog.com.
 */
type Faults = { dropAfterApply?: boolean; echoTwice?: boolean; mute?: boolean };

const DAY = "2099-03-01";
let doc: TripPlan;
let version: number;
let faults: Faults;
let http: Server;
let wss: WebSocketServer;
let baseUrl: string;
let session = 0;

function freshDoc(): TripPlan {
  return {
    key: "faketrip",
    title: "WANDERDOG_TEST fake",
    itinerary: {
      sections: [{ id: 1, type: "normal", mode: "dayPlan", date: DAY, heading: "", blocks: [] }],
    },
  } as unknown as TripPlan;
}

function handleSocket(ws: WebSocket): void {
  const id = `session-${++session}`;
  ws.send(JSON.stringify({ a: "init", id, protocol: 1, protocolMinor: 2, type: "json0" }));
  ws.on("message", (raw) => {
    if (faults.mute) return;
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (frame.a === "hs") {
      ws.send(JSON.stringify({ a: "hs", id, protocol: 1, protocolMinor: 2, type: "json0" }));
    } else if (frame.a === "s") {
      ws.send(JSON.stringify({ a: "s", c: frame.c, d: frame.d, data: { v: version, data: doc } }));
    } else if (frame.a === "op") {
      const appliedAt = version;
      doc = applyOp(doc, frame.op as Json0Op[]);
      version += 1;
      if (faults.dropAfterApply) {
        faults.dropAfterApply = false;
        ws.terminate();
        return;
      }
      const ack = { a: "op", c: frame.c, d: frame.d, v: appliedAt, src: id, seq: frame.seq };
      ws.send(JSON.stringify(ack));
      if (faults.echoTwice) ws.send(JSON.stringify({ ...ack, op: frame.op }));
    }
  });
}

beforeAll(async () => {
  http = createServer((req: IncomingMessage, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/user")) {
      res.end(JSON.stringify({ success: true, user: { id: 1, username: "fake" } }));
    } else if (req.url?.startsWith("/api/tripPlans/faketrip")) {
      res.end(JSON.stringify({ success: true, tripPlan: doc, resources: { geos: [] } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  wss = new WebSocketServer({ server: http, autoPong: false });
  wss.on("connection", (ws) => {
    // Answer pings by hand so a "mute" server can stop answering them.
    ws.on("ping", () => {
      if (!faults.mute) ws.pong();
    });
    handleSocket(ws);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  wss.close();
  await new Promise((resolve) => http.close(resolve));
});

let ctx: AppContext;
const savedTimings = {
  heartbeat: ShareDBClient.HEARTBEAT_INTERVAL_MS,
  pong: ShareDBClient.PONG_TIMEOUT_MS,
};

function setup(): AppContext {
  doc = freshDoc();
  version = 1;
  faults = {};
  process.env.WANDERLOG_COOKIE =
    "s%3AFakeSessionIdFakeSessionId0123.FakeSignatureFakeSignature0123";
  process.env.WANDERLOG_BASE_URL = baseUrl;
  process.env.WANDERLOG_WS_BASE_URL = baseUrl.replace("http", "ws");
  ctx = createContext();
  ctx.userId = 1;
  ctx.authenticated = true;
  return ctx;
}

afterEach(() => {
  ctx?.tripCache.clear();
  ctx?.pool.closeAll();
  ShareDBClient.HEARTBEAT_INTERVAL_MS = savedTimings.heartbeat;
  ShareDBClient.PONG_TIMEOUT_MS = savedTimings.pong;
});

const notesOnDay = () =>
  doc.itinerary.sections[0]!.blocks.filter((block) => block.type === "note").length;

describe("against a fake ShareDB server", () => {
  it("a write applied just before the socket drops is reported as maybe-saved, and the retry does not duplicate it", async () => {
    const ctx = setup();
    await ctx.tripCache.get("faketrip");
    faults.dropAfterApply = true;

    const first = await addNote(ctx, { trip_key: "faketrip", text: "Board at gate 3", day: DAY });
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toContain("may already have been saved");
    expect(notesOnDay()).toBe(1);

    const retry = await addNote(ctx, { trip_key: "faketrip", text: "Board at gate 3", day: DAY });
    expect(retry.isError).toBeUndefined();
    expect(retry.content[0]!.text).toContain("is already in");
    expect(notesOnDay()).toBe(1);
  });

  it("a duplicated echo of our own op is not applied twice to the cache", async () => {
    const ctx = setup();
    faults.echoTwice = true;
    await addNote(ctx, { trip_key: "faketrip", text: "Only once", day: DAY });
    await new Promise((r) => setTimeout(r, 50));

    const cached = await ctx.tripCache.get("faketrip");
    expect(cached.itinerary.sections[0]!.blocks).toHaveLength(1);
    expect(notesOnDay()).toBe(1);
  });

  it("a socket that stops answering is torn down and the next call recovers", async () => {
    ShareDBClient.HEARTBEAT_INTERVAL_MS = 100;
    ShareDBClient.PONG_TIMEOUT_MS = 100;
    const ctx = setup();
    await ctx.tripCache.get("faketrip");
    const client = ctx.pool.get("faketrip");

    faults.mute = true;
    const deadline = Date.now() + 5_000;
    while (client.isSubscribed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(client.isSubscribed).toBe(false);

    faults.mute = false;
    const result = await addNote(ctx, { trip_key: "faketrip", text: "After recovery", day: DAY });
    expect(result.isError).toBeUndefined();
    expect(notesOnDay()).toBe(1);
  });
});
