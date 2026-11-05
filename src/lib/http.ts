import type { z } from "zod";
import { Buffer } from "node:buffer";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  init?: RequestInit;
  timeoutMs?: number;
  /** Additional attempts after the first, only for transient failures. Max 3. */
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

async function readText(response: Response, limit?: number): Promise<string> {
  if (limit === undefined) return response.text();
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new HttpError("Invalid response size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError("Response was not valid JSON", response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError("Response exceeded the size limit", response.status);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError("Request aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new HttpError("Request aborted"));
      },
      { once: true },
    );
  });
}

async function attempt<T>(
  url: string, parse: (text: string, status: number) => T, options: FetchJsonOptions,
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { ...options.init, signal, redirect: "error" });
  } catch {
    if (options.signal?.aborted) throw new HttpError("Request aborted");
    if (timeout.aborted) throw new HttpError("Request timed out", undefined, true);
    throw new HttpError("Network request failed", undefined, true);
  }
  if (!response.ok) {
    // Response bodies are discarded: they may contain sensitive data.
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(`HTTP ${response.status}`, response.status, transientStatuses.has(response.status));
  }
  let text: string;
  try {
    text = await readText(response, options.maxResponseBytes);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("Response body could not be read", response.status);
  }
  return parse(text, response.status);
}

async function fetchParsed<T>(
  url: string,
  parse: (text: string, status: number) => T,
  options: FetchJsonOptions = {},
): Promise<T> {
  const retries = Math.max(0, Math.min(options.retries ?? 1, 3));
  for (let attemptNumber = 0; ; attemptNumber++) {
    try {
      return await attempt(url, parse, options);
    } catch (error) {
      const retryable = error instanceof HttpError && error.retryable;
      if (!retryable || attemptNumber >= retries) throw error;
      await sleep((options.retryDelayMs ?? 250) * 2 ** attemptNumber, options.signal);
    }

  }
}

/** Fetches JSON with a per-attempt timeout, bounded transient retries and validation. */
export function fetchJson<T>(
  url: string, schema: z.ZodType<T>, options: FetchJsonOptions = {},
): Promise<T> {
  return fetchParsed(url, (text, status) => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError("Response was not valid JSON", status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HttpError("Response did not match the expected schema", status);
    return parsed.data;
  }, options);
}

export function fetchText(url: string, options: FetchJsonOptions = {}): Promise<string> {
  return fetchParsed(url, (text) => text, options);
}
