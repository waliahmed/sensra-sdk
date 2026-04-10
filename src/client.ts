import { resolveClientConfig } from "./config";
import {
  SensraAuthError,
  SensraError,
  SensraRateLimitError,
  SensraServerError,
  SensraShutdownError,
  SensraTransportError,
  SensraValidationError
} from "./errors";
import { normalizeEvent, type NormalizeEventOptions } from "./normalize";
import type {
  SensraApiError,
  SensraApiResponse,
  SensraCaptureContext,
  SensraCaptureError,
  SensraCaptureResult,
  SensraBatchResult,
  SensraClientConfig,
  SensraEvent,
  SensraEventInput,
  SensraResolvedConfig,
  SensraShutdownOptions
} from "./types";
import { safeParseJsonResponse, sleep } from "./utils";

interface QueueItem {
  event: SensraEvent;
  resolve: (result: SensraCaptureResult) => void;
  reject: (error: SensraError) => void;
}

function isApiError(value: unknown): value is SensraApiError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  if (maybe.ok !== false) {
    return false;
  }

  if (!maybe.error || typeof maybe.error !== "object") {
    return false;
  }

  const error = maybe.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}

function isApiResponse(value: unknown): value is SensraApiResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;

  if (maybe.ok === true && "data" in maybe) {
    return true;
  }

  return isApiError(value);
}

function normalizeFailureCode(status: number): string {
  switch (status) {
    case 400:
      return "INVALID_REQUEST";
    case 401:
      return "INVALID_AUTH";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 500 ? "SERVER_ERROR" : "INGESTION_ERROR";
  }
}

function normalizeFailureMessage(status: number): string {
  switch (status) {
    case 400:
      return "Sensra rejected the event payload as invalid.";
    case 401:
      return "Sensra authentication failed. Verify your API key.";
    case 429:
      return "Sensra rate limit exceeded for this API key.";
    case 503:
      return "Sensra ingestion service is temporarily unavailable.";
    default:
      return `Sensra ingestion request failed with status ${status}.`;
  }
}

export class SensraClient {
  private readonly config: SensraResolvedConfig;
  private readonly endpoint: string;
  private readonly queue: QueueItem[] = [];

  private drainingPromise: Promise<void> | null = null;
  private acceptingEvents = true;
  private nextRequestAllowedAt = 0;
  private idempotencySequence = 0;

  public constructor(config: SensraClientConfig) {
    this.config = resolveClientConfig(config);
    this.endpoint = `${this.config.baseUrl}/api/v1/events`;
  }

  public captureEvent(event: SensraEventInput): Promise<SensraCaptureResult> {
    return Promise.resolve()
      .then(() => {
        const normalizedEvent = this.prepareEvent(event);
        return this.enqueue(normalizedEvent);
      })
      .catch((error) => {
        throw this.toPublicError(error, {
          operation: "captureEvent"
        });
      });
  }

  public captureException(
    error: unknown,
    context: SensraCaptureContext = {}
  ): Promise<SensraCaptureResult> {
    return Promise.resolve()
      .then(() => {
        const event: SensraEventInput = {
          ...context,
          level: context.level ?? "error",
          error,
          exception: error
        };

        if (event.message === undefined) {
          if (error instanceof Error) {
            event.message = error.message;
          } else if (typeof error === "string") {
            event.message = error;
          }
        }

        if (event.stackTrace === undefined && error instanceof Error && error.stack) {
          event.stackTrace = error.stack;
        }

        const normalizedEvent = this.prepareEvent(event);
        return this.enqueue(normalizedEvent);
      })
      .catch((captureError) => {
        throw this.toPublicError(captureError, {
          operation: "captureException"
        });
      });
  }

  public captureMessage(
    message: string,
    context: SensraCaptureContext = {}
  ): Promise<SensraCaptureResult> {
    return Promise.resolve()
      .then(() => {
        const normalizedEvent = this.prepareEvent({
          ...context,
          message,
          level: context.level ?? "info"
        });

        return this.enqueue(normalizedEvent);
      })
      .catch((error) => {
        throw this.toPublicError(error, {
          operation: "captureMessage"
        });
      });
  }

