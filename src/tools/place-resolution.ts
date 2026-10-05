import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Geo, PlaceData, PlaceSuggestion } from "../types.js";

/*
 * Place-query resolution (scoring and search radius ported from
 * samihsq@adbd278; the decision policy is ours).
 *
 * Google autocomplete's top hit is usually right, but sometimes it is a
 * different business at the queried address — a clothing shop came back as
 * the office building next door. Google's ranking stays the default; a name
 * score is only used to catch the top hit being implausible while a clearly
 * better-named candidate exists, and to surface near-ties.
 */

/** Day trips are normal (Kamakura is ~50km from Tokyo), so bias wide. */
const DEFAULT_SEARCH_RADIUS_M = 100_000;
const MAX_SEARCH_RADIUS_M = 500_000;
/** Half the earth's circumference: a bias this wide is no bias at all. */
const UNBIASED_SEARCH_RADIUS_M = 20_000_000;
/** The radius these tools shipped with, kept as a degradation target. */
const LEGACY_SEARCH_RADIUS_M = 15_000;
const FAR_FROM_CENTER_KM = 50;
/** Name score from which a candidate is a plausible answer to the query. */
const CONFIDENT_SCORE = 0.6;
/** Score gap under which two plausible candidates are worth mentioning. */
const TIE_GAP = 0.1;
const MAX_PLACE_CANDIDATES = 5;

/** Fold case, Latin accents and punctuation: "Sensō-ji" ~ "senso ji". */
export function normalizePlaceText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Bare numbers are dropped: they match every business at a street address. */
function placeTokens(text: string): string[] {
  return normalizePlaceText(text)
    .split(" ")
    .filter((token) => token.length > 0 && !/^\d+$/.test(token));
}

/**
 * How plausibly `candidate` names the place `query` asked for, 0–1: the
 * better of a token Dice coefficient (penalizes the extra words of a wrong
 * branch) and a squashed-substring length ratio (catches "Senso-ji" vs
 * "Sensoji").
 */
export function placeMatchScore(query: string, candidate: string): number {
  const queryTokens = new Set(placeTokens(query));
  const candidateTokens = new Set(placeTokens(candidate));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  const querySquashed = [...queryTokens].join("");
  const candidateSquashed = [...candidateTokens].join("");
  if (querySquashed === candidateSquashed) return 1;

  let shared = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) shared += 1;
  const dice = (2 * shared) / (queryTokens.size + candidateTokens.size);

  const nested =
    candidateSquashed.includes(querySquashed) || querySquashed.includes(candidateSquashed);
  const containment = nested
    ? Math.min(querySquashed.length, candidateSquashed.length) /
      Math.max(querySquashed.length, candidateSquashed.length)
    : 0;
  return Math.max(dice, containment);
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Wide enough for day trips, widened to span a regional/country geo's bounds. */
export function tripSearchRadiusM(geos?: Geo[]): number {
  let radius = DEFAULT_SEARCH_RADIUS_M;
  for (const geo of geos ?? []) {
    const bounds = geo.bounds;
    if (!bounds) continue;
    const [minLng, minLat, maxLng, maxLat] = bounds;
    if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) continue;
    if (Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) continue;
    const halfDiagonalM =
      (haversineKm({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng }) * 1000) / 2;
    radius = Math.max(radius, halfDiagonalM);
  }
  return Math.min(Math.round(radius), MAX_SEARCH_RADIUS_M);
}

export function suggestionName(suggestion: PlaceSuggestion): string {
  const main = suggestion.structured_formatting?.main_text?.trim();
  if (main) return main;
  return (suggestion.description ?? "").split(",")[0]!.trim();
}

export function suggestionAddress(suggestion: PlaceSuggestion): string {
  const secondary = suggestion.structured_formatting?.secondary_text?.trim();
  if (secondary) return secondary;
  return (suggestion.description ?? "").split(",").slice(1).join(",").trim();
}

