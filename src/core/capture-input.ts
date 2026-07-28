import {
  CaptureResponseType,
  type BinaryCaptureOptions,
} from "@screenshotscout/sdk";
import { z } from "zod";

export const CAPTURE_FORMATS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "tiff",
  "pdf",
] as const;

export const IMAGE_CAPTURE_FORMATS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "tiff",
] as const;

export const CAPTURE_RESULT_MODES = ["auto", "url_only"] as const;

const DEFAULT_VIEWPORT_WIDTH = 1_280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const DEFAULT_JPEG_QUALITY = 60;

const lossyImageFormatSet = new Set<string>(["jpg", "jpeg", "webp"]);
const pdfFieldNames = [
  "pdfPaperFormat",
  "pdfLandscape",
  "pdfPrintBackground",
  "pdfMargin",
  "pdfMarginTop",
  "pdfMarginRight",
  "pdfMarginBottom",
  "pdfMarginLeft",
  "pdfScale",
] as const;

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Must not be blank.");
const selectorListSchema = z
  .array(nonBlankStringSchema)
  .min(1, "Provide at least one non-blank selector.");
const cssLengthSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[0-9]+(?:\.[0-9]+)?)(?:\s*(?:px|in|mm|cm))?$/i,
    "Must be a non-negative CSS length in px, in, mm, or cm.",
  );
const targetUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname.length > 0
      );
    } catch {
      return false;
    }
  }, "Must be a valid HTTP or HTTPS URL.");

/**
 * The complete curated MCP input surface. Credentials and SDK-owned
 * `responseType` controls are deliberately absent.
 */
