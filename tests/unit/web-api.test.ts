import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../../web/src/api.ts";
afterEach(() => vi.unstubAllGlobals());
it("reads without a request body and returns the server projection", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 3 })));
  vi.stubGlobal("fetch", fetch);
  expect(await api("governance")).toEqual({ revision: 3 });
  expect(fetch).toHaveBeenCalledWith(
    "/api/governance",
    expect.objectContaining({ method: "GET", body: undefined }),
  );
});
it("preserves the explicit mutation body including revision and idempotency fields", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  const mutation = { action: "freeze", requestId: "same-request", expectedRevision: 3 };
  await api("governance", mutation);
  expect(fetch).toHaveBeenCalledWith("/api/governance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  await api("governance", null);
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/governance",
    expect.objectContaining({ method: "POST", body: "null" }),
  );
});
it("retains HTTP status so validation failures do not become retryable task submissions", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "版本已变化" }), { status: 409 })),
  );
  const error = await api("governance", {}).catch((error) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, message: "版本已变化" });
});
it("retains transport failures separately from server validation failures", async () => {
  const failure = new TypeError("Network request failed");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(api("runs", { requestId: "same-request" })).rejects.toBe(failure);
});
