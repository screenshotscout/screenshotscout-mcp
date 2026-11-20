import assert from "node:assert/strict";
import test from "node:test";

import { CaptureResponseType } from "@screenshotscout/sdk";
import { ZodError } from "zod";

import {
  mapCaptureInputToSdk,
  parseCaptureScreenshotInput,
  type CaptureScreenshotInput,
} from "../../src/core/capture-input.js";

const targetUrl = "https://example.com/dashboard";
const html =
  "\n  <!doctype html><html><head><title>Invoice #1042</title></head><body><h1>Invoice #1042</h1></body></html>  \n";

void test("the curated schema applies MCP defaults", () => {
  const parsed = parseCaptureScreenshotInput({ url: `  ${targetUrl}  ` });
  const mapped = mapCaptureInputToSdk(parsed);

  assert.equal(parsed.url, targetUrl);
  assert.equal(parsed.format, "jpeg");
  assert.equal(parsed.resultMode, "auto");
  assert.deepEqual(mapped.captureOptions, {
    format: "jpeg",
    responseType: CaptureResponseType.BINARY,
    deviceViewportWidth: 1_280,
    deviceViewportHeight: 720,
    imageQuality: 60,
  });
});

void test("device, viewport, and output-size requests are not implicitly resized", () => {
  const deviceCapture = mapCaptureInputToSdk(
    parseCaptureScreenshotInput({
      url: targetUrl,
      device: "iPhone 13",
    }),
  );
  const viewportCapture = mapCaptureInputToSdk(
    parseCaptureScreenshotInput({
      url: targetUrl,
      deviceViewportWidth: 390,
      deviceViewportHeight: 844,
    }),
  );
  const resizedCapture = mapCaptureInputToSdk(
    parseCaptureScreenshotInput({
      url: targetUrl,
      imageWidth: 800,
    }),
  );

  assert.deepEqual(deviceCapture.captureOptions, {
    format: "jpeg",
    responseType: CaptureResponseType.BINARY,
    device: "iPhone 13",
    imageQuality: 60,
  });
  assert.deepEqual(viewportCapture.captureOptions, {
    format: "jpeg",
    responseType: CaptureResponseType.BINARY,
    deviceViewportWidth: 390,
    deviceViewportHeight: 844,
    imageQuality: 60,
  });
  assert.deepEqual(resizedCapture.captureOptions, {
    format: "jpeg",
    responseType: CaptureResponseType.BINARY,
    deviceViewportWidth: 1_280,
    deviceViewportHeight: 720,
    imageWidth: 800,
    imageQuality: 60,
  });
});

void test("all approved common and image inputs map once to SDK-aligned options", () => {
  const parsed = parseCaptureScreenshotInput({
    url: targetUrl,
    format: "webp",
    country: "US",
    device: "Desktop Chrome",
    deviceViewportWidth: 1_440,
    deviceViewportHeight: 900,
    colorScheme: "dark",
    fullPage: false,
    blockCookieBanners: true,
    blockAds: false,
    blockChatWidgets: true,
    selector: "#dashboard",
    hideSelectors: [".cookie-banner", ".advert"],
    clickSelectors: ["#open", ".accept"],
    waitUntil: "networkidle2",
    delay: 0,
    navigationTimeout: 60,
    timeout: 180,
    cache: true,
    cacheTtl: 86_400,
    resultMode: "url_only",
    imageWidth: 1_200,
    imageHeight: 800,
    imageQuality: 0,
  });

  const mapped = mapCaptureInputToSdk(parsed);

  assert.equal(mapped.targetUrl, targetUrl);
  assert.equal(mapped.resultMode, "url_only");
  assert.deepEqual(mapped.captureOptions, {
    format: "webp",
    responseType: CaptureResponseType.BINARY,
    country: "US",
    device: "Desktop Chrome",
    deviceViewportWidth: 1_440,
    deviceViewportHeight: 900,
    colorScheme: "dark",
    fullPage: false,
    blockCookieBanners: true,
    blockAds: false,
    blockChatWidgets: true,
    selector: "#dashboard",
    hideSelectors: [".cookie-banner", ".advert"],
    clickSelectors: ["#open", ".accept"],
    waitUntil: "networkidle2",
    delay: 0,
    navigationTimeout: 60,
    timeout: 180,
    cache: true,
    cacheTtl: 86_400,
    imageWidth: 1_200,
    imageHeight: 800,
    imageQuality: 0,
  });
  assert.equal(Object.hasOwn(mapped.captureOptions, "resultMode"), false);
});

void test("all approved PDF inputs map to SDK-aligned options", () => {
  const parsed = parseCaptureScreenshotInput({
    url: targetUrl,
    format: "pdf",
    resultMode: "auto",
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
    pdfScale: 1.5,
    pdfPageRanges: "1-3,5",
  });

  const mapped = mapCaptureInputToSdk(parsed);

  assert.deepEqual(mapped.captureOptions, {
    format: "pdf",
    responseType: CaptureResponseType.BINARY,
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
    pdfScale: 1.5,
    pdfPageRanges: "1-3,5",
  });
});

