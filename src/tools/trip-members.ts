import type { Contributor, TripPlan } from "../types.js";

/** The people on a trip (owner and tripmates), read-only — used to attribute shared expenses. */
export function collaboratorsOf(trip: TripPlan): Contributor[] {
  const byId = new Map<number, Contributor>();
  for (const c of [...(trip.contributors ?? []), ...(trip.editors ?? [])]) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/**
 * Match a free-form reference ("Ali", "@ali1253", "ali@example.com") against
 * the trip's collaborators by username, display name, or exact id.
 */
export function findCollaborator(
  trip: TripPlan,
  ref: string,
):
  | { kind: "unique"; user: Contributor }
  | { kind: "ambiguous"; users: Contributor[] }
  | { kind: "none" } {
  const q = ref.trim().replace(/^@/, "").toLowerCase();
  if (!q) return { kind: "none" };
  const all = collaboratorsOf(trip);
  const exact = all.filter(
    (c) =>
      c.username.toLowerCase() === q || (c.name ?? "").toLowerCase() === q || String(c.id) === q,
  );
  if (exact.length === 1) return { kind: "unique", user: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", users: exact };
  const partial = all.filter(
    (c) => c.username.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q),
  );
  if (partial.length === 1) return { kind: "unique", user: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", users: partial };
  return { kind: "none" };
}
