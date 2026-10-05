import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestClient } from "../../src/transport/rest.ts";

describe("RestClient.searchPlacesAutocomplete", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function search(data: unknown) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    return new RestClient({
      cookieHeader: "connect.sid=test",
      baseUrl: "https://wanderlog.test",
      wsBaseUrl: "wss://wanderlog.test",
      userAgent: "wanderdog-test",
    }).searchPlacesAutocomplete({
      input: "queenstown gardens",
      sessionToken: "session",
      location: { latitude: -45.0312, longitude: 168.6626 },
      radius: 15000,
    });
  }

  it("drops an entry with no place_id so the first result is a real place", async () => {
    const predictions = await search([
      {},
      { description: "Queenstown Gardens", place_id: "ChIJgardens" },
    ]);
    expect(predictions.map((p) => p.place_id)).toEqual(["ChIJgardens"]);
  });

  it("drops entries whose place_id is empty or not a string", async () => {
    const predictions = await search([
      { description: "empty", place_id: "" },
      { description: "number", place_id: 42 },
      { description: "null", place_id: null },
      { description: "ok", place_id: "ChIJok" },
    ]);
    expect(predictions.map((p) => p.place_id)).toEqual(["ChIJok"]);
  });

  it("keeps usable results in their original order", async () => {
    const predictions = await search([
      { description: "A", place_id: "a" },
      { description: "junk" },
      { description: "B", place_id: "b" },
    ]);
    expect(predictions.map((p) => p.place_id)).toEqual(["a", "b"]);
  });

  it("returns an empty list when nothing usable comes back", async () => {
    expect(await search([{}, { description: "no id" }])).toEqual([]);
    expect(await search(undefined)).toEqual([]);
  });
});

describe("RestClient rate limiting", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("retries a 429 and succeeds once Wanderlog lets it through", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, user: { id: 5, username: "u" } }), {
          status: 200,
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const rest = new RestClient({
      cookieHeader: "c",
      baseUrl: "https://x",
      userAgent: "t",
    } as never);

    const user = rest.getUser();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(user).resolves.toMatchObject({ id: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up with a clear rate_limited error after the retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 429 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const rest = new RestClient({
      cookieHeader: "c",
      baseUrl: "https://x",
      userAgent: "t",
    } as never);

    const user = rest.getUser();
    const failed = expect(user).rejects.toMatchObject({ code: "rate_limited" });
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("RestClient Retry-After cap", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("never waits longer than the cap even if Retry-After asks for more", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, user: { id: 5, username: "u" } }), {
          status: 200,
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const rest = new RestClient({
      cookieHeader: "c",
      baseUrl: "https://x",
      userAgent: "t",
    } as never);
    const user = rest.getUser();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(user).resolves.toMatchObject({ id: 5 });
  });
});
