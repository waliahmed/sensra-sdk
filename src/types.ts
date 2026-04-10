export type SensraLevel = "debug" | "info" | "warning" | "error" | "critical";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface SensraStackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  raw?: string;
}

export interface SensraExceptionPayload {
  name?: string;
  type?: string;
  message?: string;
  code?: string | number;
  stack?: string;
  cause?: JsonValue;
  details?: JsonObject;
}

export interface SensraEventInput {
  message?: unknown;
  level?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
  eventId?: unknown;
  event_id?: unknown;
  timestamp?: unknown;
  service?: unknown;
  route?: unknown;
  environment?: unknown;
  stack?: unknown;
  stackTrace?: unknown;
  stack_trace?: unknown;
  stackFrames?: unknown;
  stack_frames?: unknown;
  metadata?: unknown;
  tags?: unknown;
  error?: unknown;
  exception?: unknown;
  [key: string]: unknown;
}

export interface SensraEvent {
  message?: string;
  level?: SensraLevel;
  idempotencyKey?: string;
  timestamp?: string;
  service?: string;
  route?: string;
  environment?: string;
  stackTrace?: string;
  stackFrames?: SensraStackFrame[];
  metadata?: JsonObject;
  tags?: string[];
  error?: SensraExceptionPayload;
  exception?: SensraExceptionPayload;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SensraClientConfig {
  apiKey: string;
  baseUrl?: string;
  service?: string;
  environment?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxQueueSize?: number;
  maxBatchItems?: number;
  maxRequestsPerMinute?: number;
  shutdownTimeoutMs?: number;
  defaultMetadata?: Record<string, unknown>;
  defaultTags?: string[];
}

export interface SensraResolvedConfig {
  apiKey: string;
  baseUrl: string;
  service?: string;
  environment?: string;
  fetch: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxQueueSize: number;
  maxBatchItems: number;
  maxRequestsPerMinute: number;
  shutdownTimeoutMs: number;
  defaultMetadata: JsonObject;
  defaultTags: string[];
}

export interface SensraApiSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface SensraApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type SensraApiResponse<T = unknown> = SensraApiSuccess<T> | SensraApiError;

export interface SensraCaptureError {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  details?: unknown;
}

export interface SensraCaptureResult {
  ok: boolean;
  status: number;
  attempts: number;
  event: SensraEvent;
  response?: SensraApiResponse;
  error?: SensraCaptureError;
}

export interface SensraBatchResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: SensraCaptureResult[];
}

export interface SensraCaptureContext extends Omit<SensraEventInput, "message" | "error" | "exception"> {}

export interface SensraShutdownOptions {
  timeoutMs?: number;
}

export interface SensraValidationLimits {
  maxMessageLength: number;
  maxTags: number;
  maxTagLength: number;
  maxStackFrames: number;
  maxMetadataKeys: number;
}
