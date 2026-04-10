import { SensraValidationError } from "./errors";
import { sanitizeJsonObject, sanitizeJsonValue } from "./serialization";
import type {
  JsonObject,
  SensraEvent,
  SensraEventInput,
  SensraExceptionPayload,
  SensraLevel,
  SensraStackFrame,
  SensraValidationLimits
} from "./types";
import { isPlainObject, toTrimmedString } from "./utils";

const LEVEL_MAP: Record<string, SensraLevel> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  warning: "warning",
  error: "error",
  critical: "critical",
  fatal: "critical"
};

export const DEFAULT_VALIDATION_LIMITS: SensraValidationLimits = {
  maxMessageLength: 8_192,
  maxTags: 50,
  maxTagLength: 128,
  maxStackFrames: 200,
  maxMetadataKeys: 100
};

export interface NormalizeEventOptions {
  service?: string;
  environment?: string;
  defaultMetadata?: JsonObject;
  defaultTags?: string[];
  limits?: SensraValidationLimits;
}

function pickFirst(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in input) {
      return input[key];
    }
  }

  return undefined;
}

function normalizeLevel(value: unknown): SensraLevel | undefined {
  const normalized = toTrimmedString(value)?.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  const mapped = LEVEL_MAP[normalized];

  if (!mapped) {
    throw new SensraValidationError("`level` must be one of debug, info, warning, error, critical.", {
      received: value
    });
  }

  return mapped;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const asDate =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : undefined;

  if (!asDate || Number.isNaN(asDate.getTime())) {
    throw new SensraValidationError("`timestamp` must be a valid ISO string, unix value, or Date.", {
      received: value
    });
  }

  return asDate.toISOString();
}

function normalizeFrameNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }

  return undefined;
}

function normalizeStackFrames(value: unknown): SensraStackFrame[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new SensraValidationError("`stackFrames` must be an array when provided.", {
      receivedType: typeof value
    });
  }

  const frames: SensraStackFrame[] = [];

  for (const rawFrame of value) {
    if (typeof rawFrame === "string") {
      const raw = toTrimmedString(rawFrame);
      if (raw) {
        frames.push({ raw });
      }
      continue;
    }

    if (!isPlainObject(rawFrame)) {
      continue;
    }

    const functionName = toTrimmedString(
      pickFirst(rawFrame, ["function", "functionName", "fn", "method"])
    );
    const file = toTrimmedString(pickFirst(rawFrame, ["file", "filename", "path", "source"]));
    const line = normalizeFrameNumber(pickFirst(rawFrame, ["line", "lineNumber", "lineno"]));
    const column = normalizeFrameNumber(pickFirst(rawFrame, ["column", "columnNumber", "colno"]));
    const raw = toTrimmedString(pickFirst(rawFrame, ["raw", "text"]));

    const frame: SensraStackFrame = {};

    if (functionName !== undefined) {
      frame.function = functionName;
    }

    if (file !== undefined) {
      frame.file = file;
    }

    if (line !== undefined) {
      frame.line = line;
    }

    if (column !== undefined) {
      frame.column = column;
    }

    if (raw !== undefined) {
      frame.raw = raw;
    }

    if (Object.keys(frame).length > 0) {
      frames.push(frame);
    }
  }

  return frames.length > 0 ? frames : undefined;
}

function normalizeExceptionValue(value: unknown): SensraExceptionPayload | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value instanceof Error) {
    const payload: SensraExceptionPayload = {
      name: value.name,
      type: value.name,
      message: value.message
    };

    if (value.stack) {
      payload.stack = value.stack;
    }

    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      payload.code = code;
    }

    const cause = sanitizeJsonValue((value as { cause?: unknown }).cause);
    if (cause !== undefined) {
      payload.cause = cause;
    }

    return payload;
  }

  if (typeof value === "string") {
    const message = toTrimmedString(value);
    return message ? { message } : undefined;
  }

  if (!isPlainObject(value)) {
    return { message: String(value) };
  }

  const payload: SensraExceptionPayload = {};

  const name = toTrimmedString(pickFirst(value, ["name"]));
  const type = toTrimmedString(pickFirst(value, ["type", "errorType"]));
  const message = toTrimmedString(pickFirst(value, ["message", "reason"]));
  const stack = toTrimmedString(pickFirst(value, ["stack", "stackTrace", "stack_trace"]));
  const codeCandidate = pickFirst(value, ["code", "errorCode"]);
  const details = sanitizeJsonObject(pickFirst(value, ["details", "metadata", "context"]));
  const cause = sanitizeJsonValue(pickFirst(value, ["cause"]));

  if (name !== undefined) {
    payload.name = name;
  }

  if (type !== undefined) {
    payload.type = type;
  }

  if (message !== undefined) {
    payload.message = message;
  }

  if (stack !== undefined) {
    payload.stack = stack;
  }

  if (typeof codeCandidate === "string" || typeof codeCandidate === "number") {
    payload.code = codeCandidate;
  }

  if (Object.keys(details).length > 0) {
    payload.details = details;
  }

  if (cause !== undefined) {
    payload.cause = cause;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    const tag = toTrimmedString(value);
    return tag ? [tag] : [];
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return toTrimmedString(entry);
        }

        if (typeof entry === "number" || typeof entry === "boolean") {
          return String(entry);
        }

        return undefined;
      })
      .filter((entry): entry is string => entry !== undefined);
  }

  if (isPlainObject(value)) {
    const tags: string[] = [];

    for (const [key, tagValue] of Object.entries(value)) {
      const normalizedKey = toTrimmedString(key);
      if (!normalizedKey) {
        continue;
      }

      if (typeof tagValue === "string" || typeof tagValue === "number" || typeof tagValue === "boolean") {
        tags.push(`${normalizedKey}:${String(tagValue)}`);
      }
    }

    return tags;
  }

  throw new SensraValidationError("`tags` must be a string, string array, or key/value object.", {
    receivedType: typeof value
  });
}

