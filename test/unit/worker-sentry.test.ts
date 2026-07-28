import assert from "node:assert/strict";
import { test } from "node:test";

import type { Event } from "@sentry/cloudflare";

import { REDACTED_VALUE, redactText } from "../../src/core/redaction.js";
import {
  createSentryOptions,
  isSentryRequestLoggingEnabled,
} from "../../worker/sentry.js";
import {
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentryLog,
  SENTRY_COMPLETION_LOG,
  SENTRY_PUBLIC_ENDPOINT,
} from "../../worker/sentry-sanitization.js";

const accessKey = "0123456789abcdef0123456789abcdef";
const secretKey =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const targetUrl = "https://private.example.test/account?token=target-secret";
const screenshotUrl =
  "https://cdn.example.test/private/screenshot.png?signature=image-secret";

void test("Sentry event sanitization removes request and MCP user data", () => {
  const event: Event = {
    message: `Failed with Bearer ${accessKey} for ${targetUrl}`,
    logentry: {
      message: `secret_key=${secretKey}`,
      params: [accessKey, targetUrl],
    },
    request: {
      url: `https://mcp.screenshotscout.com/mcp/api-key?access_key=${accessKey}`,
      method: "post",
      headers: {
        authorization: `Bearer ${accessKey}`,
        cookie: "session=user-cookie",
      },
      cookies: {
        session: "user-cookie",
      },
      query_string: `access_key=${accessKey}`,
      data: {
        access_key: accessKey,
        target_url: targetUrl,
      },
      env: {
        REMOTE_ADDR: "203.0.113.10",
      },
    },
    user: {
      id: "private-user",
      ip_address: "203.0.113.10",
    },
    extra: {
      access_key: accessKey,
      screenshot_url: screenshotUrl,
    },
    contexts: {
      request: {
        target_url: targetUrl,
      },
    },
    tags: {
      user_id: "private-user",
    },
    breadcrumbs: [
      {
        category: "fetch",
        message: `GET ${screenshotUrl}`,
        data: {
          url: screenshotUrl,
          authorization: `Bearer ${accessKey}`,
        },
      },
    ],
    exception: {
      values: [
        {
          type: "ScreenshotError",
          value: `secret_key=${secretKey} at ${targetUrl}`,
          thread_id: "private-user",
          mechanism: {
            type: "generic",
            handled: true,
            data: {
              authorization: accessKey,
            },
          },
          stacktrace: {
            frames: [
              {
                filename: screenshotUrl,
                function: "captureScreenshot",
                abs_path: targetUrl,
                context_line: `const key = "${secretKey}";`,
                vars: {
                  accessKey,
                },
                lineno: 42,
                colno: 7,
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    server_name: "private-host",
    fingerprint: [accessKey],
  };

  const sanitized = sanitizeSentryEvent(event);
  const serialized = JSON.stringify(sanitized);

  for (const sensitiveValue of [
    accessKey,
    secretKey,
    targetUrl,
    screenshotUrl,
    "user-cookie",
    "private-user",
    "203.0.113.10",
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false, sensitiveValue);
  }

  assert.deepEqual(sanitized.request, {
    url: SENTRY_PUBLIC_ENDPOINT,
    method: "POST",
  });
  assert.deepEqual(sanitized.tags, {
    service: "mcpserver",
    transport: "streamable-http",
  });
  assert.equal(sanitized.user, undefined);
  assert.equal(sanitized.extra, undefined);
  assert.equal(sanitized.contexts, undefined);
  assert.equal(sanitized.breadcrumbs?.[0]?.data, undefined);
  assert.equal(
    sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars,
    undefined,
  );
  assert.equal(
    sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.function,
    "captureScreenshot",
  );
});

void test("Sentry logs use a closed message and attribute allowlist", () => {
  const sanitized = sanitizeSentryLog({
    level: "error",
    message: SENTRY_COMPLETION_LOG,
    attributes: {
      http_method: `post ${accessKey}`,
      http_status: 201,
      duration_ms: 12.6,
      access_key: accessKey,
      target_url: targetUrl,
      screenshot_url: screenshotUrl,
      user_id: "private-user",
    },
  });

  assert.deepEqual(sanitized, {
    level: "info",
    message: SENTRY_COMPLETION_LOG,
    attributes: {
      service: "mcpserver",
      transport: "streamable-http",
      component: "worker",
      stage: "request.complete",
      http_method: "UNKNOWN",
      http_status: 201,
      duration_ms: 13,
    },
  });
  assert.equal(
    sanitizeSentryLog({
      level: "error",
      message: `unexpected ${accessKey}`,
      attributes: { access_key: accessKey },
    }),
    null,
  );
});

void test("Sentry options disable automatic sensitive-data collection", () => {
  const options = createSentryOptions({
    SENTRY_DSN: " test-dsn ",
    SENTRY_ENVIRONMENT: "production",
    SENTRY_REQUEST_LOGGING_ENABLED: "true",
  });

  assert.equal(options.dsn, "test-dsn");
  assert.equal(options.environment, "production");
  assert.equal(options.sampleRate, 1);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.enableLogs, true);
  assert.equal(options.enableMetrics, false);
  assert.equal(options.skipOpenTelemetrySetup, true);
  assert.deepEqual(options.tracePropagationTargets, []);
  assert.deepEqual(options.dataCollection, {
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
  });
});

void test("Sentry request logging uses the ApiGateway-compatible flag", () => {
  assert.equal(
    isSentryRequestLoggingEnabled({
      SENTRY_REQUEST_LOGGING_ENABLED: "yes",
    }),
    true,
  );
  assert.equal(
    isSentryRequestLoggingEnabled({
      SENTRY_REQUEST_LOGGING_ENABLED: "false",
    }),
    false,
  );
});

void test("credential redaction uses protocol context and exact values", () => {
  assert.equal(
    redactText(`Bearer ${accessKey}; secret_key=${secretKey}`),
    `Bearer ${REDACTED_VALUE}; secret_key=${REDACTED_VALUE}`,
  );
  assert.equal(
    redactText(`diagnostic ${accessKey}`, {
      sensitiveValues: [accessKey],
    }),
    `diagnostic ${REDACTED_VALUE}`,
  );
});

void test("Sentry sanitizers fail closed when an event value cannot be read", () => {
  const poisonedEvent = {};
  Object.defineProperty(poisonedEvent, "message", {
    get() {
      throw new Error(`Bearer ${accessKey}`);
    },
  });

  assert.deepEqual(sanitizeSentryEvent(poisonedEvent as Event), {
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
    tags: {
      service: "mcpserver",
      transport: "streamable-http",
    },
  });

  const poisonedBreadcrumb = {};
  Object.defineProperty(poisonedBreadcrumb, "message", {
    get() {
      throw new Error(targetUrl);
    },
  });
  assert.deepEqual(sanitizeSentryBreadcrumb(poisonedBreadcrumb), {
    category: "worker.sanitization",
    level: "warning",
    message: "A breadcrumb could not be sanitized safely.",
  });

  assert.equal(
    sanitizeSentryLog({
      level: "info",
      get message(): string {
        throw new Error(secretKey);
      },
    }),
    null,
  );
});
