import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CaptureHttpMethod,
  ScreenshotScoutApiError,
  type BinaryCaptureOptions,
  type BinaryCaptureResponse,
  type CaptureRequestOptions,
  type RawResponse,
} from "@screenshotscout/sdk";

import {
  invokeCaptureScreenshot,
  registerCaptureScreenshotTool,
  type CaptureScreenshotToolDependencies,
} from "../../src/core/capture-tool.js";
import { parseCaptureScreenshotInput } from "../../src/core/capture-input.js";
import type { ScreenshotScoutCaptureClient } from "../../src/core/client.js";
import { INLINE_IMAGE_OMISSION_REASONS } from "../../src/core/image.js";
import {
  CAPTURE_SCREENSHOT_TOOL_ANNOTATIONS,
  CAPTURE_SCREENSHOT_TOOL_DESCRIPTION,
  CAPTURE_SCREENSHOT_TOOL_NAME,
  CAPTURE_SCREENSHOT_TOOL_TITLE,
} from "../../src/core/tool-metadata.js";
import {
  createJpegHeader,
  createPngHeader,
  createWebpHeader,
} from "../fixtures/image-headers.js";

type RecordedCaptureCall = {
  readonly targetUrl: string;
  readonly captureOptions: BinaryCaptureOptions | null | undefined;
  readonly captureRequestOptions: CaptureRequestOptions | null | undefined;
};

const curatedInputNames = [
  "blockAds",
  "blockChatWidgets",
  "blockCookieBanners",
  "cache",
  "cacheTtl",
  "clickSelectors",
  "colorScheme",
  "country",
  "delay",
  "device",
  "deviceViewportHeight",
  "deviceViewportWidth",
  "format",
  "fullPage",
  "hideSelectors",
  "imageHeight",
  "imageQuality",
  "imageWidth",
  "navigationTimeout",
  "pdfLandscape",
  "pdfMargin",
  "pdfMarginBottom",
  "pdfMarginLeft",
  "pdfMarginRight",
  "pdfMarginTop",
  "pdfPageRanges",
  "pdfPaperFormat",
  "pdfPrintBackground",
  "pdfScale",
  "resultMode",
  "selector",
  "timeout",
  "url",
  "waitUntil",
] as const;

const structuredOutputNames = [
  "cacheStatus",
  "format",
  "imageHeight",
  "imageWidth",
  "inlineImageIncluded",
  "inlineImageOmissionReason",
  "mimeType",
  "screenshotUrl",
  "screenshotUrlExpiresAt",
] as const;

function createRecordingClient(
  responseFactory: () => BinaryCaptureResponse | Promise<BinaryCaptureResponse>,
): {
  readonly client: ScreenshotScoutCaptureClient;
  readonly calls: RecordedCaptureCall[];
} {
  const calls: RecordedCaptureCall[] = [];
  const client: ScreenshotScoutCaptureClient = {
    async capture(targetUrl, captureOptions, captureRequestOptions) {
      calls.push({ targetUrl, captureOptions, captureRequestOptions });
      return responseFactory();
    },
  };
  return { client, calls };
}

function createBinaryResponse(
  options: {
    readonly screenshotUrl?: string;
    readonly screenshotUrlExpiresAt?: string;
    readonly cacheStatus?: string;
    readonly contentType?: string | null;
    readonly bytes?: Uint8Array;
  } = {},
): BinaryCaptureResponse {
  const bytes = options.bytes ?? Uint8Array.of(137, 80, 78, 71);
  const rawResponse: RawResponse = {
    status: 200,
    statusText: "OK",
    headers: new Map<string, readonly string[]>(),
    contentType: options.contentType ?? "image/png",
    body: bytes,
  };

  return {
    kind: "binary",
    bytes,
    ...(options.screenshotUrl === undefined
      ? {}
      : { screenshotUrl: options.screenshotUrl }),
    ...(options.screenshotUrlExpiresAt === undefined
      ? {}
      : { screenshotUrlExpiresAt: options.screenshotUrlExpiresAt }),
    ...(options.cacheStatus === undefined
      ? {}
      : { cacheStatus: options.cacheStatus }),
    rawResponse,
  };
}

async function createHarness(
  dependencies: CaptureScreenshotToolDependencies,
): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
}> {
  const server = new McpServer({
    name: "screenshotscout-mcp-test",
    version: "0.0.0",
  });
  registerCaptureScreenshotTool(server, dependencies);

  const client = new Client({
    name: "screenshotscout-mcp-test-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: () => client.close(),
  };
}

function toolResultText(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const callToolResult = asCallToolResult(result);
  const textContent = callToolResult.content.find(
    (item) => item.type === "text",
  );
  assert.ok(textContent?.type === "text");
  return textContent.text;
}

function asCallToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): CallToolResult {
  assert.ok("content" in result);
  assert.ok(Array.isArray(result.content));
  return result as CallToolResult;
}