  public captureBatch(events: SensraEventInput[]): Promise<SensraBatchResult> {
    return Promise.resolve()
      .then(async () => {
        if (!Array.isArray(events)) {
          throw new SensraValidationError("`events` must be an array.");
        }

        if (events.length === 0) {
          throw new SensraValidationError("`events` cannot be empty.");
        }

        if (events.length > this.config.maxBatchItems) {
          throw new SensraValidationError(
            `Batch exceeds maxBatchItems (${this.config.maxBatchItems}).`,
            {
              received: events.length
            }
          );
        }

        // Phase 1: prepare all events upfront so validation failures cause zero enqueues/sends.
        const preparedEvents = events.map((event) => this.prepareEvent(event));

        // Phase 2: enqueue only after every event has been validated and normalized.
        const results = await this.enqueueMany(preparedEvents);
        const succeeded = results.filter((result) => result.ok).length;

        return {
          ok: succeeded === results.length,
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
          results
        };
      })
      .catch((error) => {
        throw this.toPublicError(error, {
          operation: "captureBatch"
        });
      });
  }

  public async flush(): Promise<void> {
    this.scheduleDrain();

    while (this.drainingPromise) {
      await this.drainingPromise;
    }
  }

  public async shutdown(options: SensraShutdownOptions = {}): Promise<void> {
    this.acceptingEvents = false;

    const timeoutMs = options.timeoutMs ?? this.config.shutdownTimeoutMs;
    const flushPromise = this.flush().then(() => "flushed" as const);
    const timeoutPromise = sleep(timeoutMs).then(() => "timeout" as const);

    const outcome = await Promise.race([flushPromise, timeoutPromise]);

    if (outcome === "timeout") {
      const pending = this.queue.splice(0);
      for (const item of pending) {
        item.reject(
          new SensraShutdownError(
            `Shutdown timed out after ${timeoutMs}ms before event could be sent.`,
            {
              timeoutMs,
              event: item.event
            }
          )
        );
      }
    }
  }

  private assertCaptureEnabled(): void {
    if (!this.acceptingEvents) {
      throw new SensraShutdownError("Cannot capture events after shutdown has started.");
    }
  }

  private getNormalizeOptions(): NormalizeEventOptions {
    const normalizeOptions: NormalizeEventOptions = {
      defaultMetadata: this.config.defaultMetadata,
      defaultTags: this.config.defaultTags
    };

    if (this.config.service !== undefined) {
      normalizeOptions.service = this.config.service;
    }

    if (this.config.environment !== undefined) {
      normalizeOptions.environment = this.config.environment;
    }

    return normalizeOptions;
  }

  private prepareEvent(event: SensraEventInput): SensraEvent {
    this.assertCaptureEnabled();
    const prepared = normalizeEvent(event, this.getNormalizeOptions());

    if (!prepared.idempotencyKey) {
      prepared.idempotencyKey = this.createIdempotencyKey(prepared);
    }

    return prepared;
  }

  private createIdempotencyKey(event: SensraEvent): string {
    this.idempotencySequence += 1;

    const randomPart =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2, 12);

    const messagePart = (event.message ?? "event").slice(0, 24).replace(/[^a-zA-Z0-9]+/g, "-");
    const timestampPart = Date.now().toString(36);
    const sequencePart = this.idempotencySequence.toString(36);