/** Biased search first; if that finds nothing (e.g. a far day trip), unbiased. */
async function autocompleteWithFallback(
  ctx: AppContext,
  query: string,
  center: { lat: number; lng: number },
  radiusM: number,
): Promise<{ predictions: PlaceSuggestion[]; unbiased: boolean }> {
  const search = (radius: number) =>
    ctx.rest.searchPlacesAutocomplete({
      input: query,
      sessionToken: randomUUID(),
      location: { latitude: center.lat, longitude: center.lng },
      radius,
    });

  let biased: PlaceSuggestion[];
  try {
    biased = await search(radiusM);
  } catch (err) {
    if (radiusM <= LEGACY_SEARCH_RADIUS_M) throw err;
    biased = await search(LEGACY_SEARCH_RADIUS_M);
  }
  if (biased.length > 0) return { predictions: biased, unbiased: false };
  try {
    return { predictions: await search(UNBIASED_SEARCH_RADIUS_M), unbiased: true };
  } catch {
    return { predictions: [], unbiased: false };
  }
}

export type PlaceCandidate = { suggestion: PlaceSuggestion; name: string; score: number };

export type PlaceQueryOutcome =
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: PlaceCandidate[] }
  | {
      kind: "resolved";
      detail: PlaceData;
      /** Lines to append to the confirmation (near-ties, distance, description match). */
      notes: string[];
    };

export async function resolvePlaceQuery(
  ctx: AppContext,
  query: string,
  center: { lat: number; lng: number },
  geos?: Geo[],
): Promise<PlaceQueryOutcome> {
  const { predictions, unbiased } = await autocompleteWithFallback(
    ctx,
    query,
    center,
    tripSearchRadiusM(geos),
  );
  if (predictions.length === 0) return { kind: "none" };

  const candidates: PlaceCandidate[] = predictions.map((suggestion) => {
    const name = suggestionName(suggestion);
    return { suggestion, name, score: placeMatchScore(query, name) };
  });
  const top = candidates[0]!;
  const detail = await ctx.rest.getPlaceDetails(top.suggestion.place_id);
  // A prediction's main_text is sometimes an abbreviated or localized name.
  const topScore = Math.max(top.score, placeMatchScore(query, detail.name ?? ""));
  const others = candidates.slice(1);
  const bestOther = others.reduce<PlaceCandidate | undefined>(
    (best, c) => (!best || c.score > best.score ? c : best),
    undefined,
  );

  if (topScore < CONFIDENT_SCORE && bestOther && bestOther.score >= CONFIDENT_SCORE) {
    // Google's first hit does not look like what was asked for, but another
    // result does: the office-building-next-door case. Let the caller choose.
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    return { kind: "ambiguous", candidates: ranked.slice(0, MAX_PLACE_CANDIDATES) };
  }

  const notes: string[] = [];
  if (topScore < CONFIDENT_SCORE) {
    notes.push(`Matched by description, not by name — check it is the place you meant.`);
  } else {
    const nearTies = others
      .filter((c) => c.score >= CONFIDENT_SCORE && topScore - c.score < TIE_GAP)
      .slice(0, 3);
    if (nearTies.length > 0) {
      const list = nearTies
        .map((c) => {
          const address = suggestionAddress(c.suggestion);
          return `${c.name}${address ? ` (${address})` : ""}`;
        })
        .join("; ");
      notes.push(
        `Other places match "${query}" about as well: ${list}. If the wrong one was picked, remove it and re-add using place_id from wanderlog_search_places (response_format "detailed").`,
      );
    }
  }
  const location = detail.geometry?.location;
  const distanceKm = location ? haversineKm(center, location) : null;
  if (distanceKm !== null && distanceKm >= FAR_FROM_CENTER_KM) {
    notes.push(
      `It is ${Math.round(distanceKm)} km from the trip center${unbiased ? " (found without location bias)" : ""} — confirm this is the intended city.`,
    );
  }
  return { kind: "resolved", detail, notes };
}

export function placeAmbiguityError(
  query: string,
  tripTitle: string,
  candidates: PlaceCandidate[],
  toolName: string,
): WanderlogError {
  const list = candidates
    .map((c, i) => {
      const address = suggestionAddress(c.suggestion);
      return `  ${i + 1}. ${c.name}${address ? ` (${address})` : ""}`;
    })
    .join("\n");
  return new WanderlogError(
    `The top search result for "${query}" does not look like that place, so nothing was added to "${tripTitle}". Closest matches:\n${list}`,
    "place_ambiguous",
    {
      followUps: [
        `Re-call ${toolName} with the exact name of the right one from this list, or with its place_id from wanderlog_search_places (response_format "detailed").`,
      ],
    },
  );
}
