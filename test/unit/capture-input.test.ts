import assert from "node:assert/strict";
import test from "node:test";

import { CaptureResponseType } from "@screenshotscout/sdk";
import { ZodError } from "zod";

import {
  mapCaptureInputToSdk,
  parseCaptureScreenshotInput,
} from "../../src/core/capture-input.js";

const targetUrl = "https://example.com/dashboard";

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
