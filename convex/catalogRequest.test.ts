import { expect, test, vi } from "vitest";
import { catalogRequest } from "./lib/catalogRequest";
import { codeOf } from "./lib/errors";

/** The error a call rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

function harness(responses: Array<Response | Error>) {
  return {
    reserve: vi.fn(async () => 100),
    defer: vi.fn(async (_ms: number) => {}),
    sleep: vi.fn(async (_ms: number) => {}),
    fetch: vi.fn(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected extra request");
      return response;
    }),
  };
}
test("temporary provider failure retries through the shared limiter and returns results", async () => {
  const options = harness([
    new Response("", { status: 503 }),
    Response.json({ recordings: [{ id: "match" }] }),
  ]);
  await expect(
    catalogRequest("https://example.test", options),
  ).resolves.toEqual({ recordings: [{ id: "match" }] });
  expect(options.reserve).toHaveBeenCalledTimes(2);
  expect(options.defer).toHaveBeenCalledWith(2000);
});
test("long Retry-After postpones all requests and does not retry early", async () => {
  const options = harness([
    new Response("", { status: 429, headers: { "Retry-After": "600" } }),
  ]);
  const error = await rejection(catalogRequest("https://example.test", options));
  expect(codeOf(error)).toBe("lookup_unavailable");
  expect((error as Error).message).toMatch("temporarily unavailable");
  expect(options.defer).toHaveBeenCalledWith(600000);
  expect(options.fetch).toHaveBeenCalledTimes(1);
});
test("network failures stop after three attempts with a useful error", async () => {
  const options = harness([
    new Error("timeout"),
    new Error("timeout"),
    new Error("timeout"),
  ]);
  const error = await rejection(catalogRequest("https://example.test", options));
  expect(codeOf(error)).toBe("lookup_unavailable");
  expect((error as Error).message).toMatch("temporarily unavailable");
  expect(options.fetch).toHaveBeenCalledTimes(3);
});
test("permanent HTTP errors do not retry", async () => {
  const options = harness([new Response("", { status: 400 })]);
  const error = await rejection(catalogRequest("https://example.test", options));
  expect(codeOf(error)).toBe("lookup_unavailable");
  expect((error as Error).message).toMatch("temporarily unavailable");
  expect(options.fetch).toHaveBeenCalledTimes(1);
});
test("a response too large to use is invalid and is not retried", async () => {
  const options = harness([new Response("x".repeat(900001))]);
  const error = await rejection(catalogRequest("https://example.test", options));
  expect(codeOf(error)).toBe("invalid");
  expect((error as Error).message).toMatch("too large");
  expect(options.fetch).toHaveBeenCalledTimes(1);
});
test("unreadable bodies retry, then fail as lookup_unavailable", async () => {
  const options = harness([
    new Response("not json"),
    new Response("not json"),
    new Response("not json"),
  ]);
  const error = await rejection(catalogRequest("https://example.test", options));
  expect(codeOf(error)).toBe("lookup_unavailable");
  expect(options.fetch).toHaveBeenCalledTimes(3);
});
