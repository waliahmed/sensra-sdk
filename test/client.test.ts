import { describe, expect, it, vi } from "vitest";

import {
  SensraAuthError,
  SensraClient,
  SensraRateLimitError,
  SensraServerError,
  SensraShutdownError,
  SensraTransportError,
  SensraValidationError,
  type FetchLike
} from "../src";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;

  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return {
    promise,
    resolve: (value?: T) => {
      if (!resolve) {
        throw new Error("Deferred resolve called before initialization.");
      }

      resolve(value as T);
    }
  };
}

describe("SensraClient", () => {
  it("uses default endpoint and both auth headers", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, data: { id: "evt_1" } }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const result = await client.captureMessage("SDK ready");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const url = firstCall[0];
    const init = firstCall[1];
    expect(String(url)).toBe("https://sensra.io/api/v1/events");

    const headers = init?.headers as Record<string, string>;
    expect(headers["x-sensra-api-key"]).toBe("test_api_key");
    expect(headers.authorization).toBe("Bearer test_api_key");

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.message).toBe("SDK ready");
  });

  it("supports full baseUrl override", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, data: { id: "evt_2" } }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      baseUrl: "http://localhost:3000/",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    await client.captureMessage("local event");

    const [url] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe("http://localhost:3000/api/v1/events");
  });

  it("generates idempotency key when missing", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, data: { id: "evt_generated" } }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    await client.captureMessage("generated key event");

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(typeof body.idempotencyKey).toBe("string");
    expect(String(body.idempotencyKey).length).toBeGreaterThan(0);
  });

  it("preserves user-provided idempotency key", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, data: { id: "evt_custom" } }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    await client.captureEvent({
      message: "custom key event",
      event_id: "evt_custom_idempotency"
    });

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(body.idempotencyKey).toBe("evt_custom_idempotency");
  });

  it("preserves generated idempotency key across retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "temporary outage" }
          },
          503
        )
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "evt_retry_key" } }, 202));

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    await client.captureMessage("retry identity");

    const [, init1] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const [, init2] = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit];
    const body1 = JSON.parse(String(init1?.body)) as Record<string, unknown>;
    const body2 = JSON.parse(String(init2?.body)) as Record<string, unknown>;

    expect(body1.idempotencyKey).toBeDefined();
    expect(body1.idempotencyKey).toBe(body2.idempotencyKey);
  });

  it("retries retryable 429 failures and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "slow down",
              details: { retryAfterMs: 1 }
            }
          },
          429
        )
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "evt_3" } }, 202));

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    const result = await client.captureMessage("retry event");

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("enforces client-side batch limits", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxBatchItems: 1,
      maxRequestsPerMinute: 10_000
    });

    await expect(
      client.captureBatch([
        { message: "one" },
        { message: "two" }
      ])
    ).rejects.toThrow(SensraValidationError);
  });

  it("rejects when queue capacity would be exceeded", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxQueueSize: 1,
      maxBatchItems: 2,
      maxRequestsPerMinute: 10_000
    });

    await expect(
      client.captureBatch([
        { message: "overflow-1" },
        { message: "overflow-2" }
      ])
    ).rejects.toThrow(SensraValidationError);

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("rejects new capture calls after shutdown", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    await client.shutdown();

    const invoke = () => client.captureMessage("should fail");
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = invoke();
    }).not.toThrow();
    await expect(promise).rejects.toThrow(SensraShutdownError);
  });

  it("does not enqueue/send any event if batch validation fails", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const invoke = () =>
      client.captureBatch([
        { message: "valid" },
        { metadata: { requestId: "no-meaningful-signal" } }
      ]);

    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = invoke();
    }).not.toThrow();
    await expect(promise).rejects.toThrow(SensraValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("captureEvent returns rejected Promise instead of throwing synchronously", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }, 202)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const invoke = () => client.captureEvent({ metadata: { onlyMetadata: true } });

    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = invoke();
    }).not.toThrow();
    await expect(promise).rejects.toThrow(SensraValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("rejects with auth error for 401 and does not retry", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse({ ok: false, error: { code: "INVALID_AUTH", message: "bad key" } }, 401)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 3,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("auth failure")).rejects.toThrow(SensraAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with validation error for 400 and does not retry", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse({ ok: false, error: { code: "INVALID_REQUEST", message: "bad payload" } }, 400)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 3,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("bad payload")).rejects.toThrow(SensraValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 then rejects with rate-limit error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "RATE_LIMITED", message: "slow down", details: { retryAfterMs: 1 } }
          },
          429
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "RATE_LIMITED", message: "still slow", details: { retryAfterMs: 1 } }
          },
          429
        )
      );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("rate-limited")).rejects.toThrow(SensraRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 503 and rejects with server error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "temporary outage" }
          },
          503
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "still down" }
          },
          503
        )
      );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("service down")).rejects.toThrow(SensraServerError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx and rejects with server error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: "SERVER", message: "boom" } }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: "SERVER", message: "boom" } }, 500));

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("server error")).rejects.toThrow(SensraServerError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient network error and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "evt_network_retry" } }, 202));

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      maxRequestsPerMinute: 10_000
    });

    const result = await client.captureMessage("network transient");

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles response body read failure safely", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        status: 503,
        text: async () => {
          throw new Error("stream read failed");
        }
      } as unknown as Response;
    });

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 0,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureMessage("unreadable response")).rejects.toThrow(SensraTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captureBatch rejects consistently on operational failure", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "INVALID_AUTH", message: "bad key" } }, 401)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 0,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureBatch([{ message: "batch auth failure" }])).rejects.toThrow(SensraAuthError);
  });

  it("captureException rejects consistently on operational failure", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "INVALID_AUTH", message: "bad key" } }, 401)
    );

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRetries: 0,
      maxRequestsPerMinute: 10_000
    });

    await expect(client.captureException(new Error("boom"))).rejects.toThrow(SensraAuthError);
  });

  it("flush waits for queued work to complete", async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount += 1;

      if (callCount === 1) {
        await firstGate.promise;
      } else {
        await secondGate.promise;
      }

      return jsonResponse({ ok: true, data: {} }, 202);
    });

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const p1 = client.captureMessage("flush-1");
    const p2 = client.captureMessage("flush-2");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const flushPromise = client.flush();
    let flushed = false;
    void flushPromise.then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    firstGate.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    secondGate.resolve();
    await flushPromise;
    expect(flushed).toBe(true);

    await expect(p1).resolves.toMatchObject({ ok: true });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("shutdown timeout rejects queued events while allowing in-flight completion", async () => {
    const inFlightGate = deferred<void>();
    const fetchMock = vi.fn(async () => {
      await inFlightGate.promise;
      return jsonResponse({ ok: true, data: {} }, 202);
    });

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const p1 = client.captureMessage("in-flight");
    const p2 = client.captureMessage("queued");

    await new Promise((resolve) => setTimeout(resolve, 0));

    await client.shutdown({ timeoutMs: 20 });
    await expect(p2).rejects.toThrow(SensraShutdownError);

    inFlightGate.resolve();
    await expect(p1).resolves.toMatchObject({ ok: true });
  });

  it("shutdown waits for in-flight work when it can finish in time", async () => {
    const inFlightGate = deferred<void>();
    const fetchMock = vi.fn(async () => {
      await inFlightGate.promise;
      return jsonResponse({ ok: true, data: {} }, 202);
    });

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      maxRequestsPerMinute: 10_000
    });

    const capturePromise = client.captureMessage("shutdown-drain");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shutdownPromise = client.shutdown({ timeoutMs: 500 });

    await Promise.resolve();
    inFlightGate.resolve();

    await expect(shutdownPromise).resolves.toBeUndefined();
    await expect(capturePromise).resolves.toMatchObject({ ok: true });
  });

  it("supports end-to-end mocked ingestion flow", async () => {
    const receivedBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      receivedBodies.push(parsed);

      return jsonResponse(
        {
          ok: true,
          data: { id: `evt_${receivedBodies.length}` }
        },
        202
      );
    });

    const client = new SensraClient({
      apiKey: "test_api_key",
      fetch: fetchMock as unknown as FetchLike,
      service: "api",
      environment: "beta",
      defaultMetadata: { sdk: "sensra-js" },
      defaultTags: ["team:platform"],
      maxRequestsPerMinute: 10_000
    });

    await client.captureMessage("boot ok", { route: "/health", tags: ["boot"] });
    await client.captureException(new Error("database down"), { route: "/users", metadata: { reqId: "r1" } });
    await client.captureBatch([
      { message: "batch one", level: "info" },
      { message: "batch two", level: "error" }
    ]);
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const body of receivedBodies) {
      expect(body.service).toBe("api");
      expect(body.environment).toBe("beta");
      expect(typeof body.idempotencyKey).toBe("string");
      expect(body.idempotencyKey).not.toBe("");
    }

    expect(receivedBodies[0]?.tags).toEqual(["team:platform", "boot"]);
    expect(receivedBodies[1]?.metadata).toMatchObject({ sdk: "sensra-js", reqId: "r1" });
  });
});
