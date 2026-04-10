export const DEFAULT_BASE_URL = "https://sensra.io";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface SafeParsedJsonResponse {
  value?: unknown;
  readError?: unknown;
}

export async function safeParseJsonResponse(response: Response): Promise<SafeParsedJsonResponse> {
  let text: string;

  try {
    text = await response.text();
  } catch (error) {
    return { readError: error };
  }

  if (text.length === 0) {
    return {};
  }

  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return {};
  }
}
