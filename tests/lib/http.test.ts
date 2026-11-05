import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError, fetchJson } from "@/lib/http";

const schema = z.object({ value: z.number() });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("fetchJson", () => {
  it("limits bytes read and does not retry oversized JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => ok({ value: 1 }));
    await expect(fetchJson("https://example.test", schema, { fetchImpl, maxResponseBytes: 11 })).resolves.toEqual({ value: 1 });
    await expect(fetchJson("https://example.test", schema, { fetchImpl, maxResponseBytes: 10 })).rejects.toThrow("size limit");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns validated data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({ value: 1 }));
    await expect(fetchJson("https://example.test", schema, { fetchImpl })).resolves.toEqual({ value: 1 });
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("retries transient statuses a bounded number of times", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(ok({ value: 2 }));
    await expect(fetchJson("https://example.test", schema, { fetchImpl, retryDelayMs: 0 })).resolves.toEqual({
      value: 2,
    });

    const alwaysFailing = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 500 }));
    await expect(
      fetchJson("https://example.test", schema, { fetchImpl: alwaysFailing, retries: 2, retryDelayMs: 0 }),
    ).rejects.toMatchObject({ status: 500 });
    expect(alwaysFailing).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors and never exposes response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-token", { status: 401 }));
    const error = await fetchJson("https://example.test", schema, { fetchImpl, retryDelayMs: 0 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(String((error as HttpError).message)).not.toContain("secret-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid payloads without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({ value: "nope" }));
    await expect(fetchJson("https://example.test", schema, { fetchImpl })).rejects.toThrow(/expected schema/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out slow requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(
      fetchJson("https://example.test", schema, { fetchImpl, timeoutMs: 10, retries: 0 }),
    ).rejects.toThrow("Request timed out");
  });
});
