import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  BinaryCaptureResponse,
  RawResponse,
  ScreenshotScoutClientOptions,
  ScreenshotScoutFetch,
} from "@screenshotscout/sdk";

import {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  SCREENSHOTSCOUT_API_KEY_MCP_PATH,
  SCREENSHOTSCOUT_MCP_SERVER_INSTRUCTIONS,
  SCREENSHOTSCOUT_MCP_SERVER_NAME,
  SCREENSHOTSCOUT_MCP_SERVER_VERSION,
  createScreenshotScoutApiKeyHttpHandler,
  type RedactedDiagnostic,
  type ScreenshotScoutApiKeyHttpHandler,
} from "../../../src/index.js";
import { startLoopbackScreenshotScoutHttpServer } from "../../../src/internal/loopback-http.js";
import { createPngHeader } from "../../fixtures/image-headers.js";

const protocolVersion = "2025-11-25";
const directHost = "mcp.example.test";
const directEndpoint = `https://${directHost}${SCREENSHOTSCOUT_API_KEY_MCP_PATH}`;

type UpstreamCaptureCall = {
  readonly accessKey: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly method: string | undefined;
  readonly signal: AbortSignal | null | undefined;
  readonly signalWasAbortedAtCall: boolean | undefined;
  readonly headers: Headers;
};

