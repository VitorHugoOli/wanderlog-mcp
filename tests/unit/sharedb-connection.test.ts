import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ws from "ws";
import { ShareDBClient } from "../../src/transport/sharedb.ts";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    readonly sent: Array<Record<string, unknown>> = [];
    pings = 0;
    answerPings = true;

    ping(): void {
      this.pings += 1;
      if (this.answerPings) queueMicrotask(() => this.emit("pong"));
    }

    constructor() {
      super();
      FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error("WebSocket is not open");
      this.sent.push(JSON.parse(data));
    }

    close(): void {
      this.terminate();
    }

    terminate(): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1006);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    receive(frame: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(frame)));
    }

    sentActions(): unknown[] {
      return this.sent.map((f) => f.a);
    }
  }

  return { default: FakeWebSocket };
});

type FakeSocket = {
  pings: number;
  answerPings: boolean;
  readyState: number;
  sent: Array<Record<string, unknown>>;
  emit(event: string, ...args: unknown[]): boolean;
  open(): void;
  receive(frame: unknown): void;
  terminate(): void;
  sentActions(): unknown[];
};
const FakeWebSocket = ws as unknown as { instances: FakeSocket[] };

const config = { wsBaseUrl: "wss://test", baseUrl: "https://test", userAgent: "test" } as any;
const INIT = { a: "init", id: "sess", protocol: 1, protocolMinor: 2, type: "json0" };
const HS = { a: "hs", id: "sess", protocol: 1, protocolMinor: 2, type: "json0" };
const SUBSCRIBE_ACK = { a: "s", c: "TripPlans", d: "tripA", data: { v: 7, data: { title: "t" } } };

const flush = () => vi.advanceTimersByTimeAsync(0);
const latestSocket = () => FakeWebSocket.instances.at(-1)!;

function completeHandshake(socket: FakeSocket): void {
  socket.open();
  socket.receive(INIT);
  socket.receive(HS);
}

async function subscribedClient() {
  const client = new ShareDBClient(config, "tripA");
  const subscribed = client.subscribe();
  completeHandshake(latestSocket());
  await flush();
  latestSocket().receive(SUBSCRIBE_ACK);
  await subscribed;
  return client;
}

