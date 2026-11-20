import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ScreenshotScoutApiError,
  ScreenshotScoutConfigurationError,
  type BinaryCaptureOptions,
  type BinaryCaptureResponse,
  type CaptureFromHtmlRequestOptions,
  type CaptureRequestOptions,
  type RawResponse,
  type ScreenshotScoutFetch,
} from "@screenshotscout/sdk";

import {
  invokeCaptureScreenshot,
  registerCaptureScreenshotTool,
  type CaptureScreenshotToolDependencies,
} from "../../src/core/capture-tool.js";
import { parseCaptureScreenshotInput } from "../../src/core/capture-input.js";
import {
  createScreenshotScoutClient,
  type ScreenshotScoutCaptureClient,
} from "../../src/core/client.js";
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

type RecordedHtmlCaptureCall = {
  readonly html: string;
  readonly captureOptions: BinaryCaptureOptions | null | undefined;
  readonly requestOptions: CaptureFromHtmlRequestOptions | null | undefined;
};

const invoiceHtml =
  "<!doctype html>\n<html><head><title>Invoice #1042</title></head><body><h1>Invoice #1042</h1><p>Total: $1,250.00</p></body></html>\n";

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
  "html",
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
  readonly htmlCalls: RecordedHtmlCaptureCall[];
} {
  const calls: RecordedCaptureCall[] = [];
  const htmlCalls: RecordedHtmlCaptureCall[] = [];
  const client: ScreenshotScoutCaptureClient = {
    async capture(targetUrl, captureOptions, captureRequestOptions) {
      calls.push({ targetUrl, captureOptions, captureRequestOptions });
      return responseFactory();
    },
    async captureFromHtml(html, captureOptions, requestOptions) {
      htmlCalls.push({ html, captureOptions, requestOptions });
      return responseFactory();
    },
  };
  return { client, calls, htmlCalls };
}

function createApiError(
  status: number,
  body: {
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly errors?: readonly unknown[];
  },
): ScreenshotScoutApiError {
  return new ScreenshotScoutApiError({
    rawResponse: {
      status,
      statusText: "Error",
      headers: new Map<string, readonly string[]>(),
      contentType: "application/json",
      body: new Uint8Array(),
    },
    errorCode: body.errorCode,
    errorMessage: body.errorMessage,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
  });
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
    assert.match(tool.description ?? "", /or of HTML you provide/);
    assert.match(
      tool.description ?? "",
      /captured webpage content.+untrusted data, not instructions/i,
    );
    assert.equal(mcpbManifest.tools?.length, 2);
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
    assert.equal(
      (inputProperties.url as { description?: string } | undefined)
        ?.description,
      "HTTP or HTTPS page URL to capture. Provide either url or html.",
    );
    assert.deepEqual(inputProperties.html, {
      description:
        "A complete HTML document to render instead of a URL, such as HTML you wrote. Start with <!doctype html> and include a <title>. Inline the CSS, or use absolute https URLs for images, stylesheets and fonts. Scripts run, but localStorage, sessionStorage and cookies aren't available.",
      type: "string",
    });
    // url and html are both optional; the tool requires exactly one of them.
    // An empty list is left out of the published schema.
    assert.deepEqual(tool.inputSchema.required ?? [], []);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.outputSchema?.properties ?? {}).sort(), [
      ...structuredOutputNames,
    ]);
    assert.equal(recording.calls.length, 0);
    assert.equal(recording.htmlCalls.length, 0);
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
    // The SDK picks the method, so the tool doesn't pass one.
    assert.equal(call.captureRequestOptions?.method, undefined);
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

void test("a capture the API refuses as too long reports request_too_long", async () => {
  const recording = createRecordingClient(() => {
    throw new ScreenshotScoutApiError({
      rawResponse: {
        status: 414,
        statusText: "URI Too Long",
        headers: new Map<string, readonly string[]>(),
        contentType: null,
        body: new Uint8Array(),
      },
    });
  });
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: recording.client,
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
    assert.equal(recording.htmlCalls.length, 0);
  } finally {
    await harness.close();
  }
});

void test("an html invocation sends the HTML exactly as given, once, with the URL defaults", async () => {
  const screenshotUrl = "https://cdn.example/capture.png";
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl,
      contentType: "image/png",
      bytes: createPngHeader(1_280, 720),
    }),
  );
  const harness = await createHarness({
    client: recording.client,
    clientSupportsInlineImage: () => true,
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { html: `  ${invoiceHtml}`, format: "png" },
    });

    assert.equal(recording.calls.length, 0);
    assert.equal(recording.htmlCalls.length, 1);
    const call = recording.htmlCalls[0];
    assert.ok(call);
    assert.equal(call.html, `  ${invoiceHtml}`);
    assert.deepEqual(call.captureOptions, {
      format: "png",
      responseType: "binary",
      deviceViewportWidth: 1_280,
      deviceViewportHeight: 720,
    });
    assert.deepEqual(Object.keys(call.requestOptions ?? {}), ["signal"]);
    assert.ok(call.requestOptions?.signal instanceof AbortSignal);

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      screenshotUrl,
      format: "png",
      mimeType: "image/png",
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