void test(
  "the loopback adapter initializes the stateless handler, lists the shared tool, and calls image and PDF captures",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("integration");
    const upstreamCalls: UpstreamCaptureCall[] = [];
    const upstreamFetch = createUpstreamFetch(upstreamCalls);
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      clientDependencies: { fetch: upstreamFetch },
    });
    const transport = new StreamableHTTPClientTransport(loopback.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessKey}` },
      },
    });
    const client = new Client({
      name: "screenshotscout-http-integration-test",
      version: "0.0.0",
    });
    let connected = false;

    try {
      await client.connect(transport as unknown as Transport);
      connected = true;
      assert.deepEqual(client.getServerVersion(), {
        name: SCREENSHOTSCOUT_MCP_SERVER_NAME,
        version: SCREENSHOTSCOUT_MCP_SERVER_VERSION,
      });
      assert.equal(
        client.getInstructions(),
        SCREENSHOTSCOUT_MCP_SERVER_INSTRUCTIONS,
      );
      assert.equal(transport.sessionId, undefined);

      const listed = await client.listTools();
      assert.equal(listed.tools.length, 1);
      assert.equal(listed.tools[0]?.name, CAPTURE_SCREENSHOT_TOOL_NAME);

      const image = asCallToolResult(
        await client.callTool({
          name: CAPTURE_SCREENSHOT_TOOL_NAME,
          arguments: {
            url: "https://target.example.test/image",
            format: "png",
          },
        }),
      );
      assert.equal(image.isError, undefined);
      assert.deepEqual(
        image.content.map((content) => content.type),
        ["text", "image"],
      );
      assert.deepEqual(image.structuredContent, {
        screenshotUrl: "https://cdn.example.test/capture.png",
        screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
        cacheStatus: "HIT",
        format: "png",
        mimeType: "image/png",
        imageWidth: 640,
        imageHeight: 480,
        inlineImageIncluded: true,
      });

      const pdf = asCallToolResult(
        await client.callTool({
          name: CAPTURE_SCREENSHOT_TOOL_NAME,
          arguments: {
            url: "https://target.example.test/report",
            format: "pdf",
            pdfPaperFormat: "a4",
          },
        }),
      );
      assert.equal(pdf.isError, undefined);
      assert.deepEqual(
        pdf.content.map((content) => content.type),
        ["text", "resource_link"],
      );
      assert.deepEqual(pdf.structuredContent, {
        screenshotUrl: "https://cdn.example.test/capture.pdf",
        screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
        cacheStatus: "MISS",
        format: "pdf",
        mimeType: "application/pdf",
        inlineImageIncluded: false,
      });

      assert.equal(upstreamCalls.length, 2);
      for (const call of upstreamCalls) {
        assert.equal(call.accessKey, accessKey);
        assert.equal(call.method, "POST");
        assert.ok(call.signal instanceof AbortSignal);
        assert.equal(call.signalWasAbortedAtCall, false);
        assert.equal(call.headers.get("authorization"), `Bearer ${accessKey}`);
        assert.equal(call.headers.get("content-type"), "application/json");
        for (const forbiddenField of [
          "accessKey",
          "access_key",
          "secretKey",
          "secret_key",
          "signature",
        ]) {
          assert.equal(Object.hasOwn(call.body, forbiddenField), false);
        }
      }
    } finally {
      if (connected) {
        await client.close().catch(() => undefined);
      }
      await loopback.close();
    }
  },
);

void test(
  "missing, malformed, query, body, tool, and alternate-header credentials are rejected without reaching Screenshot Scout",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("boundary");
    const secretKey = createSecretKey("boundary");
    const upstreamCalls: UpstreamCaptureCall[] = [];
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      clientDependencies: { fetch: createUpstreamFetch(upstreamCalls) },
    });
    const initializeBody = JSON.stringify(createInitializeRequest(1));

    try {
      const cases: readonly {
        readonly name: string;
        readonly url?: URL;
        readonly authorization?: string;
        readonly extraHeaders?: Readonly<Record<string, string>>;
        readonly body?: string;
        readonly expectedStatus: number;
        readonly sensitiveValue?: string;
      }[] = [
        {
          name: "missing Authorization",
          expectedStatus: 401,
        },
        {
          name: "non-Bearer Authorization",
          authorization: `Basic ${accessKey}`,
          expectedStatus: 401,
          sensitiveValue: accessKey,
        },
        {
          name: "malformed Bearer Authorization",
          authorization: `Bearer invalid key ${accessKey}`,
          expectedStatus: 401,
          sensitiveValue: accessKey,
        },
        {
          name: "query access key",
          url: new URL(
            `${loopback.url.toString()}?access_key=${encodeURIComponent(accessKey)}`,
          ),
          authorization: `Bearer ${accessKey}`,
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "query secret key",
          url: new URL(
            `${loopback.url.toString()}?secret_key=${encodeURIComponent(secretKey)}`,
          ),
          authorization: `Bearer ${accessKey}`,
          expectedStatus: 400,
          sensitiveValue: secretKey,
        },
        {
          name: "alternate access-key header",
          authorization: `Bearer ${accessKey}`,
          extraHeaders: { "X-Screenshot-Scout-Access-Key": accessKey },
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "alternate API-key header",
          authorization: `Bearer ${accessKey}`,
          extraHeaders: { "X-API-Key": accessKey },
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "secret-key header",
          authorization: `Bearer ${accessKey}`,
          extraHeaders: { "X-Screenshot-Scout-Secret-Key": secretKey },
          expectedStatus: 400,
          sensitiveValue: secretKey,
        },
        {
          name: "signature header",
          authorization: `Bearer ${accessKey}`,
          extraHeaders: { "X-Screenshot-Scout-Signature": secretKey },
          expectedStatus: 400,
          sensitiveValue: secretKey,
        },
        {
          name: "top-level body access key",
          authorization: `Bearer ${accessKey}`,
          body: JSON.stringify({
            ...createInitializeRequest(1),
            access_key: accessKey,
          }),
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "tool argument access key",
          authorization: `Bearer ${accessKey}`,
          body: JSON.stringify(
            createToolCallRequest(1, {
              url: "https://target.example.test",
              accessKey,
            }),
          ),
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "tool argument API key",
          authorization: `Bearer ${accessKey}`,
          body: JSON.stringify(
            createToolCallRequest(1, {
              url: "https://target.example.test",
              apiKey: accessKey,
            }),
          ),
          expectedStatus: 400,
          sensitiveValue: accessKey,
        },
        {
          name: "tool argument secret key",
          authorization: `Bearer ${accessKey}`,
          body: JSON.stringify(
            createToolCallRequest(1, {
              url: "https://target.example.test",
              secretKey,
            }),
          ),
          expectedStatus: 400,
          sensitiveValue: secretKey,
        },
      ];

      for (const item of cases) {
        const headers = new Headers({
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(item.authorization === undefined
            ? {}
            : { Authorization: item.authorization }),
          ...item.extraHeaders,
        });
        const response = await fetch(item.url ?? loopback.url, {
          method: "POST",
          headers,
          body: item.body ?? initializeBody,
        });
        const responseText = await response.text();

        assert.equal(
          response.status,
          item.expectedStatus,
          `${item.name} returned an unexpected status`,
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        if (item.sensitiveValue !== undefined) {
          assert.equal(
            responseText.includes(item.sensitiveValue),
            false,
            `${item.name} reflected a credential`,
          );
        }
      }

      assert.equal(upstreamCalls.length, 0);
    } finally {
      await loopback.close();
    }
  },
);

void test("Host and Origin validation is mandatory, port-agnostic, and fail-closed", async () => {
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    allowedOrigins: ["https://app.example.test"],
  });
  const body = createInitializeRequest(1);

  const missingHost = await sendDirectMcpRequest(handler, body, {
    host: null,
  });
  assert.equal(missingHost.status, 403);

  const invalidHost = await sendDirectMcpRequest(handler, body, {
    host: "attacker.example.test",
  });
  assert.equal(invalidHost.status, 403);

  const malformedHost = await sendDirectMcpRequest(handler, body, {
    host: "mcp.example.test, attacker.example.test",
  });
  assert.equal(malformedHost.status, 403);

  const noOrigin = await sendDirectMcpRequest(handler, body, {
    host: `${directHost}:8443`,
  });
  assert.equal(noOrigin.status, 200);

  const allowedOrigin = await sendDirectMcpRequest(handler, body, {
    origin: "https://app.example.test",
  });
  assert.equal(allowedOrigin.status, 200);

  const invalidOrigin = await sendDirectMcpRequest(handler, body, {
    origin: "https://attacker.example.test",
  });
  assert.equal(invalidOrigin.status, 403);

  const nullOrigin = await sendDirectMcpRequest(handler, body, {
    origin: "null",
  });
  assert.equal(nullOrigin.status, 403);

  const defaultOriginPolicy = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
  });
  const defaultOriginRejection = await sendDirectMcpRequest(
    defaultOriginPolicy,
    body,
    { origin: "https://app.example.test" },
  );
  assert.equal(defaultOriginRejection.status, 403);
});

void test("the endpoint reserves /mcp and rejects unsupported methods", async () => {
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
  });

  const reservedEndpoint = await handler(
    new Request(`https://${directHost}/mcp`, {
      method: "POST",
      headers: {
        Host: directHost,
        Authorization: `Bearer ${createAccessKey("reserved")}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createInitializeRequest(1)),
    }),
  );
  assert.equal(reservedEndpoint.status, 404);
  assert.equal(
    reservedEndpoint.headers.get("x-robots-tag"),
    "noindex, nofollow",
  );

  for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
    const response = await handler(
      new Request(directEndpoint, {
        method,
        headers: {
          Host: directHost,
          Authorization: `Bearer ${createAccessKey(method.toLowerCase())}`,
        },
      }),
    );

    assert.equal(response.status, 405, `${method} was not rejected`);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});

void test("content type, bounded body size, malformed JSON, and protocol errors return safe HTTP errors", async () => {
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    maxRequestBodyBytes: 512,
  });

  const wrongContentType = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(1),
    { contentType: "text/plain" },
  );
  assert.equal(wrongContentType.status, 415);

  const missingAccept = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(1),
    { accept: null },
  );
  assert.equal(missingAccept.status, 406);

  const tooLarge = await sendDirectMcpRequest(
    handler,
    `${JSON.stringify(createInitializeRequest(1))}${" ".repeat(513)}`,
    { rawBody: true },
  );
  assert.equal(tooLarge.status, 413);

  const declaredTooLarge = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(1),
    { contentLength: "513" },
  );
  assert.equal(declaredTooLarge.status, 413);

  const invalidContentLength = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(1),
    { contentLength: "not-a-number" },
  );
  assert.equal(invalidContentLength.status, 413);

  const malformedJson = await sendDirectMcpRequest(handler, "{not-json", {
    rawBody: true,
  });
  assert.equal(malformedJson.status, 400);
  assert.equal((await readJsonRpcError(malformedJson)).error.code, -32700);

  const invalidJsonRpc = await sendDirectMcpRequest(handler, {
    hello: "world",
  });
  assert.equal(invalidJsonRpc.status, 400);
  assert.equal((await readJsonRpcError(invalidJsonRpc)).error.code, -32700);

  const invalidProtocolVersion = await sendDirectMcpRequest(
    handler,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    },
    { protocolVersion: "1900-01-01" },
  );
  assert.equal(invalidProtocolVersion.status, 400);

  const validParameterizedContentType = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(2),
    { contentType: "application/json; charset=utf-8" },
  );
  assert.equal(validParameterizedContentType.status, 200);
});

void test(
  "signature_required remains a safe actionable tool error on the remote endpoint",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("signed");
    const secretMarker = createSecretKey("signed");
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      clientDependencies: {
        fetch: (_input, init) => {
          const headers = new Headers(init?.headers);
          const requestBody = init?.body;
          assert.ok(typeof requestBody === "string");
          assert.equal(headers.get("authorization"), `Bearer ${accessKey}`);
          assert.equal(headers.has("x-screenshot-scout-secret-key"), false);
          assert.equal(requestBody.includes(secretMarker), false);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error_code: "signature_required",
                error_message:
                  "A valid signature is required for this API key.",
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        },
      },
    });
    const transport = new StreamableHTTPClientTransport(loopback.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessKey}` },
      },
    });
    const client = new Client({
      name: "screenshotscout-http-signature-test",
      version: "0.0.0",
    });
    let connected = false;

    try {
      await client.connect(transport as unknown as Transport);
      connected = true;
      const result = asCallToolResult(
        await client.callTool({
          name: CAPTURE_SCREENSHOT_TOOL_NAME,
          arguments: {
            url: "https://target.example.test/signed",
            format: "png",
          },
        }),
      );
      const text = toolResultText(result);

      assert.equal(result.isError, true);
      assert.match(text, /HTTP status: 403/);
      assert.match(text, /Error code: signature_required/);
      assert.match(text, /local stdio or MCPB/i);
      assert.match(text, /Never send the secret key/i);
      assert.equal(text.includes(accessKey), false);
      assert.equal(text.includes(secretMarker), false);
    } finally {
      if (connected) {
        await client.close().catch(() => undefined);
      }
      await loopback.close();
    }
  },
);

