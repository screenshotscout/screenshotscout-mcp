import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CaptureHttpMethod,
  type BinaryCaptureOptions,
} from "@screenshotscout/sdk";

import {
  captureScreenshotInputSchema,
  mapCaptureInputToSdk,
  type CaptureScreenshotInput,
} from "./capture-input.js";
import type { ScreenshotScoutCaptureClient } from "./client.js";
import {
  formatScreenshotScoutError,
  SignedRequestTooLongError,
} from "./errors.js";
import {
  evaluateInlineImage,
  normalizeMimeType,
  resolveImageDimensions,
  type ImageDimensions,
  type InlineImageMimeType,
} from "./image.js";
import type { RedactedDiagnostic } from "./redaction.js";
import {
  captureResultMetadataSchema,
  formatCaptureSuccess,
  type CaptureResultMetadata,
} from "./result.js";
import {
  CAPTURE_SCREENSHOT_TOOL_ANNOTATIONS,
  CAPTURE_SCREENSHOT_TOOL_DESCRIPTION,
  CAPTURE_SCREENSHOT_TOOL_NAME,
  CAPTURE_SCREENSHOT_TOOL_TITLE,
} from "./tool-metadata.js";

export type CaptureScreenshotToolDependencies = {
  readonly client: ScreenshotScoutCaptureClient;
  readonly clientSupportsInlineImage?: (
    mimeType: InlineImageMimeType,
  ) => boolean;
  readonly maxSerializedResultBytes?: number;
  readonly sensitiveValues?: readonly (string | null | undefined)[];
  readonly onUnexpectedError?: (diagnostic: RedactedDiagnostic) => void;
  /**
   * Set when the client has a secret key. Only GET requests can be signed, so
   * captures are then sent as signed GET requests.
   */
  readonly signedRequests?: {
    buildCaptureUrl(
      targetUrl: string,
      captureOptions?: BinaryCaptureOptions | null,
    ): string;
  };
};

// Cloudflare refuses URLs over 16 KB. The built capture URL also carries the
// access key, which a GET capture sends in a header, so it's an upper bound.
const MAX_SIGNED_CAPTURE_URL_LENGTH = 16_000;

export type CaptureScreenshotInvocationContext = {
  readonly signal?: AbortSignal;
};

/**
 * Invokes the official Screenshot Scout SDK after MCP schema validation.
 * Result-content branching remains in the shared result layer.
 */
