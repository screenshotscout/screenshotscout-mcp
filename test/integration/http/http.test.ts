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
  DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES,
  GET_WEBPAGE_MARKDOWN_TOOL_NAME,
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
const invoiceHtml =
  "<!doctype html>\n<html><head><title>Invoice #1042</title></head><body><h1>Invoice #1042</h1></body></html>\n";

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
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        [CAPTURE_SCREENSHOT_TOOL_NAME, GET_WEBPAGE_MARKDOWN_TOOL_NAME],
      );

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
  "html is sent upstream exactly as given, in a POST body without a URL",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("html");
    const upstreamCalls: UpstreamCaptureCall[] = [];
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      clientDependencies: { fetch: createUpstreamFetch(upstreamCalls) },
    });
    const transport = new StreamableHTTPClientTransport(loopback.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessKey}` },
      },
    });
    const client = new Client({
      name: "screenshotscout-http-html-test",
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
            html: invoiceHtml,
            format: "pdf",
            pdfPaperFormat: "a4",
          },
        }),
      );

      assert.equal(result.isError, undefined);
      assert.deepEqual(
        result.content.map((content) => content.type),
        ["text", "resource_link"],
      );
      assert.equal(upstreamCalls.length, 1);
      const call = upstreamCalls[0];
      assert.ok(call);
      assert.equal(call.accessKey, accessKey);
      assert.equal(call.method, "POST");
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signalWasAbortedAtCall, false);
      assert.equal(call.body.html, invoiceHtml);
      assert.equal(Object.hasOwn(call.body, "url"), false);
      assert.equal(call.body.format, "pdf");
      assert.equal(call.body.pdf_paper_format, "a4");
    } finally {
      if (connected) {
        await client.close().catch(() => undefined);
      }
      await loopback.close();
    }
  },
);

void test(
  "hosted clients ignore Screenshot Scout keys and base URL in the server's own environment",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("environment");
    const upstreamCalls: UpstreamCaptureCall[] = [];
    const previous = {
      access: process.env.SCREENSHOTSCOUT_ACCESS_KEY,
      secret: process.env.SCREENSHOTSCOUT_SECRET_KEY,
      baseUrl: process.env.SCREENSHOTSCOUT_BASE_URL,
    };
    process.env.SCREENSHOTSCOUT_ACCESS_KEY = "server-environment-access-key";
    process.env.SCREENSHOTSCOUT_SECRET_KEY = "server-environment-secret-key";
    process.env.SCREENSHOTSCOUT_BASE_URL = "http://server-environment.invalid";
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      clientDependencies: { fetch: createUpstreamFetch(upstreamCalls) },
    });
    const transport = new StreamableHTTPClientTransport(loopback.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessKey}` },
      },
    });
    const client = new Client({
      name: "screenshotscout-http-environment-test",
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
            url: "https://target.example.test/image",
            format: "png",
          },
        }),
      );

      assert.equal(result.isError, undefined);
      assert.equal(upstreamCalls.length, 1);
      const call = upstreamCalls[0];
      assert.ok(call);
      assert.equal(call.accessKey, accessKey);
      assert.equal(call.method, "POST");
      assert.equal(Object.hasOwn(call.body, "signature"), false);
    } finally {
      if (connected) {
        await client.close().catch(() => undefined);
      }
      await loopback.close();
      for (const [name, value] of [
        ["SCREENSHOTSCOUT_ACCESS_KEY", previous.access],
        ["SCREENSHOTSCOUT_SECRET_KEY", previous.secret],
        ["SCREENSHOTSCOUT_BASE_URL", previous.baseUrl],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

void test(
  "the handler sends captures to its configured base URL",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey("base_url");
    const upstreamCalls: UpstreamCaptureCall[] = [];
    const loopback = await startLoopbackScreenshotScoutHttpServer({
      baseUrl: "http://localhost:8787/",
      clientDependencies: {
        fetch: createUpstreamFetch(
          upstreamCalls,
          "http://localhost:8787/v1/capture",
        ),
      },
    });
    const transport = new StreamableHTTPClientTransport(loopback.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessKey}` },
      },
    });
    const client = new Client({
      name: "screenshotscout-http-base-url-test",
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
            url: "https://target.example.test/image",
            format: "png",
          },
        }),
      );

      assert.equal(result.isError, undefined);
      assert.equal(upstreamCalls.length, 1);
      assert.equal(upstreamCalls[0]?.accessKey, accessKey);
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
  assert.equal(
    (await readJsonRpcError(tooLarge)).error.message,
    "The MCP request body is too large. It can be at most 512 bytes.",
  );

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

void test("the default 1 MiB request limit leaves room for html", async () => {
  assert.equal(DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES, 1_024 * 1_024);

  const htmlCalls: string[] = [];
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    clientDependencies: {
      clientFactory: () => ({
        capture: () =>
          Promise.reject(new Error("URL captures are not expected.")),
        captureFromHtml(html) {
          htmlCalls.push(html);
          return Promise.resolve(
            createBinaryResponse("https://cdn.example.test/large.png"),
          );
        },
      }),
    },
  });
  // Well over the earlier 64 KiB limit.
  const largeHtml = `<!doctype html><title>Report</title><p>${"Row. ".repeat(100_000)}</p>`;
  const accepted = await sendDirectMcpRequest(
    handler,
    createToolCallRequest(1, {
      html: largeHtml,
      format: "png",
      resultMode: "url_only",
    }),
  );
  const acceptedMessage = (await accepted.json()) as {
    readonly result?: { readonly isError?: boolean };
  };

  assert.equal(accepted.status, 200);
  assert.equal(acceptedMessage.result?.isError, undefined);
  assert.equal(htmlCalls.length, 1);
  assert.equal(htmlCalls[0], largeHtml);

  const oversizedHtml = `<!doctype html><title>Report</title><p>${"x".repeat(1_024 * 1_024)}</p>`;
  const tooLarge = await sendDirectMcpRequest(
    handler,
    JSON.stringify(
      createToolCallRequest(2, { html: oversizedHtml, format: "png" }),
    ),
    { rawBody: true },
  );
  assert.equal(tooLarge.status, 413);

  const declaredTooLarge = await sendDirectMcpRequest(
    handler,
    createInitializeRequest(3),
    { contentLength: String(1_024 * 1_024 + 1) },
  );
  assert.equal(declaredTooLarge.status, 413);
  assert.equal(
    (await readJsonRpcError(declaredTooLarge)).error.message,
    "The MCP request body is too large. It can be at most 1 MiB.",
  );
  assert.equal(htmlCalls.length, 1);
});

// Many HTTP/1.1 clients send the whole body before reading the response, and see a reset connection
// instead of the 413 if the server stops reading.
void test("an oversized upload is read to the end, without being kept, before the 413", async () => {
  const handler = createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: [directHost],
    maxRequestBodyBytes: 512,
  });

  for (const declared of [true, false]) {
    let pulled = 0;
    let ended = false;
    let cancelled = false;
    const chunks = [
      new Uint8Array(400),
      new Uint8Array(400),
      new Uint8Array(400),
    ];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulled];
        if (chunk === undefined) {
          ended = true;
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers({
      Host: directHost,
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${createAccessKey("drain")}`,
      "Content-Type": "application/json",
    });
    if (declared) headers.set("Content-Length", "1200");

    const response = await handler(
      new Request(directEndpoint, {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit),
    );

    assert.equal(response.status, 413, `declared: ${declared}`);
    assert.deepEqual(
      { pulled, ended, cancelled },
      { pulled: 3, ended: true, cancelled: false },
      `declared: ${declared}`,
    );
  }
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

      // A secret key can't help with HTML, which only travels in a POST request.
      const htmlResult = asCallToolResult(
        await client.callTool({
          name: CAPTURE_SCREENSHOT_TOOL_NAME,
          arguments: { html: invoiceHtml, format: "png" },
        }),
      );
      const htmlText = toolResultText(htmlResult);

      assert.equal(htmlResult.isError, true);
      assert.match(htmlText, /Error code: signature_required/);
      assert.match(
        htmlText,
        /\nHow to resolve: This access key requires signed requests, which HTML can't use\. Use an access key that doesn't require signed requests\.$/,
      );
      assert.doesNotMatch(htmlText, /local stdio or MCPB/i);
      assert.equal(htmlText.includes(accessKey), false);
    } finally {
      if (connected) {
        await client.close().catch(() => undefined);
      }
      await loopback.close();
    }
  },
);