    return `snsr_${timestampPart}_${sequencePart}_${messagePart}_${randomPart}`;
  }

  private enqueue(event: SensraEvent): Promise<SensraCaptureResult> {
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new SensraValidationError("SDK queue is full. Increase maxQueueSize or flush faster.", {
        maxQueueSize: this.config.maxQueueSize
      });
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      this.scheduleDrain();
    });
  }

  private enqueueMany(events: SensraEvent[]): Promise<SensraCaptureResult[]> {
    if (this.queue.length + events.length > this.config.maxQueueSize) {
      throw new SensraValidationError("SDK queue is full. Increase maxQueueSize or flush faster.", {
        maxQueueSize: this.config.maxQueueSize,
        pending: this.queue.length,
        requested: events.length
      });
    }

    const pending = events.map(
      (event) =>
        new Promise<SensraCaptureResult>((resolve, reject) => {
          this.queue.push({ event, resolve, reject });
        })
    );

    this.scheduleDrain();
    return Promise.all(pending);
  }

  private scheduleDrain(): void {
    if (this.drainingPromise || this.queue.length === 0) {
      return;
    }

    this.drainingPromise = this.drainQueue().finally(() => {
      this.drainingPromise = null;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      }
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        return;
      }

      try {
        const result = await this.dispatchWithRetry(item.event);

        if (result.ok) {
          item.resolve(result);
          continue;
        }

        item.reject(this.toPublicError(result, { operation: "dispatch" }));
      } catch (error) {
        item.reject(
          this.toPublicError(error, {
            operation: "dispatch"
          })
        );
      }
    }
  }

  private async dispatchWithRetry(event: SensraEvent): Promise<SensraCaptureResult> {
    let lastResult: SensraCaptureResult | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      const result = await this.dispatchOnce(event, attempt);

      if (result.ok) {
        return result;
      }

      lastResult = result;
      if (!result.error?.retryable || attempt > this.config.maxRetries) {
        return result;
      }

      const retryHintMs = this.extractRetryHintMs(result.response);
      const backoffMs = this.computeRetryDelayMs(attempt, retryHintMs);
      await sleep(backoffMs);
    }

    return (
      lastResult ?? {
        ok: false,
        status: 0,
        attempts: 0,
        event,
        error: {
          code: "UNKNOWN_ERROR",
          message: "Unknown ingestion failure.",
          retryable: false
        }
      }
    );
  }

  private async dispatchOnce(event: SensraEvent, attempt: number): Promise<SensraCaptureResult> {
    await this.waitForRateLimitWindow();

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    let response: Response;

    try {
      response = await this.config.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sensra-api-key": this.config.apiKey,
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(event),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);

      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        status: 0,
        attempts: attempt,
        event,
        error: {
          code: aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
          message: aborted
            ? `Sensra ingestion request timed out after ${this.config.timeoutMs}ms.`
            : "Network error while sending event to Sensra.",
          retryable: true,
          details: error
        }
      };
    }

    clearTimeout(timeout);

    const parsedBody = await safeParseJsonResponse(response);

    if (parsedBody.readError !== undefined) {
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        event,
        error: {
          code: "RESPONSE_READ_ERROR",
          message: "Failed to read Sensra response body.",
          retryable: true,
          status: response.status,
          details: parsedBody.readError
        }
      };
    }

    if (response.status === 202 && isApiResponse(parsedBody.value) && parsedBody.value.ok === true) {
      return {
        ok: true,
        status: response.status,
        attempts: attempt,
        event,
        response: parsedBody.value
      };
    }

    const captureError = this.mapApiFailure(response.status, parsedBody.value);

    const result: SensraCaptureResult = {
      ok: false,
      status: response.status,
      attempts: attempt,
      event,
      error: captureError
    };

    if (isApiResponse(parsedBody.value)) {
      result.response = parsedBody.value;
    }

    return result;
  }

  private mapApiFailure(status: number, body: unknown): SensraCaptureError {
    if (isApiError(body)) {
      return {
        code: body.error.code,
        message: body.error.message,
        retryable: status === 429 || status === 503 || status >= 500,
        status,
        details: body.error.details
      };
    }

    return {
      code: normalizeFailureCode(status),
      message: normalizeFailureMessage(status),
      retryable: status === 429 || status === 503 || status >= 500,
      status,
      details: body
    };
  }

  private toPublicError(
    error: unknown,
    context: { operation: string }
  ): SensraError {
    if (error instanceof SensraError) {
      return error;
    }

    if (this.isCaptureResult(error)) {
      const source = error.error;
      const status = source?.status ?? error.status;
      const message = source?.message ?? "Sensra capture failed.";
      const details = {
        operation: context.operation,
        attempts: error.attempts,
        event: error.event,
        response: error.response,
        details: source?.details
      };

      if (status === 400) {
        return new SensraValidationError(message, details);
      }

      if (status === 401) {
        return new SensraAuthError(message, details);
      }

      if (status === 429) {
        return new SensraRateLimitError(message, details);
      }

      if (
        source?.code === "NETWORK_ERROR" ||
        source?.code === "REQUEST_TIMEOUT" ||
        source?.code === "RESPONSE_READ_ERROR" ||
        status === 0
      ) {
        const options: { code?: string; status?: number; retryable?: boolean; details?: unknown } = {
          details
        };

        if (source?.code !== undefined) {
          options.code = source.code;
        }

        if (status !== undefined) {
          options.status = status;
        }

        if (source?.retryable !== undefined) {
          options.retryable = source.retryable;
        }

        return new SensraTransportError(message, {
          ...options
        });
      }

      if (typeof status === "number" && status >= 500) {
        const options: { code?: string; status?: number; retryable?: boolean; details?: unknown } = {
          status,
          details
        };

        if (source?.code !== undefined) {
          options.code = source.code;
        }

        if (source?.retryable !== undefined) {
          options.retryable = source.retryable;
        }

        return new SensraServerError(message, {
          ...options
        });
      }

      return new SensraError(message, {
        code: source?.code ?? "SDK_INGESTION_ERROR",
        status,
        retryable: source?.retryable ?? false,
        details
      });
    }

    if (error instanceof Error) {
      return new SensraError(error.message, {
        code: "SDK_UNEXPECTED_ERROR",
        retryable: false,
        details: {
          operation: context.operation,
          cause: error
        },
        cause: error
      });
    }

    return new SensraError("Unexpected SDK error.", {
      code: "SDK_UNEXPECTED_ERROR",
      retryable: false,
      details: {
        operation: context.operation,
        cause: error
      },
      cause: error
    });
  }

  private isCaptureResult(value: unknown): value is SensraCaptureResult {
    if (!value || typeof value !== "object") {
      return false;
    }

    const maybe = value as Record<string, unknown>;
    return (
      typeof maybe.ok === "boolean" &&
      typeof maybe.status === "number" &&
      typeof maybe.attempts === "number" &&
      typeof maybe.event === "object"
    );
  }

  private extractRetryHintMs(response?: SensraApiResponse): number | undefined {
    if (!response || response.ok || !response.error || !response.error.details) {
      return undefined;
    }

    const details = response.error.details;

    if (!details || typeof details !== "object") {
      return undefined;
    }

    const values = details as Record<string, unknown>;

    const candidates = [
      values.retryAfterMs,
      values.retry_after_ms,
      values.retryInMs,
      values.retry_in_ms,
      values.waitMs,
      values.wait_ms
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
        return Math.trunc(candidate);
      }

      if (typeof candidate === "string" && candidate.trim().length > 0) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return Math.trunc(parsed);
        }
      }
    }

    return undefined;
  }

  private computeRetryDelayMs(attempt: number, hintMs?: number): number {
    if (hintMs !== undefined) {
      return Math.min(Math.max(hintMs, 0), this.config.retryMaxDelayMs);
    }

    const exponential = this.config.retryBaseDelayMs * 2 ** Math.max(attempt - 1, 0);
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(exponential + jitter, this.config.retryMaxDelayMs);
  }

  private async waitForRateLimitWindow(): Promise<void> {
    const minIntervalMs = Math.ceil(60_000 / this.config.maxRequestsPerMinute);
    const now = Date.now();

    if (this.nextRequestAllowedAt > now) {
      await sleep(this.nextRequestAllowedAt - now);
    }

    this.nextRequestAllowedAt = Date.now() + minIntervalMs;
  }
}
