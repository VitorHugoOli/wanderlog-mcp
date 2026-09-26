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
