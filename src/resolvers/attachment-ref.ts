import type { Section, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";

/**
 * Wanderlog stores uploaded files at trip scope (via a server-generated
 * storage key) and places reference them through their `attachments` arrays.
 * One file can be referenced by multiple places.
 *
 * This resolver walks every block in the trip, deduplicates attachments by
 * key, and tracks which places reference each one — so we can:
 *   - list the trip's "attachment library" for the LLM
 *   - resolve a free-form ref ("ticket.pdf", or the raw key) to a single file
 *     so attach_file can link an existing upload to another place
 *     instead of re-uploading the bytes.
 */
export type AttachmentInfo = {
  key: string;
  fileName: string;
  contentType: string;
  /** Wanderlog uses "file" for uploads. Other types may exist for embeds. */
  type: string;
  /** Places that currently reference this attachment. */
  places: Array<{ sectionIndex: number; blockIndex: number; placeName: string; section: Section }>;
};

export type AttachmentRefResult =
  | { kind: "unique"; match: AttachmentInfo }
  | { kind: "ambiguous"; candidates: AttachmentInfo[] }
  | { kind: "none" };

const MAX_AMBIGUOUS = 10;

export function listTripAttachments(trip: TripPlan): AttachmentInfo[] {
  const byKey = new Map<string, AttachmentInfo>();
  for (let si = 0; si < trip.itinerary.sections.length; si++) {
    const section = trip.itinerary.sections[si]!;
    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi]!;
      const atts = (block as unknown as { attachments?: unknown }).attachments;
      if (!Array.isArray(atts)) continue;
      const placeName = isPlaceBlock(block) ? block.place.name : `${block.type} block`;
      for (const a of atts) {
        if (typeof a !== "object" || a === null) continue;
        const aa = a as Record<string, unknown>;
        const key = aa.key;
        if (typeof key !== "string") continue;
        let info = byKey.get(key);
        if (!info) {
          info = {
            key,
            fileName: typeof aa.fileName === "string" ? aa.fileName : "(unnamed)",
            contentType: typeof aa.contentType === "string" ? aa.contentType : "",
            type: typeof aa.type === "string" ? aa.type : "file",
            places: [],
          };
          byKey.set(key, info);
        }
        info.places.push({ sectionIndex: si, blockIndex: bi, placeName, section });
      }
    }
  }
  return Array.from(byKey.values());
}

/**
 * Resolves a free-form attachment ref against an already-uploaded file in the
 * trip. Tries in order:
 *   1. Exact key match (storage keys are long random strings, hard to type by
 *      accident, so this is intentional and short-circuits).
 *   2. Exact filename match (case-insensitive).
 *   3. Substring of filename (case-insensitive).
 */
export function resolveAttachmentRef(trip: TripPlan, ref: string): AttachmentRefResult {
  const attachments = listTripAttachments(trip);
  if (attachments.length === 0) return { kind: "none" };
  const trimmed = ref.trim();
  if (!trimmed) return { kind: "none" };

  const byKey = attachments.find((a) => a.key === trimmed);
  if (byKey) return { kind: "unique", match: byKey };

  const lower = trimmed.toLowerCase();
  const exact = attachments.filter((a) => a.fileName.toLowerCase() === lower);
  if (exact.length === 1) return { kind: "unique", match: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.slice(0, MAX_AMBIGUOUS) };

  const substr = attachments.filter((a) => a.fileName.toLowerCase().includes(lower));
  if (substr.length === 1) return { kind: "unique", match: substr[0]! };
  if (substr.length > 1) return { kind: "ambiguous", candidates: substr.slice(0, MAX_AMBIGUOUS) };

  return { kind: "none" };
}