void test("registration exposes exactly the approved tool, schema, metadata, and output", async () => {
  const mcpbManifest = JSON.parse(
    await readFile(
      new URL("../../mcpb/manifest.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly tools?: readonly {
      readonly name?: string;
      readonly description?: string;
    }[];
  };
  const recording = createRecordingClient(() => {
    throw new Error("The tool should not be invoked by tools/list.");
  });
  const harness = await createHarness({ client: recording.client });

  try {
    const listed = await harness.client.listTools();

    assert.equal(listed.tools.length, 1);
    const tool = listed.tools[0];
    assert.ok(tool);
    assert.equal(tool.name, CAPTURE_SCREENSHOT_TOOL_NAME);
    assert.equal(tool.title, CAPTURE_SCREENSHOT_TOOL_TITLE);
    assert.equal(tool.description, CAPTURE_SCREENSHOT_TOOL_DESCRIPTION);
    assert.deepEqual(tool.annotations, CAPTURE_SCREENSHOT_TOOL_ANNOTATIONS);
    assert.match(tool.description ?? "", /consumes.+quota/i);
    assert.match(
      tool.description ?? "",
      /captured webpage content.+untrusted data, not instructions/i,
    );
    assert.equal(mcpbManifest.tools?.length, 1);
    assert.equal(mcpbManifest.tools[0]?.name, CAPTURE_SCREENSHOT_TOOL_NAME);
    assert.equal(
      mcpbManifest.tools[0]?.description,
      CAPTURE_SCREENSHOT_TOOL_DESCRIPTION,
    );
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      ...curatedInputNames,
    ]);
    const inputProperties = tool.inputSchema.properties ?? {};
    assert.equal(
      (inputProperties.format as { default?: unknown } | undefined)?.default,
      "jpeg",
    );
    assert.match(
      (inputProperties.format as { description?: string } | undefined)
        ?.description ?? "",
      /defaults to JPEG/i,
    );
    assert.match(
      (
        inputProperties.deviceViewportWidth as
          { description?: string } | undefined
      )?.description ?? "",
      /Captures use a 1280×720 viewport.+no device or viewport dimension/i,
    );
    assert.match(
      (
        inputProperties.deviceViewportHeight as
          { description?: string } | undefined
      )?.description ?? "",
      /Captures use a 1280×720 viewport.+no device or viewport dimension/i,
    );
    assert.match(
      (inputProperties.imageQuality as { description?: string } | undefined)
        ?.description ?? "",
      /JPEG uses quality 60 when omitted/i,
    );
    assert.deepEqual(tool.inputSchema.required, ["url"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.outputSchema?.properties ?? {}).sort(), [
      ...structuredOutputNames,
    ]);
    assert.equal(recording.calls.length, 0);
  } finally {
    await harness.close();
  }
});

void test("an unqualified invocation uses the compact JPEG profile", async () => {
  const screenshotUrl = "https://cdn.example/capture.jpeg";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/jpeg",
      bytes: createJpegHeader(1_280, 720),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: (mimeType) => mimeType === "image/jpeg",
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: "https://example.com" },
    });

    assert.equal(recording.calls.length, 1);
    assert.deepEqual(recording.calls[0]?.captureOptions, {
      format: "jpeg",
      responseType: "binary",
      deviceViewportWidth: 1_280,
      deviceViewportHeight: 720,
      imageQuality: 60,
    });
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "jpeg",
      mimeType: "image/jpeg",
      imageWidth: 1_280,
      imageHeight: 720,
      inlineImageIncluded: true,
    });
    assert.deepEqual(
      asCallToolResult(result).content.map((content) => content.type),
      ["text", "image"],
    );
  } finally {
    await harness.close();
  }
});