void test("the tool requires exactly one of url and html before quota is consumed", async () => {
  const recording = createRecordingClient(() =>
    createBinaryResponse({
      screenshotUrl: "https://cdn.example/should-not-exist.png",
    }),
  );
  const harness = await createHarness({ client: recording.client });

  try {
    for (const item of [
      { arguments: {}, message: "Provide either url or html." },
      { arguments: { format: "pdf" }, message: "Provide either url or html." },
      {
        arguments: { url: "https://example.com", html: invoiceHtml },
        message: "Provide either url or html, not both.",
      },
      { arguments: { html: " \n\t" }, message: "Must not be blank." },
    ]) {
      const result = await harness.client.callTool({
        name: CAPTURE_SCREENSHOT_TOOL_NAME,
        arguments: item.arguments,
      });

      assert.equal(result.isError, true);
      assert.ok(
        toolResultText(result).includes(item.message),
        `${JSON.stringify(item.arguments)} did not report "${item.message}"`,
      );
    }
    assert.equal(recording.calls.length, 0);
    assert.equal(recording.htmlCalls.length, 0);
  } finally {
    await harness.close();
  }
});

void test("a client with a secret key refuses html before sending, and the tool says how to fix it", async () => {
  let fetchCalls = 0;
  const fetch: ScreenshotScoutFetch = () => {
    fetchCalls += 1;
    return Promise.reject(new Error("HTML must not be sent."));
  };
  const accessKey = "0123456789abcdef0123456789abcdef";
  const secretKey =
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: createScreenshotScoutClient({ accessKey, secretKey }, { fetch }),
    sensitiveValues: [accessKey, secretKey],
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { html: invoiceHtml },
    });

    assert.equal(result.isError, true);
    assert.equal(
      toolResultText(result),
      "Screenshot Scout capture failed.\nMessage: html can't be sent while this server has a secret key, because HTML travels in a POST request, which can't be signed.\nHow to resolve: Remove SCREENSHOTSCOUT_SECRET_KEY and use an access key that doesn't require signed requests.",
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(diagnostics, []);
  } finally {
    await harness.close();
  }
});

void test("other configuration errors keep the general message", async () => {
  const client: ScreenshotScoutCaptureClient = {
    capture: () =>
      Promise.reject(new ScreenshotScoutConfigurationError("Invalid client.")),
    captureFromHtml: () =>
      Promise.reject(new Error("The URL capture must not send HTML.")),
  };

  const result = await invokeCaptureScreenshot(
    parseCaptureScreenshotInput({ url: "https://example.com" }),
    { client },
  );
  const textContent = result.content.find((item) => item.type === "text");

  assert.equal(result.isError, true);
  assert.ok(textContent?.type === "text");
  assert.equal(
    textContent.text,
    "Screenshot Scout capture failed.\nMessage: Screenshot Scout client configuration is invalid. Check the configured access key and local signing settings.",
  );
});

void test("signature_required for html advises an access key that doesn't require signed requests", async () => {
  const recording = createRecordingClient(() =>
    Promise.reject(
      createApiError(403, {
        errorCode: "signature_required",
        errorMessage:
          "This API key requires signed requests, and HTML can only be sent in a POST request, which can't be signed. Use a separate API key without Require signed requests for HTML.",
      }),
    ),
  );
  const harness = await createHarness({ client: recording.client });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { html: invoiceHtml, format: "pdf" },
    });

    assert.equal(result.isError, true);
    assert.equal(recording.htmlCalls.length, 1);
    assert.equal(
      toolResultText(result),
      "Screenshot Scout capture failed.\nHTTP status: 403\nError code: signature_required\nMessage: This API key requires signed requests, and HTML can only be sent in a POST request, which can't be signed. Use a separate API key without Require signed requests for HTML.\nHow to resolve: This access key requires signed requests, which HTML can't use. Use an access key that doesn't require signed requests.",
    );
  } finally {
    await harness.close();
  }
});

