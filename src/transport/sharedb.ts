import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Config } from "../config.js";
import { WanderlogAuthError, WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { createLogger } from "../logging.js";
import type { TripPlan } from "../types.js";

const logger = createLogger("ws");

export type { Json0Op };

export type SubmitResult = {
  /** Version the ops were built against and sent at. */
  sentVersion: number;
  /** Version the server applied them at; differs when it transformed them. */
  ackVersion: number;
};

type InitFrame = {
  a: "init";
  id: string;
  protocol: number;
  protocolMinor: number;
  type: string;
};

type HandshakeAckFrame = {
  a: "hs";
  id: string;
  protocol: number;
  protocolMinor: number;
  type: string;
};

type SubscribeAckFrame = {
  a: "s";
  c: string;
  d: string;
  data?: { v: number; data: TripPlan };
};

type OpFrame = {
  a: "op";
  c: string;
  d: string;
  v: number;
  seq?: number;
  src?: string;
  op?: Json0Op[];
};

type Frame = InitFrame | HandshakeAckFrame | SubscribeAckFrame | OpFrame;

export interface ShareDBClient {
  /** Fired when a remote op (not one we submitted) is received. */
  on(event: "remoteOp", listener: (ops: Json0Op[], version: number) => void): this;
  on(event: "closed", listener: (code: number) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * ShareDB JSONv0 client bound to a single trip key.
 * Exposes subscribe() for the initial snapshot, submit() for outgoing ops
 * (with version tracking and ack waiting), and a `remoteOp` event for ops
 * pushed by the server from other clients.
 */
export class ShareDBClient extends EventEmitter {
  private ws?: WebSocket;
  private sessionId?: string;
  private handshakeComplete = false;
  private seqCounter = 0;
  private snapshot?: TripPlan;
  private _version = 0;
  private subscribed = false;
  private subscribePending?: {
    resolve: (ack: SubscribeAckFrame) => void;
    reject: (err: Error) => void;
  };
  private readonly pendingOps = new Map<
    number,
    { resolve: (ackVersion: number) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private connectPromise?: Promise<void>;
  private subscribePromise?: Promise<TripPlan>;
  private heartbeatTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private pongWaiters: Array<() => void> = [];
  private lastSeenAt = 0;

  static HEARTBEAT_INTERVAL_MS = 30_000;
  static PONG_TIMEOUT_MS = 10_000;

  constructor(
    private readonly config: Config,
    private readonly tripKey: string,
  ) {
    super();
  }

  get version(): number {
    return this._version;
  }

  get currentSnapshot(): TripPlan | undefined {
    return this.snapshot;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  private url(): string {
    return `${this.config.wsBaseUrl}/api/tripPlans/wsOverall/${encodeURIComponent(
      this.tripKey,
    )}?clientSchemaVersion=2`;
  }

  async connect(): Promise<void> {
    if (this.handshakeComplete) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), {
        headers: {
          Cookie: this.config.cookieHeader,
          Origin: this.config.baseUrl,
          "User-Agent": this.config.userAgent,
        },
      });
      this.retireSocket();
      this.ws = ws;
      this.handshakeComplete = false;
      this.subscribed = false;
      // Every listener below is bound to this particular socket. Once a newer
      // socket replaces it, its late events must not touch shared client state.
      const isStale = () => this.ws !== ws;

      const handshakeTimeout = setTimeout(() => {
        reject(new WanderlogError("ShareDB handshake timeout", "ws_timeout"));
        ws.terminate();
      }, 10_000);

      ws.on("message", (raw) => {
        if (isStale()) return;
        this.markAlive();
        const text = raw.toString();
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if ((msg as { a?: string }).a === "init" && !this.handshakeComplete) {
          // Wanderlog silently drops an `hs` that arrives before the server's
          // `init`, so the handshake is only sent in response to it (as the
          // official ShareDB client does). Sent on this socket directly, not via
          // this.send(), because a throw inside a ws listener is uncaught and
          // kills the process.
          try {
            ws.send(JSON.stringify({ a: "hs", id: null, protocol: 1, protocolMinor: 2 }));
          } catch (err) {
            clearTimeout(handshakeTimeout);
            reject(err);
            return;
          }
        }
        this.handleFrame(msg as Frame & { error?: unknown }, handshakeTimeout, resolve);
      });

      ws.on("pong", () => {
        if (isStale()) return;
        this.markAlive();
      });

      ws.on("close", (code: number) => {
        clearTimeout(handshakeTimeout);
        if (isStale()) return;
        this.stopHeartbeat();
        logger.info("socket closed", { trip: this.tripKey, code, wasSubscribed: this.subscribed });
        this.handshakeComplete = false;
        this.subscribed = false;
        this.failAllPending(new WanderlogError("WebSocket closed", "ws_closed"));
        // No background reconnect: TripCache drops its entry on "closed" and the
        // next tool call reconnects and resubscribes on demand, so a dead socket
        // never keeps timers alive or races a fresh one.
        this.emit("closed", code);
      });

      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(handshakeTimeout);
        if (isStale()) return;
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new WanderlogAuthError());
        } else {
          reject(
            new WanderlogError(`WebSocket upgrade failed: ${res.statusCode}`, "ws_upgrade_failed"),
          );
        }
      });

      ws.on("error", (err: Error) => {
        clearTimeout(handshakeTimeout);
        if (isStale()) return;
        if (!this.handshakeComplete) reject(err);
      });
    });
  }

  private retireSocket(): void {
    const old = this.ws;
    if (!old) return;
    this.stopHeartbeat();
    this.ws = undefined;
    old.removeAllListeners();
    // ws emits "error" when terminating a socket that is still connecting;
    // without a listener that becomes an uncaught exception.
    old.on("error", () => {});
    old.terminate();
    this.failAllPending(new WanderlogError("WebSocket replaced", "ws_closed"));
  }

  private handleFrame(
    frame: Frame & { error?: unknown; seq?: number; code?: number; message?: string },
    handshakeTimeout: NodeJS.Timeout,
    connectResolve: () => void,
  ): void {
    // Server rejections arrive as bare {code, message} frames with no `a` and
    // no `seq` (observed: {code: 4001, message: "Too many requests"}). Without
    // this branch they fall through silently and the submit dies as an opaque
    // 10s timeout. No seq means we can't attribute it — fail everything.
    const bare = frame as { a?: string; code?: number; message?: string };
    if (bare.a === undefined && typeof bare.code === "number") {
      const code = bare.code === 4001 ? "rate_limited" : "ws_rejected";
      this.failAllPending(
        new WanderlogError(
          `Wanderlog rejected the request (${bare.code}): ${bare.message ?? "unknown"}`,
          code,
        ),
      );
      return;
    }

    if (frame.error) {
      const err = frame.error as string | { message?: string };
      const errMsg = typeof err === "string" ? err : (err.message ?? "unknown");

      // If the error frame carries a seq, it belongs to a specific submit.
      // Fail only that one pending op, so concurrent/queued submits are not
      // collateral damage.
      if (typeof frame.seq === "number" && this.pendingOps.has(frame.seq)) {
        const pending = this.pendingOps.get(frame.seq)!;
        this.pendingOps.delete(frame.seq);
        clearTimeout(pending.timer);
        pending.reject(new WanderlogError(errMsg, "ws_op_rejected"));
        return;
      }

      // No seq, or unknown seq — fall back to failing everything, since we
      // can't safely attribute the error.
      this.failAllPending(new WanderlogError(errMsg, "ws_error"));
      return;
    }

    if (frame.a === "init") {
      this.sessionId = (frame as InitFrame).id;
      return;
    }

    if (frame.a === "hs" && !this.handshakeComplete) {
      this.handshakeComplete = true;
      clearTimeout(handshakeTimeout);
      this.startHeartbeat();
      logger.debug("handshake complete", { trip: this.tripKey });
      const hs = frame as HandshakeAckFrame;
      if (!this.sessionId && hs.id) this.sessionId = hs.id;
      connectResolve();
      return;
    }

    if (frame.a === "s") {
      const pending = this.subscribePending;
      if (pending) {
        this.subscribePending = undefined;
        pending.resolve(frame as SubscribeAckFrame);
      }
      return;
    }

    if (frame.a === "op") {
      this.handleOpFrame(frame as OpFrame);
    }
  }

  private handleOpFrame(frame: OpFrame): void {
    const isOurs =
      this.sessionId !== undefined && frame.src !== undefined && frame.src === this.sessionId;
    const isOurAck = isOurs && frame.seq !== undefined && this.pendingOps.has(frame.seq);

    if (isOurAck) {
      const pending = this.pendingOps.get(frame.seq!)!;
      this.pendingOps.delete(frame.seq!);
      clearTimeout(pending.timer);
      this._version = frame.v + 1;
      pending.resolve(frame.v);
      return;
    }

    if (isOurs) {
      // A late or repeated copy of our own op: it was already applied locally
      // (or the cache was invalidated when its submit failed). Treating it as
      // remote would apply it twice, and an `li` applied twice duplicates a
      // block. Track the version only.
      if (frame.op && frame.op.length > 0) this._version = frame.v + 1;
      return;
    }

    if (frame.op && frame.op.length > 0) {
      this._version = frame.v + 1;
      this.emit("remoteOp", frame.op, this._version);
    }
  }

  private failAllPending(err: Error): void {
    if (this.subscribePending) {
      this.subscribePending.reject(err);
      this.subscribePending = undefined;
    }
    for (const [seq, pending] of this.pendingOps) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingOps.delete(seq);
    }
  }

  /**
   * A connection dropped by sleep, a network change or a NAT dies without a
   * close frame and keeps reporting OPEN, so reads serve a frozen snapshot and
   * every submit times out. A periodic ping with a pong deadline turns that
   * into a real close, which drops the cache entry and forces a resubscribe.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.pongTimer) this.ping(ShareDBClient.PONG_TIMEOUT_MS);
    }, ShareDBClient.HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  private ping(timeoutMs: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      if (this.ws === ws) {
        logger.warn("no pong, terminating socket", { trip: this.tripKey, timeoutMs });
        ws.terminate();
      }
    }, timeoutMs);
    this.pongTimer.unref();
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }

  private markAlive(): void {
    this.lastSeenAt = Date.now();
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    const waiters = this.pongWaiters;
    this.pongWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Cheap liveness check before trusting a subscription that has been quiet
   * for a while (e.g. after the laptop slept). Pings and waits briefly; if
   * the server does not answer, the socket is terminated and false returned.
   */
  async ensureAlive(idleMs = 45_000, timeoutMs = 3_000): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.handshakeComplete) return false;
    if (Date.now() - this.lastSeenAt < idleMs) return true;
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.pongWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    this.ping(timeoutMs);
    const alive = await answered;
    logger.debug("idle liveness check", { trip: this.tripKey, alive });
    if (!alive && this.ws === ws) ws.terminate();
    return alive && this.ws === ws && this.subscribed;
  }

  private send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new WanderlogError("WebSocket is not open — cannot send frame", "ws_not_open");
    }
    this.ws.send(JSON.stringify(obj));
  }

  async subscribe(): Promise<TripPlan> {
    // Concurrent callers must share one request: subscribePending holds a single resolver, so a second "s" frame
    // would orphan the first caller until its timeout.
    if (this.subscribePromise) return this.subscribePromise;
    this.subscribePromise = this.doSubscribe();
    try {
      return await this.subscribePromise;
    } finally {
      this.subscribePromise = undefined;
    }
  }

  private async doSubscribe(): Promise<TripPlan> {
    await this.connect();

    if (this.subscribed && this.snapshot && this.ws?.readyState === WebSocket.OPEN) {
      return this.snapshot;
    }
    this.subscribed = false;

    const ack = await new Promise<SubscribeAckFrame>((resolve, reject) => {
      // A timer left running after the ack could later clear a newer
      // subscribePending and strand that caller.
      const timer = setTimeout(() => {
        if (this.subscribePending === pending) {
          this.subscribePending = undefined;
          reject(new WanderlogError("Subscribe timeout", "subscribe_timeout"));
        }
      }, 10_000);
      const pending = {
        resolve: (frame: SubscribeAckFrame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.subscribePending = pending;
      try {
        this.send({ a: "s", c: "TripPlans", d: this.tripKey });
      } catch (err) {
        this.subscribePending = undefined;
        pending.reject(err as Error);
      }
    });

    if (!ack.data) {
      throw new WanderlogError("Subscribe ack missing snapshot", "subscribe_failed");
    }

    this.snapshot = ack.data.data;
    this._version = ack.data.v;
    this.subscribed = true;
    logger.debug("subscribed", { trip: this.tripKey, version: ack.data.v });
    return this.snapshot;
  }

  /**
   * Submit a JSON0 op array to the server. Resolves when the server acks.
   * Throws if not subscribed, if the WebSocket is closed, or on ack timeout.
   *
   * `baseVersion` is the version of the snapshot the ops were built from.
   * Sending at that version (not the possibly newer current one) lets the
   * server transform the ops against anything that landed in between; an
   * untransformed op at a newer version can hit the wrong array index.
   *
   * On successful ack, the local version is bumped to `frame.v + 1`.
   */
  async submit(ops: Json0Op[], baseVersion?: number): Promise<SubmitResult> {
    if (!this.subscribed) {
      throw new WanderlogError("Cannot submit op before subscribing to the trip", "not_subscribed");
    }
    if (ops.length === 0) {
      throw new WanderlogError("Cannot submit an empty op array", "empty_op");
    }

    this.seqCounter += 1;
    const seq = this.seqCounter;
    const sentVersion = baseVersion ?? this._version;
    const frame = {
      a: "op",
      c: "TripPlans",
      d: this.tripKey,
      v: sentVersion,
      seq,
      x: {},
      op: ops,
    };

    return new Promise<SubmitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingOps.has(seq)) {
          this.pendingOps.delete(seq);
          reject(new WanderlogError("Submit op timeout", "submit_timeout"));
          // A missing ack almost always means a dead connection; close it so
          // the next call resubscribes instead of timing out the same way.
          logger.warn("submit not acked, terminating socket", { trip: this.tripKey, seq });
          this.ws?.terminate();
        }
      }, 10_000);
      this.pendingOps.set(seq, {
        resolve: (ackVersion) => resolve({ sentVersion, ackVersion }),
        reject,
        timer,
      });
      try {
        this.send(frame);
      } catch (err) {
        // Send failed (e.g. WS closed between the isSubscribed check and now).
        // Clean up the pending entry and propagate immediately rather than
        // waiting 10s for the timeout to fire.
        this.pendingOps.delete(seq);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.subscribed = false;
    this.failAllPending(new WanderlogError("Client closed", "ws_closed"));
    this.ws?.close();
  }
}

/**
 * Pool of ShareDBClient instances keyed by trip key. A single MCP server
 * session may subscribe to multiple trips concurrently; each gets its own
 * WebSocket (required, since the URL embeds the trip key).
 */
export class ShareDBPool {
  private readonly clients = new Map<string, ShareDBClient>();

  constructor(private readonly config: Config) {}

  get(tripKey: string): ShareDBClient {
    let client = this.clients.get(tripKey);
    if (!client) {
      client = new ShareDBClient(this.config, tripKey);
      this.clients.set(tripKey, client);
    }
    return client;
  }

  has(tripKey: string): boolean {
    return this.clients.has(tripKey);
  }

  evict(tripKey: string, expectedClient?: ShareDBClient): boolean {
    const client = this.clients.get(tripKey);
    if (!client || (expectedClient && client !== expectedClient)) return false;

    this.clients.delete(tripKey);
    client.close();
    return true;
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }
}
