import * as Sentry from "@sentry/cloudflare";
import type { CloudflareOptions } from "@sentry/cloudflare";

import type { RedactedDiagnostic } from "../src/core/redaction.js";
import {
  sanitizeHttpMethod,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentryLog,
  SENTRY_COMPLETION_LOG,
  SENTRY_COMPONENT,
  SENTRY_SERVICE,
  SENTRY_TRANSPORT,
} from "./sentry-sanitization.js";

export type WorkerEnv = {
  readonly SENTRY_DSN?: string;
  readonly SENTRY_ENVIRONMENT?: string;
  readonly SENTRY_REQUEST_LOGGING_ENABLED?: string;
};

const disabledDataCollection: NonNullable<CloudflareOptions["dataCollection"]> =
  {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: false,
      response: false,
    },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: {
      document: false,
      variables: false,
    },
    genAI: {
      inputs: false,
      outputs: false,
    },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  };

export function createSentryOptions(env: WorkerEnv): CloudflareOptions {
  const dsn = env.SENTRY_DSN?.trim();

  return {
    ...(dsn === undefined || dsn.length === 0 ? {} : { dsn }),
    environment: normalizeEnvironment(env.SENTRY_ENVIRONMENT),
    sampleRate: 1,
    tracesSampleRate: 0,
    enableLogs: isSentryRequestLoggingEnabled(env),
    enableMetrics: false,
    skipOpenTelemetrySetup: true,
    enableRpcTracePropagation: false,
    tracePropagationTargets: [],
    propagateTraceparent: false,
    streamGenAiSpans: false,
    enhanceFetchErrorMessages: false,
    sendClientReports: false,
    maxBreadcrumbs: 20,
    maxValueLength: 2_000,
    normalizeDepth: 3,
    normalizeMaxBreadth: 50,
    dataCollection: disabledDataCollection,
    beforeBreadcrumb: sanitizeSentryBreadcrumb,
    beforeSend: sanitizeSentryEvent,
    beforeSendLog: sanitizeSentryLog,
    beforeSendTransaction: () => null,
  };
}

export function captureUnexpectedWorkerError(
  diagnostic: RedactedDiagnostic,
): void {
  try {
    const error = new Error(diagnostic.message);
    error.name = diagnostic.name;
    if (diagnostic.stack !== undefined) error.stack = diagnostic.stack;

    Sentry.captureException(error, {
      tags: {
        service: SENTRY_SERVICE,
        transport: SENTRY_TRANSPORT,
      },
    });
  } catch {
    // Observability must never affect the Worker response.
  }
}

export function logSentryRequestCompletion(
  env: WorkerEnv,
  request: Request,
  response: Response,
  durationMs: number,
): void {
  if (!isSentryRequestLoggingEnabled(env)) return;

  try {
    Sentry.logger.info(SENTRY_COMPLETION_LOG, {
      service: SENTRY_SERVICE,
      transport: SENTRY_TRANSPORT,
      component: SENTRY_COMPONENT,
      stage: "request.complete",
      http_method: sanitizeHttpMethod(request.method),
      http_status: response.status,
      duration_ms: durationMs,
    });
  } catch {
    // Observability must never affect the Worker response.
  }
}

export function isSentryRequestLoggingEnabled(env: WorkerEnv): boolean {
  const value = env.SENTRY_REQUEST_LOGGING_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeEnvironment(value: string | undefined): string {
  const environment = value?.trim().toLowerCase();
  if (
    environment === "development" ||
    environment === "preview" ||
    environment === "production" ||
    environment === "staging"
  ) {
    return environment;
  }
  return "production";
}