void test("unexpected HTTP tool failures and diagnostics redact access keys and target URLs", async () => {
  const accessKey = createAccessKey("redaction");
  const targetUrl =
    "https://private.example.test/report?token=must-not-be-visible";
  const diagnostics: RedactedDiagnostic[] = [];
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    clientDependencies: {
      clientFactory: (options) => ({
        capture(target) {
          return Promise.reject(
            new Error(
              `Unexpected failure for ${target}; Authorization: Bearer ${options.accessKey}`,
            ),
          );
        },
      }),
    },
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  const response = await sendDirectMcpRequest(
    handler,
    createToolCallRequest(1, {
      url: targetUrl,
      format: "png",
    }),
    { accessKey },
  );
  const responseText = await response.text();
  const diagnosticText = JSON.stringify(diagnostics);

  assert.equal(response.status, 200);
  assert.match(responseText, /unexpected Screenshot Scout MCP error/i);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnosticText, /\[REDACTED/);
  for (const sensitiveValue of [accessKey, targetUrl]) {
    assert.equal(responseText.includes(sensitiveValue), false);
    assert.equal(diagnosticText.includes(sensitiveValue), false);
  }
});

void test("HTTP request cancellation aborts the in-flight Screenshot Scout capture", async () => {
  const accessKey = createAccessKey("cancellation");
  const requestAbortController = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let markCaptureStarted: (() => void) | undefined;
  const captureStarted = new Promise<void>((resolve) => {
    markCaptureStarted = resolve;
  });
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    clientDependencies: {
      clientFactory: () => ({
        capture(_targetUrl, _captureOptions, requestOptions) {
          observedSignal =
            requestOptions?.signal === null
              ? undefined
              : requestOptions?.signal;
          markCaptureStarted?.();

          return new Promise<BinaryCaptureResponse>((_resolve, reject) => {
            const signal = observedSignal;
            if (signal?.aborted === true) {
              reject(readAbortReason(signal));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(readAbortReason(signal)),
              {
                once: true,
              },
            );
          });
        },
      }),
    },
  });
  const responsePromise = sendDirectMcpRequest(
    handler,
    createToolCallRequest(1, {
      url: "https://target.example.test/slow",
      format: "png",
    }),
    {
      accessKey,
      signal: requestAbortController.signal,
    },
  );

  await captureStarted;
  requestAbortController.abort();
  const response = await responsePromise;
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(observedSignal?.aborted, true);
  assert.match(responseText, /capture was cancelled/i);
  assert.equal(responseText.includes(accessKey), false);
});

