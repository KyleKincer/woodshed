import { ConvexError } from "convex/values";
import { fail } from "./errors";

const retryable = new Set([429, 500, 502, 503, 504]);
const unavailable =
  "MusicBrainz is temporarily unavailable. Please try again shortly.";
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient provider failures; every attempt still acquires a shared rate slot.
 * Failures are coded (§6.1): `lookup_unavailable` when the provider cannot be
 * reached, `invalid` when a response is too large to use.
 */
export async function catalogRequest(
  url: string,
  options: {
    reserve: () => Promise<number>;
    defer: (ms: number) => Promise<void>;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<unknown> {
  const fetcher = options.fetch ?? fetch,
    pause = options.sleep ?? sleep;
  for (let attempt = 0; attempt < 3; attempt++) {
    const delay = await options.reserve();
    if (delay > 0) await pause(delay);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          "User-Agent": "Woodshed/1.2 (https://github.com/KyleKincer/woodshed)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      if (attempt === 2) fail("lookup_unavailable", unavailable);
      await pause(2000 * (attempt + 1));
      continue;
    }
    if (response.ok) {
      try {
        const body = await response.text();
        if (body.length > 900000)
          fail(
            "invalid",
            "This release is too large to look up. Try another match.",
          );
        return JSON.parse(body);
      } catch (error) {
        if (error instanceof ConvexError) throw error;
        if (attempt === 2) fail("lookup_unavailable", unavailable);
        await pause(2000 * (attempt + 1));
        continue;
      }
    }
    if (!retryable.has(response.status)) fail("lookup_unavailable", unavailable);
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAfter
        ? Date.parse(retryAfter) - Date.now()
        : 0;
    const backoff = Math.max(
      2000 * (attempt + 1),
      Number.isFinite(requestedDelay) ? requestedDelay : 0,
    );
    // Other requests also respect the provider's cooldown, including requests from other users.
    await options.defer(backoff);
    await response.body?.cancel().catch(() => {});
    if (attempt === 2 || backoff > 8000) fail("lookup_unavailable", unavailable);
    await pause(backoff);
  }
  fail("lookup_unavailable", unavailable);
}
