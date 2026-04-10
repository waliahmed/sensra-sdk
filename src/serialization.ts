import type { JsonObject, JsonValue } from "./types";
import { isPlainObject } from "./utils";

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

function sanitizeNumber(value: number): JsonValue {
  if (Number.isFinite(value)) {
    return value;
  }

  if (Number.isNaN(value)) {
    return "NaN";
  }

  return value > 0 ? "Infinity" : "-Infinity";
}

function sanitizeObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): JsonObject {
  const result: JsonObject = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    const sanitized = sanitizeJsonValueInternal(nestedValue, seen, depth + 1);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }

  return result;
}

function sanitizeJsonValueInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): JsonValue | undefined {
  if (value === null) {
    return null;
  }

  if (depth > MAX_DEPTH) {
    return "[MaxDepthExceeded]";
  }

  const valueType = typeof value;

  if (valueType === "string" || valueType === "boolean") {
    return value as JsonValue;
  }

  if (valueType === "number") {
    return sanitizeNumber(value as number);
  }

  if (valueType === "bigint") {
    return (value as bigint).toString();
  }

  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (value instanceof Error) {
    return sanitizeObject(
      {
        name: value.name,
        message: value.message,
        stack: value.stack
      },
      seen,
      depth + 1
    );
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];

    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const sanitized = sanitizeJsonValueInternal(item, seen, depth + 1);
      if (sanitized !== undefined) {
        result.push(sanitized);
      }
    }

    return result;
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;

    if (seen.has(objectValue)) {
      return "[Circular]";
    }

    seen.add(objectValue);

    if (typeof objectValue.toJSON === "function") {
      const serialized = objectValue.toJSON();
      return sanitizeJsonValueInternal(serialized, seen, depth + 1);
    }

    if (!isPlainObject(objectValue)) {
      return String(objectValue);
    }

    return sanitizeObject(objectValue, seen, depth);
  }

  return undefined;
}

export function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  return sanitizeJsonValueInternal(value, new WeakSet<object>(), 0);
}

export function sanitizeJsonObject(value: unknown): JsonObject {
  const sanitized = sanitizeJsonValue(value);

  if (sanitized === undefined || Array.isArray(sanitized) || sanitized === null || typeof sanitized !== "object") {
    return {};
  }

  return sanitized as JsonObject;
}
