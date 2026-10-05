import { isPlaceBlock, type PlaceData, type Section } from "../types.js";
import { extractDeltaText } from "./remove-note.js";

/**
 * Duplicate guards for the insert tools (idea from samihsq@fc71ee8).
 *
 * A submit can fail ambiguously — the socket drops or the ack times out after
 * the server already applied the op. The agent sees an error, retries, and the
 * trip ends up with two identical blocks. These checks run against a fresh
 * snapshot inside the submit lock and turn that retry into a no-op. A real
 * second visit is still possible: callers pass allow_duplicate.
 */

const slot = (time: string | null | undefined): string | undefined => time?.trim() || undefined;

const normalizeName = (name: string): string =>
  name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Google's place_id is the identity that survives transliteration and chain
 * branches, so it decides whenever both sides have one; the name is the
 * fallback for blocks added by hand in the UI.
 */
function samePlace(a: PlaceData | undefined, b: PlaceData): boolean {
  if (!a) return false;
  if (a.place_id && b.place_id) return a.place_id === b.place_id;
  const nameA = normalizeName(a.name ?? "");
  return nameA.length > 0 && nameA === normalizeName(b.name ?? "");
}

/** Same place, same section, same start time (both unset counts as the same). */
export function findDuplicatePlace(
  section: Section,
  place: PlaceData,
  startTime?: string,
): { blockIndex: number } | undefined {
  const wanted = slot(startTime);
  const blockIndex = section.blocks.findIndex(
    (block) =>
      isPlaceBlock(block) && samePlace(block.place, place) && slot(block.startTime) === wanted,
  );
  return blockIndex >= 0 ? { blockIndex } : undefined;
}

/** A note in the section whose text is identical (ignoring surrounding whitespace). */
export function findDuplicateNote(
  section: Section,
  text: string,
): { blockIndex: number } | undefined {
  const wanted = text.trim();
  if (wanted.length === 0) return undefined;
  const blockIndex = section.blocks.findIndex(
    (block) =>
      block.type === "note" &&
      extractDeltaText((block as { text?: Parameters<typeof extractDeltaText>[0] }).text).trim() ===
        wanted,
  );
  return blockIndex >= 0 ? { blockIndex } : undefined;
}

export const ALLOW_DUPLICATE_HINT =
  "If a second identical entry is really intended (e.g. the hotel at the start and end of a day), call again with allow_duplicate: true.";
