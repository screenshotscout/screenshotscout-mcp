import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ScreenshotScoutApiError,
  ScreenshotScoutConfigurationError,
  ScreenshotScoutResponseDecodingError,
  ScreenshotScoutSerializationError,
  ScreenshotScoutTransportError,
} from "@screenshotscout/sdk";

import {
  redactText,
  toRedactedDiagnostic,
  type RedactedDiagnostic,
} from "./redaction.js";
import { UnsafeCaptureResultError } from "./result.js";

/**
 * Thrown before sending a signed capture whose GET URL would be longer than
 * Cloudflare accepts. Only GET requests can be signed.
 */
export class SignedRequestTooLongError extends Error {
  constructor() {
    super("The signed capture URL would be longer than 16 KB.");
    this.name = "SignedRequestTooLongError";
  }
}

export type SafeOptionError = {
  readonly option: string;
  readonly message: string;
};

export type SafeScreenshotScoutError = {
  readonly category:
    | "api"
    | "cancelled"
    | "configuration"
    | "request_too_long"
    | "response"
    | "serialization"
    | "transport"
    | "unexpected"
    | "unsafe_result";
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly optionErrors?: readonly SafeOptionError[];
  readonly remediation?: string;
};

export type ErrorMappingOptions = {
  readonly sensitiveValues?: readonly (string | null | undefined)[];
  readonly onUnexpectedError?: (diagnostic: RedactedDiagnostic) => void;
};

export function mapScreenshotScoutError(
  error: unknown,
  options: ErrorMappingOptions = {},
): SafeScreenshotScoutError {
  try {
    return mapScreenshotScoutErrorInternal(error, options);
  } catch {
    reportUnexpectedError(error, options);
    return {
      category: "unexpected",
      message:
        "An unexpected Screenshot Scout MCP error occurred. Retry the request, and contact support if it continues.",
    };
  }
}

function mapScreenshotScoutErrorInternal(
  error: unknown,
  options: ErrorMappingOptions,
): SafeScreenshotScoutError {
  const sensitiveValues = options.sensitiveValues ?? [];

  if (error instanceof ScreenshotScoutApiError) {
    const code =
      error.errorCode === undefined
        ? undefined
        : safeErrorText(error.errorCode, sensitiveValues, 100);
    const message = safeErrorText(
      error.errorMessage ??
        `Screenshot Scout API request failed with status ${error.status}.`,
      sensitiveValues,
      1_000,
    );
    const optionErrors = readSafeOptionErrors(error.errors, sensitiveValues);
    const remediation =
      code === "signature_required"
        ? "This API key requires signed requests. Use local stdio or MCPB with the secret key, or use a dedicated key with signed requests disabled. Never send the secret key to a hosted MCP endpoint."
        : undefined;

    return {
      category: "api",
      message,
      status: error.status,
      ...(code === undefined ? {} : { code }),
      ...(optionErrors.length === 0 ? {} : { optionErrors }),
      ...(remediation === undefined ? {} : { remediation }),
    };
  }

  if (error instanceof SignedRequestTooLongError) {
    return {
      category: "request_too_long",
      message: "This capture is too long to send as a signed request.",
      remediation:
        "Shorten the URL or the selectors, or use an API key that doesn't require signed requests, without a secret key.",
    };
  }

  if (error instanceof ScreenshotScoutConfigurationError) {
    return {
      category: "configuration",
      message:
        "Screenshot Scout client configuration is invalid. Check the configured access key and local signing settings.",
    };
  }

  if (error instanceof ScreenshotScoutSerializationError) {
    const option =
      error.option === undefined
        ? undefined
        : safeErrorText(error.option, sensitiveValues, 100);
    return {
      category: "serialization",
      message:
        option === undefined
          ? "The screenshot request options could not be serialized safely."
          : `The screenshot request option "${option}" could not be serialized safely.`,
    };
  }

  if (error instanceof ScreenshotScoutTransportError) {
    return {
      category: "transport",
      message:
        "Screenshot Scout could not be reached before a response was received. Retry the capture.",
    };
  }

  if (error instanceof ScreenshotScoutResponseDecodingError) {
    return {
      category: "response",
      message:
        "Screenshot Scout returned an unexpected response that could not be handled safely.",
    };
  }

  if (error instanceof UnsafeCaptureResultError) {
    return {
      category: "unsafe_result",
      message:
        "Screenshot Scout returned result metadata that could not be exposed safely.",
    };
  }

  if (isAbortError(error)) {
    return {
      category: "cancelled",
      message: "The screenshot capture was cancelled.",
    };
  }

  reportUnexpectedError(error, options);
  return {
    category: "unexpected",
    message:
      "An unexpected Screenshot Scout MCP error occurred. Retry the request, and contact support if it continues.",
  };
}

export function formatScreenshotScoutError(
  error: unknown,
  options: ErrorMappingOptions = {},
): CallToolResult {
  const safeError = mapScreenshotScoutError(error, options);
  const lines = ["Screenshot Scout capture failed."];

  if (safeError.status !== undefined) {
    lines.push(`HTTP status: ${safeError.status}`);
  }
  if (safeError.code !== undefined) {
    lines.push(`Error code: ${safeError.code}`);
  }
  lines.push(`Message: ${safeError.message}`);

  if (
    safeError.optionErrors !== undefined &&
    safeError.optionErrors.length > 0
  ) {
    lines.push("Option errors:");
    for (const optionError of safeError.optionErrors) {
      lines.push(`- ${optionError.option}: ${optionError.message}`);
    }
  }
  if (safeError.remediation !== undefined) {
    lines.push(`How to resolve: ${safeError.remediation}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}

function readSafeOptionErrors(
  errors: readonly unknown[] | undefined,
  sensitiveValues: readonly (string | null | undefined)[],
): SafeOptionError[] {
  if (errors === undefined) return [];

  const output: SafeOptionError[] = [];
  for (const value of errors.slice(0, 25)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    let option: unknown;
    let message: unknown;
    try {
      option = Reflect.get(value, "option") as unknown;
      message = Reflect.get(value, "message") as unknown;
    } catch {
      continue;
    }
    if (typeof option !== "string" || typeof message !== "string") continue;

    output.push({
      option: safeErrorText(option, sensitiveValues, 100),
      message: safeErrorText(message, sensitiveValues, 500),
    });
  }
  return output;
}

function safeErrorText(
  value: string,
  sensitiveValues: readonly (string | null | undefined)[],
  maxLength: number,
): string {
  return redactText(value, {
    sensitiveValues,
    redactUrls: true,
    maxLength,
  });
}

function reportUnexpectedError(
  error: unknown,
  options: ErrorMappingOptions,
): void {
  try {
    if (options.onUnexpectedError === undefined) return;
    options.onUnexpectedError(
      toRedactedDiagnostic(error, {
        ...(options.sensitiveValues === undefined
          ? {}
          : { sensitiveValues: options.sensitiveValues }),
        redactUrls: true,
      }),
    );
  } catch {
    // Diagnostics must never replace the safe tool error.
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return Reflect.get(error, "name") === "AbortError";
  } catch {
    return false;
  }
}