void test("unexpected HTTP tool failures and diagnostics redact access keys, target URLs and html", async () => {
  const accessKey = createAccessKey("redaction");
  const targetUrl =
    "https://private.example.test/report?token=must-not-be-visible";
  const html =
    "<!doctype html><html><head><title>Payroll</title></head><body><p>Salary: 98,765</p></body></html>";
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
        captureFromHtml(document) {
          return Promise.reject(
            new Error(
              `Unexpected failure for ${document}; Authorization: Bearer ${options.accessKey}`,
            ),
          );
        },
      }),
    },
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  const responseTexts: string[] = [];
  for (const target of [{ url: targetUrl }, { html }]) {
    const response = await sendDirectMcpRequest(
      handler,
      createToolCallRequest(1, { ...target, format: "png" }),
      { accessKey },
    );
    assert.equal(response.status, 200);
    responseTexts.push(await response.text());
  }
  const diagnosticText = JSON.stringify(diagnostics);

  assert.equal(diagnostics.length, 2);
  assert.match(diagnosticText, /\[REDACTED/);
  for (const responseText of responseTexts) {
    assert.match(responseText, /unexpected Screenshot Scout MCP error/i);
  }
  for (const sensitiveValue of [accessKey, targetUrl, html, "Salary"]) {
    for (const responseText of responseTexts) {
      assert.equal(responseText.includes(sensitiveValue), false);
    }
    assert.equal(diagnosticText.includes(sensitiveValue), false);
  }
});