void test("concurrent requests use independent stateless transports even when JSON-RPC IDs collide", async () => {
  const accessKeys = [
    createAccessKey("concurrent_one"),
    createAccessKey("concurrent_two"),
  ] as const;
  const configuredClients: string[] = [];
  let activeCaptures = 0;
  let maximumActiveCaptures = 0;
  let releaseCaptures: (() => void) | undefined;
  const bothCapturesStarted = new Promise<void>((resolve) => {
    releaseCaptures = resolve;
  });
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    clientDependencies: {
      clientFactory: (options: ScreenshotScoutClientOptions) => {
        configuredClients.push(options.accessKey);
        assert.equal(Object.hasOwn(options, "secretKey"), false);

        return {
          async capture(targetUrl) {
            activeCaptures += 1;
            maximumActiveCaptures = Math.max(
              maximumActiveCaptures,
              activeCaptures,
            );
            if (activeCaptures === 2) releaseCaptures?.();
            await bothCapturesStarted;

            try {
              const targetName = new URL(targetUrl).pathname.slice(1);
              return createBinaryResponse(
                `https://cdn.example.test/${targetName}.png`,
              );
            } finally {
              activeCaptures -= 1;
            }
          },
        };
      },
    },
  });

  const requests = accessKeys.map((accessKey, index) =>
    sendDirectMcpRequest(
      handler,
      createToolCallRequest(7, {
        url: `https://target.example.test/capture-${index + 1}`,
        format: "png",
        resultMode: "url_only",
      }),
      { accessKey },
    ),
  );
  const responses = await Promise.all(requests);
  const messages = await Promise.all(
    responses.map(
      async (response) =>
        (await response.json()) as {
          readonly id: number;
          readonly result: {
            readonly structuredContent?: Record<string, unknown>;
          };
        },
    ),
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(
    messages.map((message) => message.id),
    [7, 7],
  );
  assert.deepEqual(new Set(configuredClients), new Set(accessKeys));
  assert.equal(maximumActiveCaptures, 2);
  assert.deepEqual(
    messages.map((message) => message.result.structuredContent?.screenshotUrl),
    [
      "https://cdn.example.test/capture-1.png",
      "https://cdn.example.test/capture-2.png",
    ],
  );
});

