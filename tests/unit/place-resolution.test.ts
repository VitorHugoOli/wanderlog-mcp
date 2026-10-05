import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import {
  placeMatchScore,
  resolvePlaceQuery,
  tripSearchRadiusM,
} from "../../src/tools/place-resolution.ts";
import type { Geo, PlaceSuggestion } from "../../src/types.ts";

const CENTER = { lat: 35.68, lng: 139.76 };

const suggestion = (place_id: string, main: string, secondary = ""): PlaceSuggestion =>
  ({
    place_id,
    description: `${main}, ${secondary}`,
    structured_formatting: { main_text: main, secondary_text: secondary },
  }) as PlaceSuggestion;

function ctxWith(
  responses: PlaceSuggestion[][],
  details: Record<string, { name: string; lat?: number; lng?: number }>,
) {
  const autocomplete = vi.fn(async () => responses.shift() ?? []);
  const ctx = {
    rest: {
      searchPlacesAutocomplete: autocomplete,
      getPlaceDetails: async (id: string) => {
        const d = details[id]!;
        return {
          place_id: id,
          name: d.name,
          geometry: { location: { lat: d.lat ?? CENTER.lat, lng: d.lng ?? CENTER.lng } },
        };
      },
    },
  } as unknown as AppContext;
  return { ctx, autocomplete };
}

describe("placeMatchScore", () => {
  it("scores identical, accent- and spacing-different names as matches", () => {
    expect(placeMatchScore("Sensō-ji", "senso ji")).toBe(1);
    expect(placeMatchScore("Sensoji", "Senso-ji")).toBe(1);
    expect(placeMatchScore("Louvre", "Louvre Museum")).toBeGreaterThanOrEqual(0.6);
  });

  it("gives an unrelated business at the same address no credit for the street number", () => {
    expect(placeMatchScore("Chicago Harajuku 6-31-15 Jingumae", "Accorde Jingumae")).toBeLessThan(
      0.6,
    );
  });
});

describe("tripSearchRadiusM", () => {
  it("defaults wide enough for day trips and widens for regional geos, capped", () => {
    expect(tripSearchRadiusM()).toBe(100_000);
    const chile = { bounds: [-75.6, -55.9, -66.4, -17.5] } as Geo;
    expect(tripSearchRadiusM([chile])).toBe(500_000);
  });
});

describe("resolvePlaceQuery policy", () => {
  it("keeps Google's top hit when it plausibly is the place", async () => {
    const { ctx } = ctxWith(
      [[suggestion("museum", "Louvre Museum", "Paris"), suggestion("shop", "Louvre Gift Shop")]],
      { museum: { name: "Louvre Museum" } },
    );
    const outcome = await resolvePlaceQuery(ctx, "Louvre", CENTER);
    expect(outcome).toMatchObject({ kind: "resolved", detail: { place_id: "museum" } });
  });

  it("refuses when the top hit is implausible but another result matches the name", async () => {
    const { ctx } = ctxWith(
      [
        [
          suggestion("office", "Accorde Jingumae", "Shibuya"),
          suggestion("shop", "Chicago Harajuku", "Jingumae, Shibuya"),
        ],
      ],
      { office: { name: "Accorde Jingumae" } },
    );
    const outcome = await resolvePlaceQuery(ctx, "Chicago Harajuku 6-31-15 Jingumae", CENTER);
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind === "ambiguous") expect(outcome.candidates[0]!.name).toBe("Chicago Harajuku");
  });

  it("resolves a near-tie to the top hit but names the alternatives", async () => {
    const { ctx } = ctxWith(
      [
        [
          suggestion("a", "2nd STREET Shimokitazawa Instruments", "Setagaya"),
          suggestion("b", "2nd STREET Shimokitazawa Clothing", "Setagaya"),
        ],
      ],
      { a: { name: "2nd STREET Shimokitazawa Instruments" } },
    );
    const outcome = await resolvePlaceQuery(ctx, "2nd STREET Shimokitazawa", CENTER);
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") {
      expect(outcome.notes.join(" ")).toContain("2nd STREET Shimokitazawa Clothing (Setagaya)");
    }
  });

  it("keeps a descriptive query working, flagged as matched by description", async () => {
    const { ctx } = ctxWith([[suggestion("r", "Ichiran Shinjuku", "Shinjuku")]], {
      r: { name: "Ichiran Shinjuku" },
    });
    const outcome = await resolvePlaceQuery(ctx, "a ramen place", CENTER);
    expect(outcome).toMatchObject({ kind: "resolved", detail: { place_id: "r" } });
    if (outcome.kind === "resolved") expect(outcome.notes[0]).toContain("Matched by description");
  });

  it("retries without location bias and says how far the result is", async () => {
    const { ctx, autocomplete } = ctxWith(
      [[], [suggestion("beach", "Yuigahama Beach", "Kamakura")]],
      { beach: { name: "Yuigahama Beach", lat: 35.0, lng: 138.9 } },
    );
    const outcome = await resolvePlaceQuery(ctx, "Yuigahama Beach", CENTER);
    expect(autocomplete).toHaveBeenCalledTimes(2);
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.notes.join(" ")).toMatch(
      /\d+ km from the trip center \(found without location bias\)/,
    );
  });

  it("reports none when even the unbiased search is empty", async () => {
    const { ctx } = ctxWith([[], []], {});
    expect(await resolvePlaceQuery(ctx, "zzzz", CENTER)).toEqual({ kind: "none" });
  });
});

describe("Phase 3 review regressions", () => {
  it("accepts a bare name whose words all appear in the top hit (Narita → airport)", async () => {
    const { ctx } = ctxWith(
      [
        [
          suggestion("nrt", "Narita International Airport", "Chiba"),
          suggestion("city", "Narita", "Chiba"),
        ],
      ],
      { nrt: { name: "Narita International Airport" } },
    );
    const outcome = await resolvePlaceQuery(ctx, "Narita", CENTER);
    expect(outcome).toMatchObject({ kind: "resolved", detail: { place_id: "nrt" } });
  });
});