void test("HTTP request cancellation aborts the in-flight Screenshot Scout capture", async (context) => {
  for (const [name, target] of [
    ["url", { url: "https://target.example.test/slow" }],
    ["html", { html: invoiceHtml }],
  ] as const) {
    await context.test(name, async () => {
      const accessKey = createAccessKey("cancellation");
      const requestAbortController = new AbortController();
      type RequestOptions =
        { readonly signal?: AbortSignal | null } | null | undefined;
      let observedRequestOptions: RequestOptions;
      let observedSignal: AbortSignal | undefined;
      let markCaptureStarted: (() => void) | undefined;
      const captureStarted = new Promise<void>((resolve) => {
        markCaptureStarted = resolve;
      });
      const waitForAbort = (
        requestOptions: RequestOptions,
      ): Promise<BinaryCaptureResponse> => {
        observedRequestOptions = requestOptions;
        observedSignal =
          requestOptions?.signal === null ? undefined : requestOptions?.signal;
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
      };
      const handler = createScreenshotScoutApiKeyHttpHandler({
        allowedHosts: [directHost],
        clientDependencies: {
          clientFactory: () => ({
            capture: (_targetUrl, _captureOptions, requestOptions) =>
              name === "url"
                ? waitForAbort(requestOptions)
                : Promise.reject(new Error("Expected an HTML capture.")),
            captureFromHtml: (_html, _captureOptions, requestOptions) =>
              name === "html"
                ? waitForAbort(requestOptions)
                : Promise.reject(new Error("Expected a URL capture.")),
          }),
        },
      });
      const responsePromise = sendDirectMcpRequest(
        handler,
        createToolCallRequest(1, { ...target, format: "png" }),
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
      // The tool picks no method, and captureFromHtml takes none.
      assert.deepEqual(Object.keys(observedRequestOptions ?? {}), ["signal"]);
      assert.equal(observedSignal?.aborted, true);
      assert.match(responseText, /capture was cancelled/i);
      assert.equal(responseText.includes(accessKey), false);
    });
  }
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
        configuredClients.push(options.accessKey ?? "");
        assert.equal(Object.hasOwn(options, "secretKey"), false);
        assert.equal(options.baseUrl, "https://api.screenshotscout.com");

        return {
          captureFromHtml: () =>
            Promise.reject(new Error("HTML captures are not expected.")),
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
  expectedUrl = "https://api.screenshotscout.com/v1/capture",
): ScreenshotScoutFetch {
  return (input, init) => {
    const inputUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const requestBody = init?.body;
    assert.equal(inputUrl, expectedUrl);
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