void test("an eligible image invocation maps once, makes one POST call, and returns safe inline content", async () => {
  const screenshotUrl = "https://cdn.example/capture.webp";
  const bytes = createWebpHeader(1_200, 800);
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
      cacheStatus: "MISS",
      contentType: "image/webp; charset=binary",
      bytes,
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: (mimeType) => mimeType === "image/webp",
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com/dashboard",
        format: "webp",
        fullPage: false,
        imageWidth: 1_200,
        imageHeight: 800,
        imageQuality: 90,
        resultMode: "auto",
      },
    });

    assert.equal(recording.calls.length, 1);
    const call = recording.calls[0];
    assert.ok(call);
    assert.equal(call.targetUrl, "https://example.com/dashboard");
    assert.deepEqual(call.captureOptions, {
      format: "webp",
      responseType: "binary",
      deviceViewportWidth: 1_280,
      deviceViewportHeight: 720,
      fullPage: false,
      imageWidth: 1_200,
      imageHeight: 800,
      imageQuality: 90,
    });
    assert.equal(call.captureRequestOptions?.method, CaptureHttpMethod.POST);
    assert.ok(call.captureRequestOptions?.signal instanceof AbortSignal);

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
      cacheStatus: "MISS",
      format: "webp",
      mimeType: "image/webp",
      imageWidth: 1_200,
      imageHeight: 800,
      inlineImageIncluded: true,
    });
    assert.deepEqual(
      asCallToolResult(result).content.map((content) => content.type),
      ["text", "image"],
    );
    assert.equal(
      toolResultText(result),
      `Screenshot capture completed.\nTemporary result URL: ${screenshotUrl}\nThe compatible image is included inline.`,
    );
    const imageContent = asCallToolResult(result).content[1];
    assert.ok(imageContent?.type === "image");
    assert.equal(imageContent.mimeType, "image/webp");
    assert.deepEqual(
      Buffer.from(imageContent.data, "base64"),
      Buffer.from(bytes),
    );
    assert.equal(
      toolResultText(result).includes("example.com/dashboard"),
      false,
    );
  } finally {
    await harness.close();
  }
});

void test("with signed requests, a capture checks the signed URL length and makes one GET call", async () => {
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      contentType: "image/png",
      bytes: Uint8Array.of(1),
    }),
  );
  const builtUrls: { targetUrl: string; captureOptions: unknown }[] = [];
  const harness = await createHarness({
    client: recording.client,
    signedRequests: {
      buildCaptureUrl(targetUrl, captureOptions) {
        builtUrls.push({ targetUrl, captureOptions });
        return "https://api.screenshotscout.com/v1/capture?url=short";
      },
    },
  });

  try {
    await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: "https://example.com/signed", format: "png" },
    });

    assert.equal(recording.calls.length, 1);
    const call = recording.calls[0];
    assert.ok(call);
    assert.equal(call.captureRequestOptions?.method, CaptureHttpMethod.GET);
    assert.deepEqual(builtUrls, [
      {
        targetUrl: "https://example.com/signed",
        captureOptions: call.captureOptions,
      },
    ]);
  } finally {
    await harness.close();
  }
});

void test("with signed requests, a capture whose URL would pass 16 KB fails before any API call", async () => {
  const recording = createRecordingClient(() =>
    createBinaryResponse({ contentType: "image/png", bytes: Uint8Array.of(1) }),
  );
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: recording.client,
    signedRequests: { buildCaptureUrl: () => "x".repeat(16_001) },
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: "https://example.com/long", format: "png" },
    });

    assert.equal(result.isError, true);
    assert.equal(
      toolResultText(result),
      "Screenshot Scout capture failed.\nMessage: This capture is too long to send as a signed request.\nHow to resolve: Shorten the URL or the selectors, or use an API key that doesn't require signed requests, without a secret key.",
    );
    assert.equal(recording.calls.length, 0);
    assert.deepEqual(diagnostics, []);
  } finally {
    await harness.close();
  }
});

void test("a PDF invocation never embeds bytes and returns a temporary resource link", async () => {
  const screenshotUrl = "https://cdn.example/capture.pdf";
  const bytes = Uint8Array.of(37, 80, 68, 70);
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "application/pdf",
      bytes,
    }),
  );
  const harness = await createHarness({ client: recording.client });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com/report",
        format: "pdf",
        imageWidth: 1_200,
        imageHeight: 800,
        pdfPaperFormat: "a4",
        pdfLandscape: true,
        pdfPrintBackground: false,
        pdfMargin: "0.5in",
        pdfMarginTop: "10px",
        pdfMarginRight: "12mm",
        pdfMarginBottom: "1cm",
        pdfMarginLeft: "0",
        pdfScale: 1.25,
        resultMode: "auto",
      },
    });

    assert.equal(recording.calls.length, 1);
    assert.deepEqual(recording.calls[0]?.captureOptions, {
      format: "pdf",
      responseType: "binary",
      deviceViewportWidth: 1_280,
      deviceViewportHeight: 720,
      imageWidth: 1_200,
      imageHeight: 800,
      pdfPaperFormat: "a4",
      pdfLandscape: true,
      pdfPrintBackground: false,
      pdfMargin: "0.5in",
      pdfMarginTop: "10px",
      pdfMarginRight: "12mm",
      pdfMarginBottom: "1cm",
      pdfMarginLeft: "0",
      pdfScale: 1.25,
    });
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "pdf",
      mimeType: "application/pdf",
      inlineImageIncluded: false,
    });
    assert.deepEqual(
      asCallToolResult(result).content.map((content) => content.type),
      ["text", "resource_link"],
    );
    assert.equal(
      toolResultText(result),
      `PDF capture completed.\nTemporary result URL: ${screenshotUrl}`,
    );
    assert.deepEqual(asCallToolResult(result).content[1], {
      type: "resource_link",
      uri: screenshotUrl,
      name: "screenshot-scout-capture.pdf",
      title: "Screenshot Scout PDF capture",
      description: "Temporary PDF capture generated by Screenshot Scout.",
      mimeType: "application/pdf",
      size: bytes.byteLength,
    });
  } finally {
    await harness.close();
  }
});