describe("ShareDBClient connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends the handshake only after the server's init frame", async () => {
    const client = new ShareDBClient(config, "tripA");
    const connected = client.connect();
    const socket = latestSocket();

    socket.open();
    expect(socket.sent).toEqual([]);

    socket.receive(INIT);
    expect(socket.sentActions()).toEqual(["hs"]);

    socket.receive(HS);
    await expect(connected).resolves.toBeUndefined();
    client.close();
  });

  it("ignores late events from a socket that has been replaced", async () => {
    const client = new ShareDBClient(config, "tripA");
    const first = client.connect();
    const staleSocket = latestSocket();
    const firstFailed = expect(first).rejects.toMatchObject({ code: "ws_timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await firstFailed;

    const subscribed = client.subscribe();
    const current = latestSocket();
    expect(current).not.toBe(staleSocket);
    completeHandshake(current);
    await flush();
    current.receive(SUBSCRIBE_ACK);
    await subscribed;

    expect(() => {
      staleSocket.emit("open");
      staleSocket.emit("message", Buffer.from(JSON.stringify(INIT)));
      staleSocket.emit("close", 1006);
    }).not.toThrow();
    expect(client.isSubscribed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it("does not reconnect in the background after an unexpected close", async () => {
    const client = await subscribedClient();
    const closed = vi.fn();
    client.on("closed", closed);

    latestSocket().terminate();
    expect(closed).toHaveBeenCalledWith(1006);
    expect(client.isSubscribed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.close();
  });

  it("reconnects and resubscribes on demand after an unexpected close", async () => {
    const client = await subscribedClient();
    latestSocket().terminate();

    const resubscribed = client.subscribe();
    const fresh = latestSocket();
    expect(FakeWebSocket.instances).toHaveLength(2);
    completeHandshake(fresh);
    await flush();
    expect(fresh.sentActions()).toEqual(["hs", "s"]);
    fresh.receive(SUBSCRIBE_ACK);
    await expect(resubscribed).resolves.toEqual({ title: "t" });
    expect(client.isSubscribed).toBe(true);
    client.close();
  });

  it("rejects the caller when resubscribing fails, without crashing", async () => {
    const client = await subscribedClient();
    latestSocket().terminate();

    const resubscribed = client.subscribe();
    const failed = expect(resubscribed).rejects.toMatchObject({ code: "ws_error" });
    completeHandshake(latestSocket());
    await flush();
    latestSocket().receive({ error: { message: "boom" } });
    await failed;
    expect(client.isSubscribed).toBe(false);
    client.close();
  });

  it("submits at the given base version and reports the ack version", async () => {
    const client = await subscribedClient();
    const socket = latestSocket();
    const submitted = client.submit([{ p: ["title"], oi: "x" }], 5);
    const frame = socket.sent.at(-1)!;
    expect(frame).toMatchObject({ a: "op", v: 5 });

    socket.receive({ a: "op", c: "TripPlans", d: "tripA", v: 9, src: "sess", seq: frame.seq });
    await expect(submitted).resolves.toEqual({ sentVersion: 5, ackVersion: 9 });
    expect(client.version).toBe(10);
    client.close();
  });

  it("never re-emits a late copy of our own op as a remote op", async () => {
    const client = await subscribedClient();
    const socket = latestSocket();
    const remote = vi.fn();
    client.on("remoteOp", remote);

    const submitted = client.submit([{ p: ["title"], oi: "x" }]);
    const seq = socket.sent.at(-1)!.seq;
    const ack = { a: "op", c: "TripPlans", d: "tripA", v: 7, src: "sess", seq, op: [] };
    socket.receive(ack);
    await submitted;
    socket.receive({ ...ack, op: [{ p: ["title"], oi: "x" }] });

    expect(remote).not.toHaveBeenCalled();
    expect(client.version).toBe(8);

    socket.receive({
      a: "op",
      c: "TripPlans",
      d: "tripA",
      v: 8,
      src: "other",
      seq: 1,
      op: [{ p: ["title"], oi: "y" }],
    });
    expect(remote).toHaveBeenCalledOnce();
    expect(client.version).toBe(9);
    client.close();
  });

  it("deduplicates concurrent subscribe() calls into one request", async () => {
    const client = new ShareDBClient(config, "tripA");
    const a = client.subscribe();
    const b = client.subscribe();
    const socket = latestSocket();
    completeHandshake(socket);
    await flush();

    expect(socket.sentActions().filter((x) => x === "s")).toHaveLength(1);
    socket.receive(SUBSCRIBE_ACK);
    await expect(Promise.all([a, b])).resolves.toEqual([{ title: "t" }, { title: "t" }]);
    client.close();
  });

  it("pings periodically and keeps a socket that answers", async () => {
    const client = await subscribedClient();
    const socket = latestSocket();
    await vi.advanceTimersByTimeAsync(ShareDBClient.HEARTBEAT_INTERVAL_MS * 3);
    expect(socket.pings).toBe(3);
    expect(client.isSubscribed).toBe(true);
    client.close();
  });

  it("terminates a socket that stops answering pings", async () => {
    const client = await subscribedClient();
    const socket = latestSocket();
    const closed = vi.fn();
    client.on("closed", closed);
    socket.answerPings = false;

    await vi.advanceTimersByTimeAsync(ShareDBClient.HEARTBEAT_INTERVAL_MS);
    expect(client.isSubscribed).toBe(true);
    await vi.advanceTimersByTimeAsync(ShareDBClient.PONG_TIMEOUT_MS);
    expect(closed).toHaveBeenCalledOnce();
    expect(client.isSubscribed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("closes the socket when a submit is never acked", async () => {
    const client = await subscribedClient();
    const submitted = client.submit([{ p: ["title"], oi: "x" }]);
    const failed = expect(submitted).rejects.toMatchObject({ code: "submit_timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(client.isSubscribed).toBe(false);
    expect(latestSocket().readyState).toBe(3);
  });

  it("answers ensureAlive without a ping while traffic is recent", async () => {
    const client = await subscribedClient();
    await expect(client.ensureAlive()).resolves.toBe(true);
    expect(latestSocket().pings).toBe(0);
    client.close();
  });

  it("pings before trusting an idle socket and drops it if there is no pong", async () => {
    const client = await subscribedClient();
    const socket = latestSocket();
    vi.setSystemTime(Date.now() + 60_000);

    await expect(client.ensureAlive()).resolves.toBe(true);
    expect(socket.pings).toBe(1);

    vi.setSystemTime(Date.now() + 60_000);
    socket.answerPings = false;
    const alive = client.ensureAlive();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(alive).resolves.toBe(false);
    expect(socket.readyState).toBe(3);
    expect(client.isSubscribed).toBe(false);
  });
});