function createUpstreamFetch(
  calls: UpstreamCaptureCall[],
): ScreenshotScoutFetch {
  return (input, init) => {
    const inputUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const requestBody = init?.body;
    assert.equal(inputUrl, "https://api.screenshotscout.com/v1/capture");
    assert.ok(typeof requestBody === "string");
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    assert.match(authorization ?? "", /^Bearer /);
    const accessKey = authorization?.slice("Bearer ".length);
    assert.ok(accessKey);
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    calls.push({
      accessKey,
      body,
      method: init?.method,
      signal: init?.signal,
      signalWasAbortedAtCall: init?.signal?.aborted,
      headers,
    });

    if (body.format === "pdf") {
      return Promise.resolve(
        new Response("%PDF-1.7\n", {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Screenshot-Scout-Cache-Status": "MISS",
            "Screenshot-Scout-Screenshot-URL":
              "https://cdn.example.test/capture.pdf",
            "Screenshot-Scout-Screenshot-URL-Expires-At":
              "2026-07-25T12:00:00Z",
          },
        }),
      );
    }

    return Promise.resolve(
      new Response(createPngHeader(640, 480).buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Screenshot-Scout-Cache-Status": "HIT",
          "Screenshot-Scout-Screenshot-URL":
            "https://cdn.example.test/capture.png",
          "Screenshot-Scout-Screenshot-URL-Expires-At": "2026-07-25T12:00:00Z",
        },
      }),
    );
  };
}

