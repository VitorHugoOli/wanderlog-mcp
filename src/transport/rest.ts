import type { Config } from "../config.js";
import {
  WanderlogAuthError,
  WanderlogError,
  WanderlogNetworkError,
  WanderlogNotFoundError,
} from "../errors.js";
import type {
  DistanceLeg,
  ExplorePage,
  Geo,
  GeoWithGoodGuides,
  PlacesList,
  RecommendedPlace,
  GuidesForGeoResponse,
  LodgingSearchResponse,
  PlaceData,
  PlaceSuggestion,
  TripPlan,
  TripPlanSummary,
  User,
  UserSummary,
} from "../types.js";

type Envelope<T> = { success?: boolean } & T;

/**
 * fetch has no deadline of its own (only the OS socket limits, minutes long),
 * so a stalled request would hang the tool call — while holding the trip's
 * submit lock if it happens inside a mutation.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Wanderlog answers bursts (an agent adding a whole itinerary) with 429. A
 * rate-limited request was not processed, so retrying it is safe for any
 * method. Retry-After is honoured (delay-seconds form only) up to the cap.
 * Worst case a call spends ~10s+3×20s here; inside a mutation that only
 * happens on a cache miss (tripCache.getEntry), so the trip lock stays bounded.
 */
export const RATE_LIMIT_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];
const RETRY_AFTER_CAP_MS = 10_000;

