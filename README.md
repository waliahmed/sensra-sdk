# @sensra/sdk

Official Sensra JavaScript/TypeScript SDK for sending errors, exceptions, logs, and incident-like events to the Sensra ingestion API.

Release maturity: **Public Beta**.

## Install

```bash
npm install @sensra/sdk
```

## Quick Start

```ts
import { SensraClient } from "@sensra/sdk";

const sensra = new SensraClient({
  apiKey: process.env.SENSRA_API_KEY!,
  baseUrl: "https://sensra.io", // default
  service: "api",
  environment: "production"
});

await sensra.captureMessage("Application started", {
  level: "info",
  route: "/health"
});

try {
  throw new Error("Database unavailable");
} catch (error) {
  await sensra.captureException(error, {
    route: "/users",
    metadata: { region: "us-east-1" }
  });
}

await sensra.flush();
await sensra.shutdown();
```

## API

- `new SensraClient(config)`
- `captureEvent(event)`
- `captureException(error, context?)`
- `captureMessage(message, context?)`
- `captureBatch(events)`
- `flush()`
- `shutdown(options?)`

All capture methods return Promises.

- Success: Promise resolves with a `SensraCaptureResult` (or `SensraBatchResult` for `captureBatch`).
- Failure: Promise rejects with a typed SDK error.

## Configuration

```ts
new SensraClient({
  apiKey: "...", // required
  baseUrl: "https://sensra.io", // default and fully overridable
  service: "api",
  environment: "production",

  // optional tuning
  timeoutMs: 5000,
  maxRetries: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 5000,
  maxRequestsPerMinute: 170,
  maxQueueSize: 1000,
  maxBatchItems: 50,
  shutdownTimeoutMs: 10000,
  defaultMetadata: { sdk: "sensra-js" },
  defaultTags: ["team:platform"]
});
```

## Endpoint And Auth

- Default endpoint: `https://sensra.io`
- Ingestion path: `POST /api/v1/events`
- Full `baseUrl` override is supported for:
  - localhost: `http://localhost:3000`
  - staging
  - enterprise dedicated domains such as `https://acme.sensra.io`
- Auth headers sent on every request:
  - `x-sensra-api-key`
  - `Authorization: Bearer <key>`

## Method Behavior

### `captureEvent(event)`

Send a normalized event payload.

### `captureException(error, context?)`

Builds an event from an `Error` or error-like value and context.

### `captureMessage(message, context?)`

Convenience wrapper for message events.

### `captureBatch(events)`

Validates all events first, then enqueues all events.

- If any event in the batch is invalid, **none** are enqueued/sent.
- Batch size defaults to `50` (`maxBatchItems`).

### `flush()`

Waits until all currently queued/in-flight sends complete.

### `shutdown(options?)`

Stops accepting new captures and attempts to flush outstanding work.

- If shutdown times out, queued unsent events reject with `SensraShutdownError`.
- In-flight work may still finish if its request resolves after timeout.

## Retry Behavior

Retries apply only to transient failures:

- retried: network errors, request timeout, `429`, `503`, `5xx`
- not retried: `400`, `401`

Backoff uses exponential delay + jitter with configurable limits.

## Queue And Backpressure

- Queue is bounded by `maxQueueSize` (default `1000`).
- If enqueue would exceed capacity, capture rejects with `SensraValidationError`.
- Queue overflow never silently drops accepted events.

## Validation And Normalization

- Strict client-side validation occurs before send.
- Empty/weak events are rejected.
- Common aliases are normalized (`event_id`, `idempotency_key`, `stack_frames`, etc.).

## Idempotency Behavior

- User-supplied idempotency keys always win (`idempotencyKey`, `idempotency_key`, `eventId`, `event_id`).
- If missing, SDK generates a fallback idempotency key during preparation.
- Retries for the same prepared event preserve the same idempotency key.
- Generated keys are process-local retry-safety helpers, **not** a cross-process dedupe guarantee.

## Error Semantics

The SDK rejects with typed errors so callers can branch behavior safely:

- `SensraValidationError`
- `SensraAuthError`
- `SensraRateLimitError`
- `SensraTransportError`
- `SensraServerError`
- `SensraShutdownError`
- `SensraConfigError`
- `SensraError` (base class)

## Public API Surface

The stable runtime export surface is intentionally small:

- `SensraClient`
- public error classes
- public TypeScript types

Internal normalization/validation helpers are not exported from the package entrypoint.

## CI And Releases

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`
- semantic-release config: `.releaserc.json`
- Changelog file: `CHANGELOG.md`

Required GitHub secret for publishing:

- `NPM_TOKEN`

## Commit Convention

Use Conventional Commits for automated releases:

- `fix:` -> patch
- `feat:` -> minor
- `feat!:` or `BREAKING CHANGE:` -> major
