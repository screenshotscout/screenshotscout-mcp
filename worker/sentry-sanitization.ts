import type {
  Breadcrumb,
  CloudflareOptions,
  Event,
  Exception,
  StackFrame,
} from "@sentry/cloudflare";

import { redactText } from "../src/core/redaction.js";

export const SENTRY_SERVICE = "mcpserver";
export const SENTRY_TRANSPORT = "streamable-http";
export const SENTRY_COMPONENT = "worker";
export const SENTRY_ENDPOINT = "/mcp/api-key";
export const SENTRY_PUBLIC_ENDPOINT =
  "https://mcp.screenshotscout.com/mcp/api-key";
export const SENTRY_COMPLETION_LOG = "mcp_request_complete";

type SentryLog = Parameters<NonNullable<CloudflareOptions["beforeSendLog"]>>[0];

const SAFE_TAGS = {
  service: SENTRY_SERVICE,
  transport: SENTRY_TRANSPORT,
} as const;

export function sanitizeSentryEvent<T extends Event>(event: T): T {
  try {
    return sanitizeSentryEventInternal(event);
  } catch {
    return {
      level: "error",
      platform: "javascript",
      exception: {
        values: [
          {
            type: "SanitizationError",
            value: "A Worker error event could not be sanitized safely.",
          },
        ],
      },
      tags: { ...SAFE_TAGS },
    } as unknown as T;
  }
}

function sanitizeSentryEventInternal<T extends Event>(event: T): T {
  if (event.message !== undefined) {
    event.message = sanitizeText(event.message, 2_000);
  }

  if (event.logentry !== undefined) {
    event.logentry = {
      ...(event.logentry.message === undefined
        ? {}
        : { message: sanitizeText(event.logentry.message, 2_000) }),
    };
  }

  if (event.request !== undefined) {
    event.request = {
      url: SENTRY_PUBLIC_ENDPOINT,
      ...(event.request.method === undefined
        ? {}
        : { method: sanitizeHttpMethod(event.request.method) }),
    };
  }

  if (event.exception?.values !== undefined) {
    event.exception = {
      values: event.exception.values.map(sanitizeException),
    };
  }

  if (event.breadcrumbs !== undefined) {
    event.breadcrumbs = event.breadcrumbs.map(sanitizeSentryBreadcrumb);
  }

  event.tags = { ...SAFE_TAGS };
  if (event.transaction !== undefined) {
    event.transaction = `MCP ${SENTRY_ENDPOINT}`;
  }
  if (event.logger !== undefined) {
    event.logger = sanitizeText(event.logger, 200);
  }

  delete event.contexts;
  delete event.debug_meta;
  delete event.extra;
  delete event.fingerprint;
  delete event.measurements;
  delete event.modules;
  delete event.sdkProcessingMetadata;
  delete event.server_name;
  delete event.spans;
  delete event.start_timestamp;
  delete event.threads;
  delete event.transaction_info;
  delete event.user;

  return event;
}

export function sanitizeSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  try {
    return {
      ...(breadcrumb.type === undefined
        ? {}
        : { type: sanitizeText(breadcrumb.type, 100) }),
      ...(breadcrumb.level === undefined ? {} : { level: breadcrumb.level }),
      ...(breadcrumb.category === undefined
        ? {}
        : { category: sanitizeText(breadcrumb.category, 200) }),
      ...(breadcrumb.message === undefined
        ? {}
        : { message: sanitizeText(breadcrumb.message, 1_000) }),
      ...(breadcrumb.timestamp === undefined
        ? {}
        : { timestamp: breadcrumb.timestamp }),
    };
  } catch {
    return {
      category: "worker.sanitization",
      level: "warning",
      message: "A breadcrumb could not be sanitized safely.",
    };
  }
}

export function sanitizeSentryLog(log: SentryLog): SentryLog | null {
  try {
    return sanitizeSentryLogInternal(log);
  } catch {
    return null;
  }
}

function sanitizeSentryLogInternal(log: SentryLog): SentryLog | null {
  if (String(log.message) !== SENTRY_COMPLETION_LOG) return null;

  const attributes = log.attributes ?? {};
  const status = sanitizeStatus(attributes.http_status);
  const duration = sanitizeDuration(attributes.duration_ms);

  return {
    level: "info",
    message: SENTRY_COMPLETION_LOG,
    attributes: {
      service: SENTRY_SERVICE,
      transport: SENTRY_TRANSPORT,
      component: SENTRY_COMPONENT,
      stage: "request.complete",
      http_method: sanitizeHttpMethod(attributes.http_method),
      ...(status === undefined ? {} : { http_status: status }),
      ...(duration === undefined ? {} : { duration_ms: duration }),
    },
  };
}

export function sanitizeHttpMethod(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const method = value.trim().toUpperCase();
  return /^[A-Z]{1,16}$/.test(method) ? method : "UNKNOWN";
}

function sanitizeException(exception: Exception): Exception {
  return {
    ...(exception.type === undefined
      ? {}
      : { type: sanitizeText(exception.type, 200) }),
    ...(exception.value === undefined
      ? {}
      : { value: sanitizeText(exception.value, 2_000) }),
    ...(exception.module === undefined
      ? {}
      : { module: sanitizeText(exception.module, 500) }),
    ...(exception.mechanism === undefined
      ? {}
      : {
          mechanism: {
            type: sanitizeText(exception.mechanism.type, 200),
            ...(exception.mechanism.handled === undefined
              ? {}
              : { handled: exception.mechanism.handled }),
          },
        }),
    ...(exception.stacktrace?.frames === undefined
      ? {}
      : {
          stacktrace: {
            frames: exception.stacktrace.frames.map(sanitizeStackFrame),
          },
        }),
  };
}

function sanitizeStackFrame(frame: StackFrame): StackFrame {
  return {
    ...(frame.filename === undefined
      ? {}
      : { filename: sanitizeText(frame.filename, 500) }),
    ...(frame.function === undefined
      ? {}
      : { function: sanitizeText(frame.function, 500) }),
    ...(frame.module === undefined
      ? {}
      : { module: sanitizeText(frame.module, 500) }),
    ...(frame.platform === undefined
      ? {}
      : { platform: sanitizeText(frame.platform, 100) }),
    ...(isSafeInteger(frame.lineno) ? { lineno: frame.lineno } : {}),
    ...(isSafeInteger(frame.colno) ? { colno: frame.colno } : {}),
    ...(frame.in_app === undefined ? {} : { in_app: frame.in_app }),
  };
}

function sanitizeText(value: string, maxLength: number): string {
  return redactText(value, {
    redactUrls: true,
    maxLength,
  });
}

function sanitizeStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function sanitizeDuration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 3_600_000
    ? Math.round(value)
    : undefined;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
