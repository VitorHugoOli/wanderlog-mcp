/**
 * Live tests must only ever touch trips created for testing. Read-only suites
 * use the persistent trip named in WANDERLOG_TRIP_KEY (no fallback to someone
 * else's trip); mutating suites create and delete their own WANDERDOG_TEST_*
 * trips and assert the title before writing.
 */
export const TEST_TRIP_PREFIX = "WANDERDOG_TEST";

export function testTripKey(): string {
  const key = process.env.WANDERLOG_TRIP_KEY;
  if (!key) {
    throw new Error(
      `WANDERLOG_TRIP_KEY must point at a trip titled "${TEST_TRIP_PREFIX}…" for live tests`,
    );
  }
  return key;
}

export function assertTestTrip(trip: { title: string; key?: string }): void {
  if (!trip.title.startsWith(TEST_TRIP_PREFIX)) {
    throw new Error(
      `Refusing to run live tests against "${trip.title}": only ${TEST_TRIP_PREFIX}* trips are allowed`,
    );
  }
}