void test("the configured whole-result ceiling can force a safe serialized-size fallback", async () => {
  const screenshotUrl = "https://cdn.example/capture.png";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/png",
      bytes: createPngHeader(640, 480),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: () => true,
    maxSerializedResultBytes: 100,
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com",
        format: "png",
        resultMode: "auto",
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "png",
      mimeType: "image/png",
      imageWidth: 640,
      imageHeight: 480,
      inlineImageIncluded: false,
      inlineImageOmissionReason:
        INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
    });
    assert.deepEqual(
      asCallToolResult(result).content.map((content) => content.type),
      ["text"],
    );
    assert.match(toolResultText(result), /complete tool result/i);
    assert.match(toolResultText(result), /temporary URL/);
  } finally {
    await harness.close();
  }
});

void test("url_only omits eligible image bytes and returns dimensions plus an actionable URL fallback", async () => {
  const screenshotUrl = "https://cdn.example/capture.png";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/png",
      bytes: createPngHeader(900, 600),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: () => true,
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com",
        format: "png",
        resultMode: "url_only",
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "png",
      mimeType: "image/png",
      imageWidth: 900,
      imageHeight: 600,
      inlineImageIncluded: false,
      inlineImageOmissionReason:
        INLINE_IMAGE_OMISSION_REASONS.RESULT_MODE_URL_ONLY,
    });
    assert.deepEqual(
      asCallToolResult(result).content.map((content) => content.type),
      ["text"],
    );
    assert.match(toolResultText(result), /resultMode was url_only/);
    assert.match(toolResultText(result), /Temporary result URL:/);
  } finally {
    await harness.close();
  }
});

void test("client-incompatible images safely fall back to the URL without failing the capture", async () => {
  const screenshotUrl = "https://cdn.example/capture.png";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/png",
      bytes: createPngHeader(800, 500),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: () => false,
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com",
        format: "png",
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "png",
      mimeType: "image/png",
      imageWidth: 800,
      imageHeight: 500,
      inlineImageIncluded: false,
      inlineImageOmissionReason:
        INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE,
    });
    assert.equal(asCallToolResult(result).content.length, 1);
    assert.match(toolResultText(result), /resultMode: url_only/);
    assert.match(toolResultText(result), /current client/i);
  } finally {
    await harness.close();
  }
});

void test("TIFF remains URL-only even when the client compatibility probe returns true", async () => {
  const screenshotUrl = "https://cdn.example/capture.tiff";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/tiff",
      bytes: Uint8Array.of(73, 73, 42, 0),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: () => true,
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com",
        format: "tiff",
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "tiff",
      mimeType: "image/tiff",
      inlineImageIncluded: false,
      inlineImageOmissionReason:
        INLINE_IMAGE_OMISSION_REASONS.FORMAT_NOT_INLINE_ELIGIBLE,
    });
    assert.equal(asCallToolResult(result).content.length, 1);
    assert.match(toolResultText(result), /URL-only/);
    assert.match(toolResultText(result), /resultMode: url_only/);
  } finally {
    await harness.close();
  }
});

void test("registered runtime validation rejects incompatible input before quota is consumed", async () => {
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl: "https://cdn.example/should-not-exist.png",
    }),
  );
  const harness = await createHarness({ client: recording.client });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: {
        url: "https://example.com",
        format: "pdf",
        pdfScale: 3,
      },
    });

    assert.equal(result.isError, true);
    assert.match(toolResultText(result), /pdfScale/);
    assert.equal(recording.calls.length, 0);
  } finally {
    await harness.close();
  }
});