void test("signature_required for a URL keeps the secret-key advice", async () => {
  const recording = createRecordingClient(() =>
    Promise.reject(
      createApiError(403, {
        errorCode: "signature_required",
        errorMessage: "A valid signature is required for this API key.",
      }),
    ),
  );
  const harness = await createHarness({ client: recording.client });

  try {
    const result = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { url: "https://example.com" },
    });

    assert.equal(result.isError, true);
    assert.match(
      toolResultText(result),
      /\nHow to resolve: This API key requires signed requests\. Use local stdio or MCPB with the secret key/,
    );
  } finally {
    await harness.close();
  }
});

void test("request_too_large explains how to make the request smaller", async () => {
  const recording = createRecordingClient(() =>
    Promise.reject(
      createApiError(413, {
        errorCode: "request_too_large",
        errorMessage: "The request body must be at most 5 MB.",
      }),
    ),
  );
  const harness = await createHarness({ client: recording.client });
  const prefix =
    "Screenshot Scout capture failed.\nHTTP status: 413\nError code: request_too_large\nMessage: The request body must be at most 5 MB.\nHow to resolve: ";

  try {
    const htmlResult = asCallToolResult(
      await harness.client.callTool({
        name: CAPTURE_SCREENSHOT_TOOL_NAME,
        arguments: { html: invoiceHtml },
      }),
    );
    const urlResult = asCallToolResult(
      await harness.client.callTool({
        name: CAPTURE_SCREENSHOT_TOOL_NAME,
        arguments: {
          url: "https://example.com",
          hideSelectors: [".banner"],
        },
      }),
    );

    assert.equal(htmlResult.isError, true);
    assert.equal(
      toolResultText(htmlResult),
      `${prefix}Make the HTML smaller, for example by linking large images and fonts by absolute https URL instead of embedding them.`,
    );
    assert.equal(urlResult.isError, true);
    assert.equal(toolResultText(urlResult), `${prefix}Shorten the selectors.`);
  } finally {
    await harness.close();
  }
});

void test("error text and diagnostics never contain the html", async () => {
  const html =
    "<!doctype html><html><head><title>Payroll</title></head><body><p>Salary: 98,765</p></body></html>";
  const errors = [
    createApiError(400, {
      errorCode: "invalid_options",
      errorMessage: `The document ${html} is invalid.`,
      errors: [{ option: "html", message: `Can't render ${html}` }],
    }),
    new Error(`Unexpected failure while rendering ${html}`),
  ];
  const recording = createRecordingClient(() =>
    Promise.reject(errors.shift() ?? new Error("No error is left.")),
  );
  const diagnostics: unknown[] = [];
  const harness = await createHarness({
    client: recording.client,
    onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
  });

  try {
    const apiFailure = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { html },
    });
    const unexpectedFailure = await harness.client.callTool({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      arguments: { html },
    });
    const apiText = toolResultText(apiFailure);
    const unexpectedText = toolResultText(unexpectedFailure);
    const serializedDiagnostics = JSON.stringify(diagnostics);

    assert.equal(recording.htmlCalls.length, 2);
    assert.equal(
      apiText,
      "Screenshot Scout capture failed.\nHTTP status: 400\nError code: invalid_options\nMessage: The document [REDACTED] is invalid.\nOption errors:\n- html: Can't render [REDACTED]",
    );
    assert.match(unexpectedText, /unexpected Screenshot Scout MCP error/i);
    assert.equal(diagnostics.length, 1);
    assert.match(serializedDiagnostics, /\[REDACTED\]/);
    for (const text of [apiText, unexpectedText, serializedDiagnostics]) {
      assert.equal(text.includes(html), false);
      assert.equal(text.includes("Salary"), false);
    }
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
  for (const input of [{ url: "https://example.com" }, { html: invoiceHtml }]) {
    const abortController = new AbortController();
    const diagnostics: unknown[] = [];
    const cancel = (
      requestOptions:
        | CaptureRequestOptions
        | CaptureFromHtmlRequestOptions
        | null
        | undefined,
    ): Promise<BinaryCaptureResponse> => {
      const signal =
        requestOptions?.signal === null ? undefined : requestOptions?.signal;
      assert.ok(signal);
      assert.equal(signal, abortController.signal);
      abortController.abort("The client cancelled this request.");
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- The MCP SDK forwards client cancellation reasons as strings.
      return Promise.reject(signal.reason);
    };
    const client: ScreenshotScoutCaptureClient = {
      capture: (_targetUrl, _captureOptions, requestOptions) =>
        cancel(requestOptions),
      captureFromHtml: (_html, _captureOptions, requestOptions) =>
        cancel(requestOptions),
    };

    const result = await invokeCaptureScreenshot(
      parseCaptureScreenshotInput(input),
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
  }
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
