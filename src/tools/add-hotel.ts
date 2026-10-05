import { z } from "zod";
import { placeAmbiguityError, resolvePlaceQuery } from "./place-resolution.js";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { PlaceData } from "../types.js";
import {
  buildPlaceBlock,
  findHotelsSection,
  findTripCenter,
  requireUserId,
  submitOp,
  validateTimeInputs,
} from "./shared.js";

export const addHotelInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the hotel to."),
  hotel: z
    .string()
    .min(1)
    .describe(
      "Hotel name to search for. Examples: 'Park Hyatt Tokyo', 'the cheap hostel near the train station'. Matched against Google Places near the trip's destination.",
    ),
  check_in: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Check-in date, YYYY-MM-DD."),
  check_out: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Check-out date, YYYY-MM-DD. Must be after check_in."),
  confirmation_number: z
    .string()
    .optional()
    .describe("Optional booking confirmation / reference number."),
  traveler_names: z.array(z.string()).optional().describe("Optional guest names for this booking."),
  check_in_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional check-in time, HH:mm (e.g. '15:00')."),
  check_out_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional check-out time, HH:mm (e.g. '11:00')."),
};

export const addHotelDescription = `
Adds a hotel booking to a Wanderlog trip with check-in and check-out dates. If the trip does
not yet have a "Hotels and lodging" section, one is created automatically.

Returns confirmation with the resolved hotel name and the booking window.
`.trim();

type Args = {
  trip_key: string;
  hotel: string;
  check_in: string;
  check_out: string;
  confirmation_number?: string;
  traveler_names?: string[];
  check_in_time?: string;
  check_out_time?: string;
};

export async function addHotel(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (args.check_out <= args.check_in) {
      throw new WanderlogValidationError(
        `check_out (${args.check_out}) must be after check_in (${args.check_in})`,
      );
    }

    // Separately: check-out (11:00) is normally earlier in the day than check-in (15:00).
    validateTimeInputs(args.check_in_time);
    validateTimeInputs(args.check_out_time);
    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const center = findTripCenter(entry.snapshot, entry.geos);
    if (!center) {
      throw new WanderlogValidationError(
        `Cannot add hotel to "${entry.snapshot.title}" because no location anchor is available`,
        "This trip has no associated geo and no existing places.",
      );
    }

    const outcome = await resolvePlaceQuery(ctx, args.hotel, center, entry.geos);
    if (outcome.kind === "none") {
      throw new WanderlogError(
        `No hotel found matching "${args.hotel}" near ${entry.snapshot.title}`,
        "hotel_not_found",
        "Try a more specific name or check the spelling.",
      );
    }
    if (outcome.kind === "ambiguous") {
      throw placeAmbiguityError(
        args.hotel,
        entry.snapshot.title,
        outcome.candidates,
        "wanderlog_add_hotel",
      );
    }
    const detail: PlaceData = outcome.detail;
    const resolutionNotes = outcome.notes;
    const imageKeys = await ctx.rest.getPlacePhotos(detail);

    const tripTitle = await submitOp(ctx, args.trip_key, async (lockedEntry, submit) => {
      const trip = lockedEntry.snapshot;
      const block = buildPlaceBlock(detail, userId, {
        hotel: {
          checkIn: args.check_in,
          checkOut: args.check_out,
          travelerNames: args.traveler_names ?? [],
          confirmationNumber: args.confirmation_number ?? null,
        },
      });
      const existing = findHotelsSection(trip);
      const sectionIndex = existing ? existing.index : Math.min(1, trip.itinerary.sections.length);
      const blockPath = existing
        ? ["itinerary", "sections", sectionIndex, "blocks", existing.section.blocks.length]
        : ["itinerary", "sections", sectionIndex, "blocks", 0];
      const ops: Json0Op[] = existing
        ? [{ p: blockPath, li: block }]
        : [
            {
              p: ["itinerary", "sections", sectionIndex],
              li: {
                id: Math.floor(Math.random() * 1_000_000_000),
                type: "hotels",
                mode: "placeList",
                heading: "Hotels and lodging",
                date: null,
                blocks: [block],
                placeMarkerColor: "#7045af",
                placeMarkerIcon: "bed",
                text: { ops: [{ insert: "\n" }] },
              },
            },
          ];
      if (imageKeys.length > 0) {
        ops.push({ p: [...blockPath, "imageKeys"], oi: imageKeys });
      }
      // Times as plain oi after the insert, in the same submit (the UI's shape;
      // fields from shadowalkerz1@8740ac4).
      if (args.check_in_time) ops.push({ p: [...blockPath, "startTime"], oi: args.check_in_time });
      if (args.check_out_time) ops.push({ p: [...blockPath, "endTime"], oi: args.check_out_time });
      await submit(ops);
      return trip.title;
    });

    const where = detail.formatted_address ? ` (${detail.formatted_address})` : "";
    const text = [
      `Added ${detail.name}${where} to "${tripTitle}" · check-in ${args.check_in}${args.check_in_time ? ` ${args.check_in_time}` : ""} → check-out ${args.check_out}${args.check_out_time ? ` ${args.check_out_time}` : ""}.`,
      ...resolutionNotes,
    ].join(" ");
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
