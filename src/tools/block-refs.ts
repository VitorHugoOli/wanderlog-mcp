import { WanderlogValidationError } from "../errors.js";
import { resolvePlaceRef, type PlaceRefMatch } from "../resolvers/place-ref.js";
import type { Block, Section, TripPlan } from "../types.js";
import { isPlaceBlock, isTransitBlock } from "../types.js";

/** Resolve a natural-language block reference to exactly one block, or explain why not. */
export function resolveUniqueBlock(trip: TripPlan, ref: string, label: string): PlaceRefMatch {
  const result = resolvePlaceRef(trip, ref);
  if (result.kind === "none") {
    throw new WanderlogValidationError(
      `No itinerary block matching "${ref}" was found in "${trip.title}".`,
      "Use wanderlog_get_trip to inspect the current itinerary, then retry with a more specific name or role.",
    );
  }
  if (result.kind === "ambiguous") {
    const candidates = result.candidates
      .map(
        (candidate, index) =>
          `  ${index + 1}. ${blockName(candidate.block)} — ${formatSection(candidate.section)}`,
      )
      .join("\n");
    throw new WanderlogValidationError(
      `The ${label} reference "${ref}" is ambiguous:\n${candidates}`,
      `Retry with an ordinal prefix such as "1st ${ref}" or add a day filter.`,
    );
  }
  return result.match;
}

/**
 * The same resolution restricted to one section, so a name that also appears
 * on other days does not make the reference ambiguous. Indices in the result
 * are those of the real trip.
 */
export function resolveUniqueBlockInSection(
  trip: TripPlan,
  sectionIndex: number,
  ref: string,
  label: string,
): PlaceRefMatch {
  const scoped: TripPlan = {
    ...trip,
    itinerary: {
      ...trip.itinerary,
      sections: trip.itinerary.sections.map((section, index) =>
        index === sectionIndex ? section : { ...section, blocks: [] },
      ),
    },
  };
  return resolveUniqueBlock(scoped, ref, label);
}

export function blockName(block: Block): string {
  if (isPlaceBlock(block)) return block.place.name;
  if (block.type === "flight") {
    const flightInfo = "flightInfo" in block ? block.flightInfo : undefined;
    const airline = flightInfo?.airline?.iata;
    const number = flightInfo?.number;
    return airline || number ? `${airline ?? ""}${number ?? ""} flight` : "flight";
  }
  if (isTransitBlock(block)) {
    return block.carrier ? `${block.carrier} ${block.type}` : block.type;
  }
  if (block.type === "rentalCar") return "rental car";
  return `${block.type} block`;
}

export function formatSection(section: Section): string {
  if (section.mode === "dayPlan" && section.date) {
    return `day ${section.date}`;
  }
  return `"${section.heading || section.type}"`;
}