export async function invokeCaptureScreenshot(
  input: CaptureScreenshotInput,
  dependencies: CaptureScreenshotToolDependencies,
  context: CaptureScreenshotInvocationContext = {},
): Promise<CallToolResult> {
  const configuredSensitiveValues = dependencies.sensitiveValues ?? [];

  try {
    const mappedRequest = mapCaptureInputToSdk(input);
    const signedRequests = dependencies.signedRequests;
    if (
      signedRequests !== undefined &&
      signedRequests.buildCaptureUrl(
        mappedRequest.targetUrl,
        mappedRequest.captureOptions,
      ).length > MAX_SIGNED_CAPTURE_URL_LENGTH
    ) {
      throw new SignedRequestTooLongError();
    }
    const response = await dependencies.client.capture(
      mappedRequest.targetUrl,
      mappedRequest.captureOptions,
      {
        method:
          signedRequests === undefined
            ? CaptureHttpMethod.POST
            : CaptureHttpMethod.GET,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
    );
    const mimeType = normalizeMimeType(response.rawResponse.contentType);
    const baseMetadata: CaptureResultMetadata = {
      ...(response.screenshotUrl === undefined
        ? {}
        : { screenshotUrl: response.screenshotUrl }),
      ...(response.screenshotUrlExpiresAt === undefined
        ? {}
        : { screenshotUrlExpiresAt: response.screenshotUrlExpiresAt }),
      ...(response.cacheStatus === undefined
        ? {}
        : { cacheStatus: response.cacheStatus }),
      format: input.format,
      ...(mimeType === undefined ? {} : { mimeType }),
      inlineImageIncluded: false,
    };

    if (input.format === "pdf") {
      const resourceLink = createPdfResourceLink(
        response.screenshotUrl,
        mimeType,
        response.bytes.byteLength,
      );
      return formatCaptureSuccess({
        metadata: baseMetadata,
        ...(resourceLink === undefined
          ? {}
          : { additionalContent: [resourceLink] }),
        sensitiveValues: configuredSensitiveValues,
      });
    }

    const dimensions = resolveImageDimensions(
      response.bytes,
      mimeType,
      undefined,
    );
    const evaluation = evaluateInlineImage({
      format: input.format,
      resultMode: mappedRequest.resultMode,
      mimeType,
      bytes: response.bytes,
      ...(dimensions === undefined
        ? {}
        : {
            trustedDimensions: {
              imageWidth: dimensions.width,
              imageHeight: dimensions.height,
            },
          }),
      ...(dependencies.maxSerializedResultBytes === undefined
        ? {}
        : {
            serializedSizeLimitBytes: dependencies.maxSerializedResultBytes,
          }),
      clientSupportsInlineImage:
        dependencies.clientSupportsInlineImage ?? (() => false),
      buildSerializedResult: (image, measuredDimensions) =>
        formatCaptureSuccess({
          metadata: buildImageMetadata(baseMetadata, measuredDimensions, true),
          additionalContent: [image],
          sensitiveValues: configuredSensitiveValues,
        }),
    });

    if (evaluation.included) {
      return formatCaptureSuccess({
        metadata: buildImageMetadata(baseMetadata, evaluation.dimensions, true),
        additionalContent: [evaluation.image],
        sensitiveValues: configuredSensitiveValues,
      });
    }

    return formatCaptureSuccess({
      metadata: {
        ...buildImageMetadata(baseMetadata, dimensions, false),
        inlineImageOmissionReason: evaluation.reason,
      },
      sensitiveValues: configuredSensitiveValues,
    });
  } catch (error) {
    // MCP cancellation reasons may be strings, but error mapping expects the
    // standard AbortError shape and must not report cancellations as faults.
    const captureError =
      context.signal?.aborted === true
        ? new DOMException(
            "The screenshot capture was cancelled.",
            "AbortError",
          )
        : error;
    return formatScreenshotScoutError(captureError, {
      sensitiveValues: [input.url, ...configuredSensitiveValues],
      ...(dependencies.onUnexpectedError === undefined
        ? {}
        : { onUnexpectedError: dependencies.onUnexpectedError }),
    });
  }
}

/**
 * Registers the one approved tool on a transport-neutral MCP server.
 */
export function registerCaptureScreenshotTool(
  server: McpServer,
  dependencies: CaptureScreenshotToolDependencies,
): RegisteredTool {
  return server.registerTool(
    CAPTURE_SCREENSHOT_TOOL_NAME,
    {
      title: CAPTURE_SCREENSHOT_TOOL_TITLE,
      description: CAPTURE_SCREENSHOT_TOOL_DESCRIPTION,
      inputSchema: captureScreenshotInputSchema,
      outputSchema: captureResultMetadataSchema,
      annotations: CAPTURE_SCREENSHOT_TOOL_ANNOTATIONS,
    },
    (input, extra) =>
      invokeCaptureScreenshot(input, dependencies, { signal: extra.signal }),
  );
}

function buildImageMetadata(
  baseMetadata: CaptureResultMetadata,
  dimensions: ImageDimensions | undefined,
  inlineImageIncluded: boolean,
): CaptureResultMetadata {
  return {
    ...baseMetadata,
    ...(dimensions === undefined
      ? {}
      : {
          imageWidth: dimensions.width,
          imageHeight: dimensions.height,
        }),
    inlineImageIncluded,
  };
}

function createPdfResourceLink(
  screenshotUrl: string | undefined,
  mimeType: string | undefined,
  rawBytes: number,
): ResourceLink | undefined {
  if (screenshotUrl === undefined) return undefined;

  return {
    type: "resource_link",
    uri: screenshotUrl,
    name: "screenshot-scout-capture.pdf",
    title: "Screenshot Scout PDF capture",
    description: "Temporary PDF capture generated by Screenshot Scout.",
    mimeType: mimeType ?? "application/pdf",
    size: rawBytes,
  };
}
