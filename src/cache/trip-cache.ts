import { applyOp, type Json0Op } from "../ot/apply.js";
import { WanderlogError } from "../errors.js";
import type { RestClient } from "../transport/rest.js";
import type { ShareDBClient, ShareDBPool } from "../transport/sharedb.js";
import type { Geo, TripPlan } from "../types.js";

export type CacheEntry = {
  snapshot: TripPlan;
  version: number;
  geos: Geo[];
  client: ShareDBClient;
  remoteOpListener: (ops: Json0Op[], version: number) => void;
  closedListener: (code: number) => void;
  lastUsedAt?: number;
};

/** Trips untouched this long have their socket closed and snapshot dropped. */
export const IDLE_EVICT_MS = 30 * 60_000;

/**
 * Live trip cache. On first access, validates the trip exists via REST
 * (fast 404 path for bad keys), then subscribes via ShareDBPool for live
 * updates. Incoming remote ops are applied to the cached doc so reads stay
 * current without refetching.
 *
 * Callers can read `entry.snapshot` and `entry.version` to prepare submit
 * ops with the correct version vector.
 */
export class TripCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly subscribing = new Map<string, Promise<CacheEntry>>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly rest: RestClient,
    private readonly pool: ShareDBPool,
  ) {}

  async get(tripKey: string): Promise<TripPlan> {
    const entry = await this.ensureEntry(tripKey);
    return entry.snapshot;
  }

  async getEntry(tripKey: string): Promise<CacheEntry> {
    return this.ensureEntry(tripKey);
  }

  private async ensureEntry(tripKey: string): Promise<CacheEntry> {
    const existing = this.entries.get(tripKey);
    if (existing) {
      if ((await this.isAlive(existing)) && this.isFresh(existing)) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      // Serving a snapshot that no longer matches the live document is how an
      // agent comes to believe its own write did not land, and repeats it.
      this.deleteEntry(tripKey);
    }

    const pending = this.subscribing.get(tripKey);
    if (pending) return pending;

    const promise = this.subscribeAndCache(tripKey);
    this.subscribing.set(tripKey, promise);
    try {
      return await promise;
    } finally {
      this.subscribing.delete(tripKey);
    }
  }

  private async isAlive(entry: CacheEntry): Promise<boolean> {
    const client = entry.client as Partial<Pick<ShareDBClient, "ensureAlive">>;
    return typeof client.ensureAlive === "function" ? client.ensureAlive() : true;
  }

  /**
   * Every path that advances the client's version also advances the entry's,
   * so a mismatch means an op was missed (or one of ours was transformed).
   */
  private isFresh(entry: CacheEntry): boolean {
    return entry.client.isSubscribed && entry.version === entry.client.version;
  }

  /**
   * Replace a diverged entry's snapshot with a freshly subscribed one, in the
   * same entry object, so a multi-step mutation holding that entry keeps
   * working against current data. Used when the server transformed one of our
   * ops: applying the untransformed op locally would corrupt the cache.
   */
  async refresh(tripKey: string): Promise<void> {
    const entry = this.entries.get(tripKey);
    if (!entry) return;
    entry.client.off("remoteOp", entry.remoteOpListener);
    entry.client.off("closed", entry.closedListener);
    this.entries.delete(tripKey);
    this.pool.evict(tripKey, entry.client);

    const fresh = await this.subscribeAndCache(tripKey, entry.geos);
    Object.assign(entry, fresh);
    this.entries.set(tripKey, entry);
  }

  private async subscribeAndCache(tripKey: string, knownGeos?: Geo[]): Promise<CacheEntry> {
    // REST pre-check: fails fast with 404 → WanderlogNotFoundError.
    // Without this, a bogus trip key hangs on the WS subscribe timeout.
    // The response also gives us the trip's associated geos, which the
    // WebSocket snapshot doesn't include — we store them for search biasing.
    const geos = knownGeos ?? (await this.rest.getTripWithResources(tripKey)).geos;

    const client = this.pool.get(tripKey);
    try {
      const snapshot = await client.subscribe();

      const remoteOpListener = (ops: Json0Op[], version: number) => {
        const current = this.entries.get(tripKey);
        if (!current || current.client !== client) return;
        try {
          current.snapshot = applyOp(current.snapshot, ops);
          current.version = version;
        } catch {
          this.deleteEntry(tripKey);
        }
      };
      const closedListener = () => {
        if (this.entries.get(tripKey)?.client === client) {
          // Retiring the client suppresses background resubscription, which
          // could otherwise refresh the client without refreshing this cache.
          this.deleteEntry(tripKey);
        }
      };

      client.on("remoteOp", remoteOpListener);
      client.on("closed", closedListener);

      if (!client.isSubscribed) {
        client.off("remoteOp", remoteOpListener);
        client.off("closed", closedListener);
        throw new WanderlogError(
          `Trip ${tripKey} subscription closed before it could be cached`,
          "ws_closed",
        );
      }

      const entry: CacheEntry = {
        snapshot,
        version: client.version,
        geos,
        client,
        remoteOpListener,
        closedListener,
        lastUsedAt: Date.now(),
      };
      this.entries.set(tripKey, entry);
      this.ensureSweep();
      return entry;
    } catch (err) {
      this.pool.evict(tripKey, client);
      throw err;
    }
  }

  /**
   * Called after submitting an op ourselves. Applies the op locally and
   * bumps the version so the cache matches what the server just accepted.
   */
  applyLocalOp(tripKey: string, ops: Json0Op[], newVersion: number): void {
    const entry = this.entries.get(tripKey);
    if (!entry) return;
    entry.snapshot = applyOp(entry.snapshot, ops);
    entry.version = newVersion;
  }

  private deleteEntry(tripKey: string): void {
    const entry = this.entries.get(tripKey);
    if (!entry) return;
    entry.client.off("remoteOp", entry.remoteOpListener);
    entry.client.off("closed", entry.closedListener);
    this.entries.delete(tripKey);
    this.pool.evict(tripKey, entry.client);
  }

  /**
   * Each cached trip holds an open socket for the life of the process, and a
   * long-lived MCP session touches many trips. Close the ones nobody used for
   * a while; the next access resubscribes.
   */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.evictIdle(), 5 * 60_000);
    this.sweepTimer.unref();
  }

  evictIdle(now = Date.now()): void {
    for (const [tripKey, entry] of this.entries) {
      if (now - (entry.lastUsedAt ?? now) > IDLE_EVICT_MS) this.deleteEntry(tripKey);
    }
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  invalidate(tripKey: string): void {
    this.deleteEntry(tripKey);
  }

  clear(): void {
    for (const tripKey of this.entries.keys()) {
      this.deleteEntry(tripKey);
    }
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}