export const captureScreenshotInputSchema = z
  .object({
    url: targetUrlSchema.describe("HTTP or HTTPS page URL to capture."),
    format: z
      .enum(CAPTURE_FORMATS)
      .default("jpeg")
      .describe("Output image or document format. Defaults to JPEG."),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Use a two-letter ISO 3166-1 country code.")
      .optional()
      .describe("Two-letter country code for the capture location."),
    device: nonBlankStringSchema
      .optional()
      .describe("Screenshot Scout device preset name."),
    deviceViewportWidth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Viewport width override in CSS pixels. Captures use a 1280×720 viewport when no device or viewport dimension is supplied.",
      ),
    deviceViewportHeight: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Viewport height override in CSS pixels. Captures use a 1280×720 viewport when no device or viewport dimension is supplied.",
      ),
    colorScheme: z
      .enum(["auto", "dark", "light"])
      .optional()
      .describe("Preferred page color scheme."),
    fullPage: z
      .boolean()
      .optional()
      .describe("Capture the full scrollable page when true."),
    blockCookieBanners: z
      .boolean()
      .optional()
      .describe("Attempt to block common cookie banners."),
    blockAds: z
      .boolean()
      .optional()
      .describe("Attempt to block advertisements."),
    blockChatWidgets: z
      .boolean()
      .optional()
      .describe("Attempt to block common chat widgets."),
    selector: nonBlankStringSchema
      .optional()
      .describe("CSS selector for an element-only capture."),
    hideSelectors: selectorListSchema
      .optional()
      .describe("CSS selectors for elements to hide before capture."),
    clickSelectors: selectorListSchema
      .optional()
      .describe("CSS selectors for elements to click before capture."),
    waitUntil: z
      .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
      .optional()
      .describe("Page lifecycle event to await before capture."),
    delay: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe("Additional delay before capture, in seconds."),
    navigationTimeout: z
      .number()
      .int()
      .min(5)
      .max(90)
      .optional()
      .describe("Page navigation timeout, in seconds."),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(240)
      .optional()
      .describe("Overall capture timeout, in seconds."),
    cache: z
      .boolean()
      .optional()
      .describe("Allow Screenshot Scout result caching."),
    cacheTtl: z
      .number()
      .int()
      .min(14_400)
      .max(2_592_000)
      .optional()
      .describe("Cache lifetime in seconds."),
    resultMode: z
      .enum(CAPTURE_RESULT_MODES)
      .default("auto")
      .describe(
        "Use auto for eligible inline images or url_only to omit inline bytes.",
      ),
    imageWidth: z
      .number()
      .int()
      .min(1)
      .max(8_192)
      .optional()
      .describe(
        "Resize the captured content to this width in pixels before creating the image or PDF.",
      ),
    imageHeight: z
      .number()
      .int()
      .min(1)
      .max(8_192)
      .optional()
      .describe(
        "Resize the captured content to this height in pixels before creating the image or PDF.",
      ),
    imageQuality: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "JPEG or WebP output quality from 0 to 100. JPEG uses quality 60 when omitted.",
      ),
    pdfPaperFormat: z
      .enum(["letter", "legal", "tabloid", "a4", "a3", "content"])
      .optional()
      .describe("PDF paper size; requires format pdf."),
    pdfLandscape: z
      .boolean()
      .optional()
      .describe("Use landscape PDF orientation."),
    pdfPrintBackground: z
      .boolean()
      .optional()
      .describe("Include CSS backgrounds in PDF output."),
    pdfMargin: cssLengthSchema
      .optional()
      .describe("PDF margin applied to all sides."),
    pdfMarginTop: cssLengthSchema.optional().describe("PDF top margin."),
    pdfMarginRight: cssLengthSchema.optional().describe("PDF right margin."),
    pdfMarginBottom: cssLengthSchema.optional().describe("PDF bottom margin."),
    pdfMarginLeft: cssLengthSchema.optional().describe("PDF left margin."),
    pdfScale: z
      .number()
      .positive()
      .max(3)
      .optional()
      .describe("PDF rendering scale greater than 0 and at most 3."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.format !== "pdf") {
      for (const field of pdfFieldNames) {
        if (input[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} requires format "pdf".`,
          });
        }
      }
    }

    if (
      input.imageQuality !== undefined &&
      !lossyImageFormatSet.has(input.format)
    ) {
      context.addIssue({
        code: "custom",
        path: ["imageQuality"],
        message: 'imageQuality requires format "jpg", "jpeg", or "webp".',
      });
    }

    if (
      input.imageWidth !== undefined &&
      input.imageHeight !== undefined &&
      input.imageWidth * input.imageHeight > 64_000_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["imageHeight"],
        message:
          "imageWidth multiplied by imageHeight must not exceed 64,000,000 pixels.",
      });
    }
  });

export type CaptureScreenshotInput = z.infer<
  typeof captureScreenshotInputSchema
>;
export type CaptureResultMode = CaptureScreenshotInput["resultMode"];

export type MappedCaptureRequest = {
  readonly targetUrl: string;
  readonly resultMode: CaptureResultMode;
  readonly captureOptions: Readonly<BinaryCaptureOptions>;
};

export function parseCaptureScreenshotInput(
  input: unknown,
): CaptureScreenshotInput {
  return captureScreenshotInputSchema.parse(input);
}

/**
 * Applies MCP-owned image defaults, then maps the curated fields to the
 * identically named SDK fields. The SDK remains solely responsible for request
 * serialization.
 */
export function mapCaptureInputToSdk(
  input: CaptureScreenshotInput,
): MappedCaptureRequest {
  const hideSelectors =
    input.hideSelectors === undefined
      ? undefined
      : Object.freeze([...input.hideSelectors]);
  const clickSelectors =
    input.clickSelectors === undefined
      ? undefined
      : Object.freeze([...input.clickSelectors]);
  const useDefaultViewport =
    input.device === undefined &&
    input.deviceViewportWidth === undefined &&
    input.deviceViewportHeight === undefined;
  const useDefaultJpegQuality =
    (input.format === "jpg" || input.format === "jpeg") &&
    input.imageQuality === undefined;
  const deviceViewportWidth = useDefaultViewport
    ? DEFAULT_VIEWPORT_WIDTH
    : input.deviceViewportWidth;
  const deviceViewportHeight = useDefaultViewport
    ? DEFAULT_VIEWPORT_HEIGHT
    : input.deviceViewportHeight;
  const imageQuality = useDefaultJpegQuality
    ? DEFAULT_JPEG_QUALITY
    : input.imageQuality;

  const captureOptions: BinaryCaptureOptions = {
    format: input.format,
    responseType: CaptureResponseType.BINARY,
    ...(input.country === undefined ? {} : { country: input.country }),
    ...(input.device === undefined ? {} : { device: input.device }),
    ...(deviceViewportWidth === undefined ? {} : { deviceViewportWidth }),
    ...(deviceViewportHeight === undefined ? {} : { deviceViewportHeight }),
    ...(input.colorScheme === undefined
      ? {}
      : { colorScheme: input.colorScheme }),
    ...(input.fullPage === undefined ? {} : { fullPage: input.fullPage }),
    ...(input.blockCookieBanners === undefined
      ? {}
      : { blockCookieBanners: input.blockCookieBanners }),
    ...(input.blockAds === undefined ? {} : { blockAds: input.blockAds }),
    ...(input.blockChatWidgets === undefined
      ? {}
      : { blockChatWidgets: input.blockChatWidgets }),
    ...(input.selector === undefined ? {} : { selector: input.selector }),
    ...(hideSelectors === undefined ? {} : { hideSelectors }),
    ...(clickSelectors === undefined ? {} : { clickSelectors }),
    ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    ...(input.delay === undefined ? {} : { delay: input.delay }),
    ...(input.navigationTimeout === undefined
      ? {}
      : { navigationTimeout: input.navigationTimeout }),
    ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    ...(input.cache === undefined ? {} : { cache: input.cache }),
    ...(input.cacheTtl === undefined ? {} : { cacheTtl: input.cacheTtl }),
    ...(input.imageWidth === undefined ? {} : { imageWidth: input.imageWidth }),
    ...(input.imageHeight === undefined
      ? {}
      : { imageHeight: input.imageHeight }),
    ...(imageQuality === undefined ? {} : { imageQuality }),
    ...(input.pdfPaperFormat === undefined
      ? {}
      : { pdfPaperFormat: input.pdfPaperFormat }),
    ...(input.pdfLandscape === undefined
      ? {}
      : { pdfLandscape: input.pdfLandscape }),
    ...(input.pdfPrintBackground === undefined
      ? {}
      : { pdfPrintBackground: input.pdfPrintBackground }),
    ...(input.pdfMargin === undefined ? {} : { pdfMargin: input.pdfMargin }),
    ...(input.pdfMarginTop === undefined
      ? {}
      : { pdfMarginTop: input.pdfMarginTop }),
    ...(input.pdfMarginRight === undefined
      ? {}
      : { pdfMarginRight: input.pdfMarginRight }),
    ...(input.pdfMarginBottom === undefined
      ? {}
      : { pdfMarginBottom: input.pdfMarginBottom }),
    ...(input.pdfMarginLeft === undefined
      ? {}
      : { pdfMarginLeft: input.pdfMarginLeft }),
    ...(input.pdfScale === undefined ? {} : { pdfScale: input.pdfScale }),
  };

  return Object.freeze({
    targetUrl: input.url,
    resultMode: input.resultMode,
    captureOptions: Object.freeze(captureOptions),
  });
}
