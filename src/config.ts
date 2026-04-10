import { SensraConfigError } from "./errors";
import { sanitizeJsonObject } from "./serialization";
import type { FetchLike, SensraClientConfig, SensraResolvedConfig } from "./types";
import { DEFAULT_BASE_URL, clamp, stripTrailingSlash, toTrimmedString } from "./utils";

function resolveFetch(fetchOverride?: FetchLike): FetchLike {
  if (fetchOverride) {
    return fetchOverride;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new SensraConfigError(
    "No fetch implementation found. Provide `fetch` in SensraClient config for this runtime."
  );
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  key: string,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SensraConfigError(`\`${key}\` must be a finite number.`);
  }

  if (!Number.isInteger(value)) {
    throw new SensraConfigError(`\`${key}\` must be an integer.`);
  }

  if (value < min || value > max) {
    throw new SensraConfigError(`\`${key}\` must be between ${min} and ${max}.`);
  }

  return value;
}

function parseBaseUrl(value: unknown): string {
  const asString = toTrimmedString(value) ?? DEFAULT_BASE_URL;

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(asString);
  } catch {
    throw new SensraConfigError("`baseUrl` must be a valid absolute URL.", {
      value
    });
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new SensraConfigError("`baseUrl` protocol must be http or https.", {
      protocol: parsedUrl.protocol
    });
  }

  return stripTrailingSlash(parsedUrl.toString());
}

function parseApiKey(value: unknown): string {
  const apiKey = toTrimmedString(value);

  if (!apiKey) {
    throw new SensraConfigError("`apiKey` is required and must be a non-empty string.");
  }

  return apiKey;
}

function parseDefaultTags(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new SensraConfigError("`defaultTags` must be an array of non-empty strings.");
  }

  const tags = value
    .map((tag) => toTrimmedString(tag))
    .filter((tag): tag is string => tag !== undefined);

  return [...new Set(tags)];
}

export function resolveClientConfig(config: SensraClientConfig): SensraResolvedConfig {
  if (!config || typeof config !== "object") {
    throw new SensraConfigError("SensraClient config is required.");
  }

  const apiKey = parseApiKey(config.apiKey);
  const baseUrl = parseBaseUrl(config.baseUrl);
  const service = toTrimmedString(config.service);
  const environment = toTrimmedString(config.environment);

  const timeoutMs = parsePositiveInteger(config.timeoutMs, 5_000, "timeoutMs", 100, 60_000);
  const maxRetries = parsePositiveInteger(config.maxRetries, 3, "maxRetries", 0, 10);
  const retryBaseDelayMs = parsePositiveInteger(
    config.retryBaseDelayMs,
    250,
    "retryBaseDelayMs",
    10,
    30_000
  );
  const retryMaxDelayMs = parsePositiveInteger(
    config.retryMaxDelayMs,
    5_000,
    "retryMaxDelayMs",
    100,
    120_000
  );

  const maxQueueSize = parsePositiveInteger(config.maxQueueSize, 1_000, "maxQueueSize", 1, 100_000);
  const maxBatchItems = parsePositiveInteger(config.maxBatchItems, 50, "maxBatchItems", 1, 1_000);
  const maxRequestsPerMinute = parsePositiveInteger(
    config.maxRequestsPerMinute,
    170,
    "maxRequestsPerMinute",
    1,
    10_000
  );
  const shutdownTimeoutMs = parsePositiveInteger(
    config.shutdownTimeoutMs,
    10_000,
    "shutdownTimeoutMs",
    100,
    120_000
  );

  const defaultMetadata = sanitizeJsonObject(config.defaultMetadata ?? {});
  const defaultTags = parseDefaultTags(config.defaultTags);
  const fetchImplementation = resolveFetch(config.fetch);

  const resolved: SensraResolvedConfig = {
    apiKey,
    baseUrl,
    fetch: fetchImplementation,
    timeoutMs,
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs: clamp(retryMaxDelayMs, retryBaseDelayMs, retryMaxDelayMs),
    maxQueueSize,
    maxBatchItems,
    maxRequestsPerMinute,
    shutdownTimeoutMs,
    defaultMetadata,
    defaultTags
  };

  if (service !== undefined) {
    resolved.service = service;
  }

  if (environment !== undefined) {
    resolved.environment = environment;
  }

  return resolved;
}
