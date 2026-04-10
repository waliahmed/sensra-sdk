import { describe, expect, it } from "vitest";

import { SensraValidationError } from "../src";
import { normalizeEvent } from "../src/normalize";

describe("normalizeEvent", () => {
  it("normalizes aliases, defaults, and structured fields", () => {
    const normalized = normalizeEvent(
      {
        message: "  hello world  ",
        level: "warn",
        event_id: "evt_123",
        timestamp: "2026-01-01T00:00:00.000Z",
        stack: "Error: boom",
        stack_frames: [{ functionName: "handler", filename: "app.ts", lineNumber: 10 }],
        metadata: { requestId: "req_1" },
        tags: { region: "us-east-1" }
      },
      {
        service: "api",
        environment: "production",
        defaultTags: ["sdk:ts"],
        defaultMetadata: { sdk: "sensra" }
      }
    );

    expect(normalized.message).toBe("hello world");
    expect(normalized.level).toBe("warning");
    expect(normalized.idempotencyKey).toBe("evt_123");
    expect(normalized.service).toBe("api");
    expect(normalized.environment).toBe("production");
    expect(normalized.stackTrace).toBe("Error: boom");
    expect(normalized.stackFrames?.[0]).toEqual({
      function: "handler",
      file: "app.ts",
      line: 10
    });
    expect(normalized.tags).toEqual(["sdk:ts", "region:us-east-1"]);
    expect(normalized.metadata).toEqual({ sdk: "sensra", requestId: "req_1" });
  });

  it("throws for events without meaningful signals", () => {
    expect(() =>
      normalizeEvent({
        service: "api",
        metadata: { requestId: "req_1" }
      })
    ).toThrow(SensraValidationError);
  });

  it("normalizes Error objects into exception payloads", () => {
    const error = new Error("database unavailable");

    const normalized = normalizeEvent({
      error,
      exception: error,
      message: "database unavailable"
    });

    expect(normalized.error?.message).toBe("database unavailable");
    expect(normalized.exception?.type).toBe("Error");
    expect(normalized.stackTrace).toBeUndefined();
  });
});