function normalizeMetadata(value: unknown): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new SensraValidationError("`metadata` must be an object when provided.", {
      receivedType: typeof value
    });
  }

  return sanitizeJsonObject(value);
}

function hasMeaningfulSignal(event: SensraEvent): boolean {
  return Boolean(
    event.message ||
      event.stackTrace ||
      (event.stackFrames && event.stackFrames.length > 0) ||
      (event.error && Object.keys(event.error).length > 0) ||
      (event.exception && Object.keys(event.exception).length > 0)
  );
}

export function validateNormalizedEvent(
  event: SensraEvent,
  limits: SensraValidationLimits = DEFAULT_VALIDATION_LIMITS
): void {
  if (!hasMeaningfulSignal(event)) {
    throw new SensraValidationError(
      "Event must include at least one meaningful signal: message, error/exception, stackTrace, or stackFrames."
    );
  }

  if (event.message && event.message.length > limits.maxMessageLength) {
    throw new SensraValidationError(`Event message exceeds ${limits.maxMessageLength} characters.`);
  }

  if (event.tags && event.tags.length > limits.maxTags) {
    throw new SensraValidationError(`Event tags exceed ${limits.maxTags} items.`);
  }

  if (event.tags) {
    const oversized = event.tags.find((tag) => tag.length > limits.maxTagLength);
    if (oversized) {
      throw new SensraValidationError(`Tag exceeds ${limits.maxTagLength} characters.`, {
        tag: oversized
      });
    }
  }

  if (event.stackFrames && event.stackFrames.length > limits.maxStackFrames) {
    throw new SensraValidationError(`Event stack frames exceed ${limits.maxStackFrames} items.`);
  }

  if (event.metadata && Object.keys(event.metadata).length > limits.maxMetadataKeys) {
    throw new SensraValidationError(`Event metadata exceeds ${limits.maxMetadataKeys} top-level keys.`);
  }
}

export function normalizeEvent(input: SensraEventInput, options: NormalizeEventOptions = {}): SensraEvent {
  if (!isPlainObject(input)) {
    throw new SensraValidationError("Event must be a plain object.");
  }

  const event: SensraEvent = {};

  const message = toTrimmedString(input.message);
  const level = normalizeLevel(input.level);
  const idempotencyKey = toTrimmedString(
    pickFirst(input, ["idempotencyKey", "idempotency_key", "eventId", "event_id"])
  );
  const timestamp = normalizeTimestamp(input.timestamp);
  const service = toTrimmedString(input.service) ?? options.service;
  const route = toTrimmedString(input.route);
  const environment = toTrimmedString(input.environment) ?? options.environment;
  const stackTrace = toTrimmedString(pickFirst(input, ["stackTrace", "stack_trace", "stack"]));
  const stackFrames = normalizeStackFrames(pickFirst(input, ["stackFrames", "stack_frames"]));
  const metadata = {
    ...(options.defaultMetadata ?? {}),
    ...normalizeMetadata(input.metadata)
  };

  const tags = [
    ...(options.defaultTags ?? []),
    ...normalizeTags(input.tags)
  ].filter((tag, index, source) => source.indexOf(tag) === index);

  const error = normalizeExceptionValue(input.error);
  const exception = normalizeExceptionValue(input.exception);

  if (message !== undefined) {
    event.message = message;
  }

  if (level !== undefined) {
    event.level = level;
  }

  if (idempotencyKey !== undefined) {
    event.idempotencyKey = idempotencyKey;
  }

  if (timestamp !== undefined) {
    event.timestamp = timestamp;
  }

  if (service !== undefined) {
    event.service = service;
  }

  if (route !== undefined) {
    event.route = route;
  }

  if (environment !== undefined) {
    event.environment = environment;
  }

  if (stackTrace !== undefined) {
    event.stackTrace = stackTrace;
  }

  if (stackFrames !== undefined) {
    event.stackFrames = stackFrames;
  }

  if (Object.keys(metadata).length > 0) {
    event.metadata = metadata;
  }

  if (tags.length > 0) {
    event.tags = tags;
  }

  if (error !== undefined) {
    event.error = error;
  }

  if (exception !== undefined) {
    event.exception = exception;
  }

  validateNormalizedEvent(event, options.limits ?? DEFAULT_VALIDATION_LIMITS);

  return event;
}
