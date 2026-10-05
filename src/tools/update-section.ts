import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { VALID_PLACE_MARKER_ICONS } from "../types.js";
import { isCustomSection, resolveSectionRef, submitOp } from "./shared.js";

export const updateSectionInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the section to update."),
  section: z
    .string()
    .min(1)
    .describe(
      "The section to update, identified by its current heading (e.g. 'Food & Drink', 'Places to visit'). Use wanderlog_get_trip to see available sections.",
    ),
  heading: z
    .string()
    .optional()
    .describe(
      'New heading for the section. Pass "" (empty string) to clear it back to an untitled section.',
    ),
  place_marker_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #e74c3c")
    .optional()
    .describe("New map-marker color for the list's places, as hex (e.g. '#e74c3c')."),
  place_marker_icon: z
    .enum(VALID_PLACE_MARKER_ICONS)
    .optional()
    .describe(`New map-marker icon for the list's places: ${VALID_PLACE_MARKER_ICONS.join(", ")}.`),
};

export const updateSectionDescription = `
Renames a custom section (list) in a Wanderlog trip and/or changes the color and icon of its
places' map markers.

Identify the section by its current heading. Use wanderlog_get_trip to see all sections and
their current headings if you are unsure. Pass an empty string for "heading" to clear the
section title.

Returns a confirmation showing the old and new heading.
The current heading must identify exactly one section and the new heading must not duplicate
another undated section.
`.trim();

type Args = {
  trip_key: string;
  section: string;
  heading?: string;
  place_marker_color?: string;
  place_marker_icon?: (typeof VALID_PLACE_MARKER_ICONS)[number];
};

export async function updateSection(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const newHeading = args.heading;
    if (
      newHeading === undefined &&
      args.place_marker_color === undefined &&
      args.place_marker_icon === undefined
    ) {
      throw new WanderlogValidationError(
        "Give at least one of heading, place_marker_color or place_marker_icon.",
      );
    }
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const resolved = resolveSectionRef(trip, args.section);
      if (resolved.kind === "none") {
        throw new WanderlogValidationError(
          `Section "${args.section}" not found in trip "${trip.title}". Use wanderlog_get_trip to see available sections.`,
        );
      }
      if (resolved.kind === "ambiguous") {
        throw new WanderlogValidationError(
          `Section reference "${args.section}" is ambiguous: ${resolved.candidates.length} sections have that heading. Rename the duplicates in Wanderlog before retrying.`,
        );
      }
      const found = resolved.match;
      const { index, section } = found;
      if (!isCustomSection(trip, index)) {
        const reason =
          section.mode === "dayPlan"
            ? `Day sections cannot be renamed here. Use wanderlog_rename_day to change a day's heading instead.`
            : section.heading === "Places to visit"
              ? `The "Places to visit" section cannot be renamed — it is the trip's default place list. Use wanderlog_get_trip to see your custom sections.`
              : `The "${section.heading || section.type}" section is a system section and cannot be renamed. Use wanderlog_get_trip to see your custom sections.`;
        throw new WanderlogValidationError(reason);
      }
      const oldHeading = section.heading;
      const ops: Json0Op[] = [];
      const changes: string[] = [];
      if (newHeading !== undefined && newHeading !== oldHeading) {
        const normalizedHeading = newHeading.trim().toLowerCase();
        const duplicate =
          normalizedHeading === "places" ||
          normalizedHeading === "places to visit" ||
          trip.itinerary.sections.some(
            (candidate) =>
              candidate.id !== section.id &&
              candidate.mode !== "dayPlan" &&
              candidate.heading.trim().toLowerCase() === normalizedHeading,
          );
        if (duplicate) {
          throw new WanderlogValidationError(
            `A different section named "${newHeading || "(untitled)"}" already exists. Choose a unique heading so future mutations can target it safely.`,
          );
        }
        ops.push({
          p: ["itinerary", "sections", index, "heading"],
          od: oldHeading,
          oi: newHeading,
        });
        changes.push(`renamed "${oldHeading || "(untitled)"}" → "${newHeading || "(untitled)"}"`);
      }
      // od only when the key exists: an od for a missing key corrupts the
      // document (the upstream UI-crash bug class).
      const setField = (key: "placeMarkerColor" | "placeMarkerIcon", value: string) =>
        ops.push(
          key in section
            ? { p: ["itinerary", "sections", index, key], od: section[key], oi: value }
            : { p: ["itinerary", "sections", index, key], oi: value },
        );
      if (args.place_marker_color && args.place_marker_color !== section.placeMarkerColor) {
        setField("placeMarkerColor", args.place_marker_color);
        changes.push(`marker color ${args.place_marker_color}`);
      }
      if (args.place_marker_icon && args.place_marker_icon !== section.placeMarkerIcon) {
        setField("placeMarkerIcon", args.place_marker_icon);
        changes.push(`marker icon ${args.place_marker_icon}`);
      }
      if (ops.length === 0) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `Section "${oldHeading || "(untitled)"}" already looks like that — no change made.`,
              },
            ],
          },
        };
      }
      await submit(ops);
      return { oldHeading, changes, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;

    const text = `Updated section "${result.oldHeading || "(untitled)"}" in "${result.tripTitle}": ${result.changes.join(", ")}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
