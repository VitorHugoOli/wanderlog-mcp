import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";

export const deleteTripInputSchema = {
  trip_key: z.string().min(1).describe("The trip to delete permanently."),
  confirm_title: z
    .string()
    .min(1)
    .describe(
      "The trip's exact current title, as shown by wanderlog_list_trips or wanderlog_get_trip. Acts as a safety check — deletion is refused if it doesn't match.",
    ),
};

export const deleteTripDescription = `
Permanently deletes a Wanderlog trip — itinerary, notes, reservations, budget, and journal.
This cannot be undone.

Safety: only trips the user owns can be deleted (not ones shared with them), and you must pass
the trip's exact title in confirm_title. Look it up first with
wanderlog_get_trip (or wanderlog_list_trips) and only call this tool after the user has
explicitly confirmed they want the trip deleted.
`.trim();

type Args = {
  trip_key: string;
  confirm_title: string;
};

function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function deleteTrip(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (process.env.WANDERLOG_ALLOW_DESTRUCTIVE === "0") {
      throw new WanderlogValidationError(
        "Deleting trips is disabled on this server (WANDERLOG_ALLOW_DESTRUCTIVE=0).",
        "Delete the trip in the Wanderlog app instead.",
      );
    }
    const trip = await ctx.rest.getTrip(args.trip_key);
    // A trip shared with the user belongs to someone else; deleting it would
    // destroy their plan, so only the owner's own trips can be deleted here.
    if (ctx.userId !== undefined && trip.userId !== undefined && trip.userId !== ctx.userId) {
      throw new WanderlogValidationError(
        `"${trip.title}" is owned by another Wanderlog user and was only shared with you — nothing was deleted.`,
      );
    }
    if (normalizeTitle(trip.title) !== normalizeTitle(args.confirm_title)) {
      throw new WanderlogValidationError(
        `confirm_title "${args.confirm_title}" does not match the trip's title "${trip.title}" — nothing was deleted.`,
        "Re-check the trip with wanderlog_get_trip and pass its exact title.",
      );
    }

    await ctx.rest.deleteTrip(args.trip_key);
    // The trip no longer exists server-side; drop any cached snapshot and
    // live subscription so later calls fail fast instead of hitting a ghost.
    ctx.tripCache.invalidate(args.trip_key);
    ctx.pool.evict(args.trip_key);

    return {
      content: [
        {
          type: "text",
          text: `Deleted trip "${trip.title}" (${trip.startDate ?? "no dates"} → ${trip.endDate ?? "?"}, ${trip.placeCount ?? 0} places). This cannot be undone.`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