void test("expected SDK errors preserve safe actionable fields and redact sensitive data", async () => {
  const accessKey = "0123456789abcdef0123456789abcdef";
  const secretKey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const targetUrl = "https://private.example/report?token=target-secret";
  const rawBody = new TextEncoder().encode(
    JSON.stringify({ accessKey, secretKey, targetUrl }),
  );
  const apiError = new ScreenshotScoutApiError({
    rawResponse: {
      status: 400,
      statusText: "Bad Request",
      headers: new Map([["authorization", [`Bearer ${accessKey}`]]]),
      contentType: "application/json",
      body: rawBody,
    },
    responseBody: { accessKey, secretKey, targetUrl },
    errorCode: "invalid_options",
    errorMessage: `Invalid request for ${targetUrl} using ${accessKey}.`,
    errors: [
      {
        option: "url",
        message: `The target ${targetUrl} is invalid for ${secretKey}.`,
      },
    ],
  });
  const recording = createRecordingClient(() => Promise.reject(apiError));
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: recording.client,
    sensitiveValues: [accessKey, secretKey],
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: targetUrl },
    });
    const text = toolResultText(result);

    assert.equal(recording.calls.length, 1);
    assert.equal(result.isError, true);
    assert.match(text, /HTTP status: 400/);
    assert.match(text, /Error code: invalid_options/);
    assert.match(text, /Option errors:/);
    assert.match(text, /\[REDACTED/);
    for (const sensitiveText of [
      accessKey,
      secretKey,
      targetUrl,
      new TextDecoder().decode(rawBody),
    ]) {
      assert.equal(text.includes(sensitiveText), false);
    }
    assert.equal(diagnostics.length, 0);
  } finally {
    await harness.close();
  }
});

void test("unexpected errors are generic and diagnostics are fully redacted", async () => {
  const accessKey = "abcdef0123456789abcdef0123456789";
  const secretKey =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const targetUrl = "https://private.example/dashboard?token=hidden";
  const recording = createRecordingClient(() => {
    throw new Error(
      `Failure for ${targetUrl}; Authorization: Bearer ${accessKey}; secret_key=${secretKey}`,
    );
  });
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: recording.client,
    sensitiveValues: [accessKey, secretKey],
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: targetUrl },
    });
    const text = toolResultText(result);
    const serializedDiagnostics = JSON.stringify(diagnostics);

    assert.equal(result.isError, true);
    assert.match(text, /unexpected Screenshot Scout MCP error/i);
    assert.equal(diagnostics.length, 1);
    assert.match(serializedDiagnostics, /\[REDACTED/);
    for (const sensitiveText of [accessKey, secretKey, targetUrl]) {
      assert.equal(text.includes(sensitiveText), false);
      assert.equal(serializedDiagnostics.includes(sensitiveText), false);
    }
  } finally {
    await harness.close();
  }
});

void test("reason-string cancellations do not emit unexpected diagnostics", async () => {
  const abortController = new AbortController();
  const diagnostics: unknown[] = [];
  const client: ScreenshotScoutCaptureClient = {
    capture(_targetUrl, _captureOptions, captureRequestOptions) {
      const signal =
        captureRequestOptions?.signal === null
          ? undefined
          : captureRequestOptions?.signal;
      assert.ok(signal);
      assert.equal(signal, abortController.signal);
      abortController.abort("The client cancelled this request.");
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- The MCP SDK forwards client cancellation reasons as strings.
      return Promise.reject(signal.reason);
    },
  };

  const result = await invokeCaptureScreenshot(
    parseCaptureScreenshotInput({ url: "https://example.com" }),
    {
      client,
      onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
    },
    { signal: abortController.signal },
  );
  const textContent = result.content.find((item) => item.type === "text");

  assert.equal(result.isError, true);
  assert.ok(textContent?.type === "text");
  assert.match(textContent.text, /capture was cancelled/i);
  assert.equal(diagnostics.length, 0);
});

void test("credential-bearing success URLs become safe tool errors", async () => {
  const accessKey = "fedcba9876543210fedcba9876543210";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl: `https://cdn.example/capture.png?access_key=${accessKey}`,
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    sensitiveValues: [accessKey],
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: "https://example.com" },
    });
    const text = toolResultText(result);

    assert.equal(result.isError, true);
    assert.match(text, /metadata that could not be exposed safely/i);
    assert.equal(text.includes(accessKey), false);
    assert.equal(text.includes("cdn.example"), false);
  } finally {
    await harness.close();
  }
});
