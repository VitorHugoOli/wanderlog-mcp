import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { WanderlogAuthError } from "../../src/errors.ts";
import { AUTH_RETRY_AFTER_MS, requireAuth } from "../../src/server.ts";

const successResponse = {
  content: [{ type: "text" as const, text: "ok" }],
};

function createContext(getUser: ReturnType<typeof vi.fn>, authenticated = false): AppContext {
  return {
    authenticated,
    rest: { getUser } as unknown as AppContext["rest"],
  } as AppContext;
}

describe("requireAuth", () => {
  it("does not probe again after startup authentication succeeds", async () => {
    const getUser = vi.fn();
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser, true), handler);

    await expect(guarded({})).resolves.toEqual(successResponse);
    expect(getUser).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("recovers a valid session after the startup probe failed", async () => {
    const getUser = vi.fn().mockResolvedValue({ id: 42, username: "traveler" });
    const ctx = createContext(getUser);
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(ctx, handler);

    await expect(guarded({})).resolves.toEqual(successResponse);
    expect(getUser).toHaveBeenCalledOnce();
    expect(ctx.authenticated).toBe(true);
    expect(ctx.userId).toBe(42);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reports a rejected cookie as an authentication error", async () => {
    const getUser = vi.fn().mockRejectedValue(new WanderlogAuthError());
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser), handler);

    const response = await guarded({});

    expect(response).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("Authentication required") }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not blame the cookie, or cache, when Wanderlog is unreachable", async () => {
    const getUser = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret transport detail"))
      .mockResolvedValueOnce({ id: 9, username: "traveler" });
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser), handler);

    const first = await guarded({});
    expect(first.isError).toBe(true);
    expect(first.content[0]?.text).toContain("Could not verify the Wanderlog session");
    expect(first.content[0]?.text).not.toContain("secret transport detail");
    expect(first.content[0]?.text).not.toContain("Authentication required");

    await expect(guarded({})).resolves.toEqual(successResponse);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight retry across concurrent tool calls", async () => {
    let resolveUser: ((user: { id: number; username: string }) => void) | undefined;
    const getUser = vi.fn(
      () =>
        new Promise<{ id: number; username: string }>((resolve) => {
          resolveUser = resolve;
        }),
    );
    const ctx = createContext(getUser);
    const firstHandler = vi.fn().mockResolvedValue(successResponse);
    const secondHandler = vi.fn().mockResolvedValue(successResponse);

    const firstCall = requireAuth(ctx, firstHandler)({});
    const secondCall = requireAuth(ctx, secondHandler)({});

    expect(getUser).toHaveBeenCalledOnce();
    resolveUser?.({ id: 7, username: "traveler" });
    await expect(Promise.all([firstCall, secondCall])).resolves.toEqual([
      successResponse,
      successResponse,
    ]);
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("caches a rejected cookie briefly, then probes again", async () => {
    vi.useFakeTimers();
    try {
      const getUser = vi
        .fn()
        .mockRejectedValueOnce(new WanderlogAuthError())
        .mockResolvedValueOnce({ id: 3, username: "traveler" });
      const handler = vi.fn().mockResolvedValue(successResponse);
      const guarded = requireAuth(createContext(getUser), handler);

      await guarded({});
      await guarded({});
      expect(getUser).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(AUTH_RETRY_AFTER_MS);
      await expect(guarded({})).resolves.toEqual(successResponse);
      expect(getUser).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels an error thrown by a tool instead of letting it escape", async () => {
    const handler = vi.fn().mockRejectedValue(new TypeError("boom"));
    const guarded = requireAuth(createContext(vi.fn(), true), handler);

    await expect(guarded({})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Unexpected error in TypeError: boom" }],
    });
  });

  it("redacts anything shaped like the session cookie from tool output", async () => {
    const cookie = "s%3AFakeSessionIdFakeSessionId0123.FakeSignatureFakeSignature%2B0123456";
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `header was connect.sid=${cookie}; raw ${cookie} end` }],
    });
    const guarded = requireAuth(createContext(vi.fn(), true), handler);

    const text = (await guarded({})).content[0]!.text;
    expect(text).not.toContain("FakeSessionId");
    expect(text).toBe("header was [redacted]; raw [redacted] end");
  });
});
