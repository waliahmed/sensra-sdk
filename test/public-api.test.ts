import { describe, expect, it } from "vitest";

import * as sdk from "../src";

describe("public export surface", () => {
  it("keeps stable runtime exports and hides internal helpers", () => {
    const runtimeKeys = Object.keys(sdk).sort();

    expect(runtimeKeys).toEqual(
      [
        "SensraAuthError",
        "SensraClient",
        "SensraConfigError",
        "SensraError",
        "SensraRateLimitError",
        "SensraServerError",
        "SensraShutdownError",
        "SensraTransportError",
        "SensraValidationError"
      ].sort()
    );

    expect("normalizeEvent" in sdk).toBe(false);
    expect("validateNormalizedEvent" in sdk).toBe(false);
    expect("DEFAULT_VALIDATION_LIMITS" in sdk).toBe(false);
  });
});