export class RestClient {
  constructor(private readonly config: Config) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en",
      Cookie: this.config.cookieHeader,
      Origin: this.config.baseUrl,
      Referer: `${this.config.baseUrl}/`,
      "User-Agent": this.config.userAgent,
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, opts);
      } catch (err) {
        const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
        if (retryAfter === undefined || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw err;
        const backoff = RATE_LIMIT_RETRY_DELAYS_MS[attempt]!;
        await new Promise((r) =>
          setTimeout(r, Math.min(Math.max(retryAfter, backoff), RETRY_AFTER_CAP_MS)),
        );
      }
    }
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const init: Parameters<typeof fetch>[1] = {
      method,
      headers: this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new WanderlogNetworkError(
          `Request to ${method} ${path} timed out after ${timeoutMs / 1000}s`,
        );
      }
      throw new WanderlogNetworkError(
        `Request to ${method} ${path} failed: ${(err as Error).message}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new WanderlogAuthError();
    }
    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      const err = new WanderlogError(
        `Wanderlog is rate-limiting requests (429 on ${method} ${path.split("?")[0]})`,
        "rate_limited",
        {
          hint: "Too many requests in a short time. Nothing was changed by this call.",
          followUps: ["Wait a few seconds, then retry the same call."],
        },
      );
      (err as WanderlogError & { retryAfterMs?: number }).retryAfterMs =
        Number.isFinite(header) && header > 0 ? header * 1000 : 0;
      throw err;
    }
    if (response.status === 404) {
      throw new WanderlogNotFoundError("Resource", path);
    }
    if (response.status >= 500) {
      throw new WanderlogError(
        `Wanderlog server error ${response.status} on ${path}`,
        "upstream_error",
        "This is a Wanderlog server issue; try again in a moment.",
      );
    }
    if (!response.ok) {
      throw new WanderlogError(
        `Unexpected response ${response.status} on ${method} ${path}`,
        "unexpected_status",
      );
    }

    let parsed: T;
    try {
      parsed = (await response.json()) as T;
    } catch (err) {
      throw new WanderlogError(
        `Failed to parse JSON from ${path}: ${(err as Error).message}`,
        "parse_error",
      );
    }
    // Wanderlog reports application errors as HTTP 200 with success:false
    // (e.g. "searchedCategory is not a valid type of place list").
    const envelope = parsed as { success?: boolean; messages?: string[]; error?: string };
    if (envelope && envelope.success === false) {
      const detail = envelope.messages?.join("; ") ?? envelope.error ?? "unknown error";
      throw new WanderlogError(`Wanderlog rejected ${method} ${path}: ${detail}`, "api_error");
    }
    return parsed;
  }

  async getUser(): Promise<User> {
    let env: Envelope<{ user?: User }>;
    try {
      env = await this.request<Envelope<{ user?: User }>>("GET", "/api/user");
    } catch (err) {
      // A rejected session answered as 200 success:false is still an auth
      // failure; startup must report it as one (invariant 4).
      if (err instanceof WanderlogError && err.code === "api_error") throw new WanderlogAuthError();
      throw err;
    }
    if (!env.user || typeof env.user.id !== "number") {
      throw new WanderlogAuthError("No user returned for current session — cookie may be invalid");
    }
    return env.user;
  }

  async listTrips(): Promise<TripPlanSummary[]> {
    const env = await this.request<
      Envelope<{
        ownTripPlans?: TripPlanSummary[];
        friendsTripPlans?: TripPlanSummary[];
        friendsPrivateSharedTripPlans?: TripPlanSummary[];
      }>
    >("GET", "/api/tripPlans/home");

    return [
      ...(env.ownTripPlans ?? []),
      ...(env.friendsPrivateSharedTripPlans ?? []),
      ...(env.friendsTripPlans ?? []),
    ];
  }

  async getTrip(tripKey: string): Promise<TripPlan> {
    const { tripPlan } = await this.getTripWithResources(tripKey);
    return tripPlan;
  }

  async getTripWithResources(tripKey: string): Promise<{ tripPlan: TripPlan; geos: Geo[] }> {
    try {
      return await this.fetchTripWithResources(tripKey);
    } catch (err) {
      // An unknown key comes back as HTTP 200 success:false "Couldn't fetch
      // keyInfo for key …"; report it as the not-found it is.
      if (
        err instanceof WanderlogError &&
        err.code === "api_error" &&
        /keyInfo/i.test(err.message)
      ) {
        throw new WanderlogNotFoundError("Trip", tripKey);
      }
      throw err;
    }
  }

  private async fetchTripWithResources(
    tripKey: string,
  ): Promise<{ tripPlan: TripPlan; geos: Geo[] }> {
    const env = await this.request<
      Envelope<{
        tripPlan?: TripPlan;
        resources?: { geos?: Geo[] };
      }>
    >(
      "GET",
      `/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2&registerView=true`,
    );
    if (!env.tripPlan) {
      throw new WanderlogNotFoundError("Trip", tripKey);
    }
    return { tripPlan: env.tripPlan, geos: env.resources?.geos ?? [] };
  }

  async searchPlacesAutocomplete(args: {
    input: string;
    sessionToken: string;
    location: { latitude: number; longitude: number };
    radius: number;
    language?: string;
  }): Promise<PlaceSuggestion[]> {
    const request = {
      input: args.input,
      sessiontoken: args.sessionToken,
      location: args.location,
      radius: args.radius,
      language: args.language ?? "en",
    };
    const qs = `request=${encodeURIComponent(JSON.stringify(request))}`;
    const env = await this.request<Envelope<{ data?: PlaceSuggestion[] }>>(
      "GET",
      `/api/placesAPI/autocomplete/v2?${qs}`,
    );
    // The endpoint mixes in entries with no place_id. Callers take the first
    // result, so one of those ahead of a real place became "Place not found".
    return (env.data ?? []).filter((p) => typeof p?.place_id === "string" && p.place_id.length > 0);
  }

  /**
   * Fetch Wanderlog-internal image keys for a place. The UI calls this before
   * inserting a place block and stores the returned keys on `block.imageKeys`.
   * Native apps (iOS/iPadOS) render images strictly from `imageKeys` — without
   * them, the block shows no thumbnail. Returns [] on failure so callers can
   * fall back to inserting the block without images.
   */
  async getPlacePhotos(place: PlaceData): Promise<string[]> {
    try {
      const env = await this.request<Envelope<{ data?: string[] }>>(
        "POST",
        `/api/placePhotos/${encodeURIComponent(place.place_id)}`,
        { body: { place } },
      );
      return Array.isArray(env.data) ? env.data : [];
    } catch {
      return [];
    }
  }

  async getPlaceDetails(placeId: string, language = "en"): Promise<PlaceData> {
    const env = await this.request<Envelope<{ data?: PlaceData }>>(
      "GET",
      `/api/placesAPI/getPlaceDetails/v2?placeId=${encodeURIComponent(placeId)}&language=${language}`,
    );
    if (!env.data) {
      throw new WanderlogNotFoundError("Place", placeId);
    }
    return env.data;
  }

  async geoAutocomplete(query: string): Promise<
    Array<{
      id: number;
      name: string;
      countryName?: string;
      stateName?: string;
      latitude: number;
      longitude: number;
      popularity?: number;
      bounds?: [number, number, number, number];
    }>
  > {
    const env = await this.request<
      Envelope<{
        data?: Array<{
          id: number;
          name: string;
          countryName?: string;
          stateName?: string;
          latitude: number;
          longitude: number;
          popularity?: number;
          bounds?: [number, number, number, number];
        }>;
      }>
    >("GET", `/api/geo/autocomplete/${encodeURIComponent(query)}`);
    return env.data ?? [];
  }

  async listGoodGuides(): Promise<GeoWithGoodGuides[]> {
    const env = await this.request<Envelope<{ data?: GeoWithGoodGuides[] }>>(
      "GET",
      "/api/geo/geosWithGoodGuides",
    );
    return env.data ?? [];
  }

  async getGuidesForGeo(geoId: number): Promise<GuidesForGeoResponse> {
    const env = await this.request<
      Envelope<{ data?: { geoWithGoodGuides?: GuidesForGeoResponse } }>
    >("GET", `/api/tripPlans/browse/guides/${encodeURIComponent(String(geoId))}`);
    const data = env.data?.geoWithGoodGuides;
    if (!data) {
      throw new WanderlogNotFoundError("Guides", String(geoId));
    }
    return data;
  }

  async getGuideContent(viewKey: string): Promise<TripPlan> {
    try {
      const env = await this.request<Envelope<{ tripPlan?: TripPlan }>>(
        "GET",
        `/api/tripPlans/${encodeURIComponent(viewKey)}?clientSchemaVersion=2`,
      );
      if (!env.tripPlan) {
        throw new WanderlogNotFoundError("Guide", viewKey);
      }
      return env.tripPlan;
    } catch (err) {
      if (err instanceof WanderlogNotFoundError) {
        throw new WanderlogNotFoundError("Guide", viewKey);
      }
      throw err;
    }
  }

  async getGeo(geoId: number): Promise<{
    id: number;
    name: string;
    countryName?: string;
    bounds?: [number, number, number, number];
  }> {
    const env = await this.request<
      Envelope<{
        data?: {
          id: number;
          name: string;
          countryName?: string;
          bounds?: [number, number, number, number];
        };
      }>
    >("GET", `/api/geo/${encodeURIComponent(String(geoId))}/clientGeo`);
    if (!env.data) {
      throw new WanderlogNotFoundError("Geo", String(geoId));
    }
    return env.data;
  }

  async searchLodgings(args: {
    geoId: number;
    bounds: [number, number, number, number];
    startDate: string;
    endDate: string;
    adultCount: number;
    roomCount: number;
    childrenAges: number[];
    sortBy: "ratings" | "price_low_to_high" | "price_high_to_low" | "deals";
    filters?: {
      priceRange?: [number, number] | null;
      hotelClasses?: number[] | null;
      minGuestRating?: number | null;
      propertyTypes?: {
        lodgingTypes?: string[] | null;
        accommodationTypes?: string[] | null;
      };
      hotelOrVacationRental?: "hotel" | "rental" | "both";
      amenities?: string[] | null;
      minBedsInRoom?: number | null;
      propertyName?: string;
      vacationRentalFilters?: { amenities?: string[] };
    };
    sources?: string[];
  }): Promise<LodgingSearchResponse> {
    const body = {
      geoId: args.geoId,
      bounds: args.bounds,
      dates: { startDate: args.startDate, endDate: args.endDate },
      guests: {
        adultCount: args.adultCount,
        roomCount: args.roomCount,
        childrenAges: args.childrenAges,
      },
      sortBy: args.sortBy,
      filters: {
        priceRange: args.filters?.priceRange ?? null,
        hotelClasses: args.filters?.hotelClasses ?? null,
        minGuestRating: args.filters?.minGuestRating ?? null,
        propertyTypes: {
          lodgingTypes: args.filters?.propertyTypes?.lodgingTypes ?? null,
          accommodationTypes: args.filters?.propertyTypes?.accommodationTypes ?? null,
        },
        hotelOrVacationRental: args.filters?.hotelOrVacationRental ?? "both",
        amenities: args.filters?.amenities ?? null,
        minBedsInRoom: args.filters?.minBedsInRoom ?? null,
        propertyName: args.filters?.propertyName ?? "",
        vacationRentalFilters: {
          amenities: args.filters?.vacationRentalFilters?.amenities ?? [],
        },
      },
      sources: args.sources ?? ["airbnb", "expedia", "google", "kayak"],
    };
    const env = await this.request<Envelope<{ data?: LodgingSearchResponse }>>(
      "POST",
      "/api/lodging/searchLodgings",
      // Aggregates several vendors server-side; routinely slower than other calls.
      { body, timeoutMs: 60_000 },
    );
    return env.data ?? { isComplete: true, offers: [] };
  }

  async createTrip(args: {
    geoIds: number[];
    startDate: string;
    endDate: string;
    title?: string | null;
    privacy?: "private" | "friends" | "public";
  }): Promise<{ key: string; viewKey: string; id: number; title: string }> {
    const env = await this.request<
      Envelope<{
        data?: { key: string; viewKey: string; id: number; title: string };
      }>
    >("POST", "/api/tripPlans", {
      body: {
        geoIds: args.geoIds,
        initialMapsPlaceIds: [],
        initialEmailId: null,
        type: "plan",
        startDate: args.startDate,
        endDate: args.endDate,
        privacy: args.privacy ?? "private",
        isMapEmbed: false,
        title: args.title ?? null,
        language: "en",
      },
    });
    if (!env.data) {
      throw new WanderlogError("Trip creation returned no data", "create_failed");
    }
    return env.data;
  }

  async setCurrencyPreference(currency: string): Promise<void> {
    await this.request<Envelope<unknown>>("POST", "/api/sessionStore", {
      body: { key: "currencyPreference", value: currency },
    });
  }

  async getExplorePage(geoId: number, tripKey?: string): Promise<ExplorePage> {
    const qs = tripKey ? `?tripPlanKey=${encodeURIComponent(tripKey)}` : "";
    const env = await this.request<Envelope<{ data?: ExplorePage }>>(
      "GET",
      `/api/geo/${encodeURIComponent(String(geoId))}/explorePage${qs}`,
    );
    if (!env.data) throw new WanderlogNotFoundError("Explore page for geo", String(geoId));
    return env.data;
  }

  /**
   * Curated place list. `type` is the list's kind from the explore page
   * (geoCategory, webPlacesList, itinerary, tripPlan); explore-page category
   * ids double as geoCategory list ids.
   */
  async getPlacesList(type: string, listId: string | number, geoId: number): Promise<PlacesList> {
    const env = await this.request<Envelope<{ data?: PlacesList }>>(
      "GET",
      `/api/placesList/${encodeURIComponent(type)}/${encodeURIComponent(String(listId))}?geoId=${encodeURIComponent(String(geoId))}`,
    );
    if (!env.data) throw new WanderlogNotFoundError("Places list", String(listId));
    return env.data;
  }

  async getRecommendationsNear(args: {
    tripPlanId: number;
    geoId: number;
    longitude: number;
    latitude: number;
    excludingPlaceIds: string[];
  }): Promise<RecommendedPlace[]> {
    const env = await this.request<Envelope<{ data?: RecommendedPlace[] }>>(
      "POST",
      "/api/recommendations/v2",
      {
        body: {
          tripPlanId: args.tripPlanId,
          geoId: args.geoId,
          input: {
            type: "nearestLngLat",
            nearestLngLat: { longitude: args.longitude, latitude: args.latitude },
          },
          excludingPlaceIds: args.excludingPlaceIds,
        },
      },
    );
    return env.data ?? [];
  }

  /**
   * Route legs between consecutive places in each run. Response is keyed by
   * the JSON-encoded tuple `[fromPlaceId, toPlaceId, travelMode]`.
   */
  async getDistances(args: {
    placeRuns: Array<{
      sectionId: number;
      places: Array<{ id: string; longitude: number; latitude: number }>;
    }>;
    travelMode: "driving" | "transit" | "walking";
  }): Promise<Record<string, DistanceLeg>> {
    const env = await this.request<Envelope<{ data?: Record<string, DistanceLeg> }>>(
      "POST",
      "/api/directions/distancesForMode",
      { body: args },
    );
    return env.data ?? {};
  }

  async userAutocomplete(query: string): Promise<UserSummary[]> {
    const env = await this.request<Envelope<{ data?: UserSummary[] }>>(
      "GET",
      `/api/user/autocomplete/${encodeURIComponent(query)}`,
    );
    return env.data ?? [];
  }

  async deleteTrip(tripKey: string): Promise<void> {
    await this.request<Envelope<{}>>("DELETE", `/api/tripPlans/${encodeURIComponent(tripKey)}`);
  }
}
