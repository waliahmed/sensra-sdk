export interface SensraErrorOptions {
  code: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class SensraError extends Error {
  public readonly code: string;
  public readonly status: number | undefined;
  public readonly retryable: boolean;
  public readonly details: unknown;

  public constructor(message: string, options: SensraErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;

    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
  }
}

export class SensraConfigError extends SensraError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "SDK_CONFIG_ERROR",
      retryable: false,
      details
    });
  }
}

export class SensraValidationError extends SensraError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "SDK_VALIDATION_ERROR",
      status: 400,
      retryable: false,
      details
    });
  }
}

export class SensraShutdownError extends SensraError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "SDK_SHUTDOWN",
      retryable: false,
      details
    });
  }
}

export class SensraAuthError extends SensraError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "SDK_AUTH_ERROR",
      status: 401,
      retryable: false,
      details
    });
  }
}

export class SensraRateLimitError extends SensraError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "SDK_RATE_LIMIT",
      status: 429,
      retryable: true,
      details
    });
  }
}

export class SensraTransportError extends SensraError {
  public constructor(
    message: string,
    options: { code?: string; status?: number; retryable?: boolean; details?: unknown } = {}
  ) {
    const errorOptions: SensraErrorOptions = {
      code: options.code ?? "SDK_TRANSPORT_ERROR",
      retryable: options.retryable ?? true,
      details: options.details
    };

    if (options.status !== undefined) {
      errorOptions.status = options.status;
    }

    super(message, errorOptions);
  }
}

export class SensraServerError extends SensraError {
  public constructor(
    message: string,
    options: { code?: string; status?: number; retryable?: boolean; details?: unknown } = {}
  ) {
    const errorOptions: SensraErrorOptions = {
      code: options.code ?? "SDK_SERVER_ERROR",
      retryable: options.retryable ?? true,
      details: options.details
    };

    if (options.status !== undefined) {
      errorOptions.status = options.status;
    }

    super(message, errorOptions);
  }
}