void test("format-specific inputs pass through for other formats", () => {
  const passThroughInputs = [
    {
      input: { url: targetUrl, format: "pdf", imageQuality: 80 },
      field: "imageQuality",
      value: 80,
    },
    {
      input: { url: targetUrl, format: "png", pdfLandscape: true },
      field: "pdfLandscape",
      value: true,
    },
    {
      input: { url: targetUrl, format: "gif", imageQuality: 80 },
      field: "imageQuality",
      value: 80,
    },
  ] as const;

  for (const passThrough of passThroughInputs) {
    const mapped = mapCaptureInputToSdk(
      parseCaptureScreenshotInput(passThrough.input),
    );

    assert.equal(mapped.captureOptions[passThrough.field], passThrough.value);
  }
});

void test("a URL maps to the target URL and no HTML", () => {
  const mapped = mapCaptureInputToSdk(
    parseCaptureScreenshotInput({ url: targetUrl }),
  );

  assert.equal(mapped.targetUrl, targetUrl);
  assert.equal(Object.hasOwn(mapped, "html"), false);
});

void test("html is kept exactly as sent and maps with the same defaults as a URL", () => {
  const parsed = parseCaptureScreenshotInput({ html });
  const mapped = mapCaptureInputToSdk(parsed);

  assert.equal(parsed.html, html);
  assert.equal(parsed.url, undefined);
  assert.equal(mapped.html, html);
  assert.equal(Object.hasOwn(mapped, "targetUrl"), false);
  assert.equal(mapped.resultMode, "auto");
  assert.deepEqual(mapped.captureOptions, {
    format: "jpeg",
    responseType: CaptureResponseType.BINARY,
    deviceViewportWidth: 1_280,
    deviceViewportHeight: 720,
    imageQuality: 60,
  });
});

void test("html takes the same options as a URL", () => {
  const mapped = mapCaptureInputToSdk(
    parseCaptureScreenshotInput({
      html,
      format: "pdf",
      resultMode: "url_only",
      waitUntil: "networkidle0",
      delay: 2,
      pdfPaperFormat: "a4",
      pdfPrintBackground: true,
    }),
  );

  assert.equal(mapped.html, html);
  assert.equal(mapped.resultMode, "url_only");
  assert.deepEqual(mapped.captureOptions, {
    format: "pdf",
    responseType: CaptureResponseType.BINARY,
    deviceViewportWidth: 1_280,
    deviceViewportHeight: 720,
    waitUntil: "networkidle0",
    delay: 2,
    pdfPaperFormat: "a4",
    pdfPrintBackground: true,
  });
});

void test("the schema requires exactly one of url and html", () => {
  const cases = [
    {
      input: {},
      path: "url",
      message: "Provide either url or html.",
    },
    {
      input: { format: "png" },
      path: "url",
      message: "Provide either url or html.",
    },
    {
      input: { url: targetUrl, html },
      path: "html",
      message: "Provide either url or html, not both.",
    },
  ] as const;

  for (const item of cases) {
    assert.throws(
      () => parseCaptureScreenshotInput(item.input),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.deepEqual(
          error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
          [{ path: [item.path], message: item.message }],
        );
        return true;
      },
    );
  }
});

void test("the schema rejects blank and non-string html", () => {
  for (const value of ["", "   ", "\n\t ", 42, ["<p>Hi</p>"], { html }, null]) {
    assert.throws(
      () => parseCaptureScreenshotInput({ html: value }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.ok(error.issues.some((issue) => issue.path[0] === "html"));
        return true;
      },
    );
  }
});

void test("mapping refuses unparsed input that has both url and html, or neither", () => {
  const cases: readonly {
    readonly input: CaptureScreenshotInput;
    readonly message: string;
  }[] = [
    {
      input: { format: "jpeg", resultMode: "auto", url: targetUrl, html },
      message: "Provide either url or html, not both.",
    },
    {
      input: { format: "jpeg", resultMode: "auto" },
      message: "Provide either url or html.",
    },
  ];

  for (const item of cases) {
    assert.throws(() => mapCaptureInputToSdk(item.input), {
      name: "TypeError",
      message: item.message,
    });
  }
});

void test("the schema rejects excluded credentials, request controls, and options", () => {
  for (const excludedField of [
    "accessKey",
    "secretKey",
    "responseType",
    "headers",
    "cookies",
    "proxy",
    "injectJs",
  ]) {
    assert.throws(
      () =>
        parseCaptureScreenshotInput({
          url: targetUrl,
          [excludedField]: "not-allowed",
        }),
      ZodError,
    );
  }
});