function createInitializeRequest(
  id: number,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "screenshotscout-http-direct-test",
        version: "0.0.0",
      },
    },
  };
}

function createToolCallRequest(
  id: number,
  arguments_: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: arguments_,
    },
  };
}

type DirectMcpRequestOptions = {
  readonly accept?: string | null;
  readonly accessKey?: string;
  readonly contentLength?: string;
  readonly contentType?: string;
  readonly host?: string | null;
  readonly origin?: string;
  readonly protocolVersion?: string;
  readonly rawBody?: boolean;
  readonly signal?: AbortSignal;
};

function sendDirectMcpRequest(
  handler: ScreenshotScoutApiKeyHttpHandler,
  body: unknown,
  options: DirectMcpRequestOptions = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.host !== null) {
    headers.set("Host", options.host ?? directHost);
  }
  if (options.accept !== null) {
    headers.set(
      "Accept",
      options.accept ?? "application/json, text/event-stream",
    );
  }
  headers.set(
    "Authorization",
    `Bearer ${options.accessKey ?? createAccessKey("direct")}`,
  );
  headers.set("Content-Type", options.contentType ?? "application/json");
  if (options.contentLength !== undefined) {
    headers.set("Content-Length", options.contentLength);
  }
  if (options.origin !== undefined) {
    headers.set("Origin", options.origin);
  }
  if (options.protocolVersion !== undefined) {
    headers.set("MCP-Protocol-Version", options.protocolVersion);
  } else if (
    typeof body === "object" &&
    body !== null &&
    Reflect.get(body, "method") !== "initialize"
  ) {
    headers.set("MCP-Protocol-Version", protocolVersion);
  }

  return handler(
    new Request(directEndpoint, {
      method: "POST",
      headers,
      body:
        options.rawBody === true && typeof body === "string"
          ? body
          : JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  );
}

async function readJsonRpcError(response: Response): Promise<{
  readonly error: { readonly code: number; readonly message: string };
}> {
  return (await response.json()) as {
    readonly error: { readonly code: number; readonly message: string };
  };
}

function createAccessKey(label: string): string {
  return createHash("sha256")
    .update(`access:${label}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 32);
}

function createSecretKey(label: string): string {
  return createHash("sha256")
    .update(`secret:${label}:${randomUUID()}`)
    .digest("hex");
}

function readAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The HTTP request was cancelled.", "AbortError");
}

function asCallToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): CallToolResult {
  assert.ok("content" in result);
  assert.ok(Array.isArray(result.content));
  return result as CallToolResult;
}

function toolResultText(result: CallToolResult): string {
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content?.type === "text");
  return content.text;
}

function createBinaryResponse(screenshotUrl: string): BinaryCaptureResponse {
  const bytes = createPngHeader(320, 200);
  const rawResponse: RawResponse = {
    status: 200,
    statusText: "OK",
    headers: new Map<string, readonly string[]>(),
    contentType: "image/png",
    body: bytes,
  };
  return {
    kind: "binary",
    bytes,
    screenshotUrl,
    rawResponse,
  };
}
