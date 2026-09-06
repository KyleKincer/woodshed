import { expect, test, vi } from "vitest";
import { catalogRequest } from "./lib/catalogRequest";

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
  await expect(catalogRequest("https://example.test", options)).rejects.toThrow(
    "temporarily unavailable",
  );
  expect(options.defer).toHaveBeenCalledWith(600000);
  expect(options.fetch).toHaveBeenCalledTimes(1);
});
test("network failures stop after three attempts with a useful error", async () => {
  const options = harness([
    new Error("timeout"),
    new Error("timeout"),
    new Error("timeout"),
  ]);
  await expect(catalogRequest("https://example.test", options)).rejects.toThrow(
    "temporarily unavailable",
  );
  expect(options.fetch).toHaveBeenCalledTimes(3);
});
test("permanent HTTP errors do not retry", async () => {
  const options = harness([new Response("", { status: 400 })]);
  await expect(catalogRequest("https://example.test", options)).rejects.toThrow(
    "temporarily unavailable",
  );
  expect(options.fetch).toHaveBeenCalledTimes(1);
});
