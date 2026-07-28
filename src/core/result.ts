import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CAPTURE_FORMATS } from "./capture-input.js";
import {
  INLINE_IMAGE_OMISSION_REASONS,
  type InlineImageOmissionReason,
} from "./image.js";

const omissionReasonValues = Object.values(INLINE_IMAGE_OMISSION_REASONS) as [
  InlineImageOmissionReason,
  ...InlineImageOmissionReason[],
];

const httpUrlSchema = z
  .string()
  .max(8_192)
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }, "Only HTTP or HTTPS result URLs are supported.");

export const captureResultMetadataSchema = z
  .object({
    screenshotUrl: httpUrlSchema.optional(),
    screenshotUrlExpiresAt: z.string().trim().min(1).max(200).optional(),
    cacheStatus: z.string().trim().min(1).max(100).optional(),
    format: z.enum(CAPTURE_FORMATS).optional(),
    mimeType: z.string().trim().min(1).max(200).optional(),
    imageWidth: z.number().int().positive().optional(),
    imageHeight: z.number().int().positive().optional(),
    inlineImageIncluded: z.boolean().optional(),
    inlineImageOmissionReason: z.enum(omissionReasonValues).optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (
      metadata.inlineImageIncluded === true &&
      metadata.inlineImageOmissionReason !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["inlineImageOmissionReason"],
        message:
          "An inline-image omission reason cannot accompany an included image.",
      });
    }
  });

export type CaptureResultMetadata = z.infer<typeof captureResultMetadataSchema>;

export type CaptureSuccessFormattingInput = {
  readonly metadata: CaptureResultMetadata;
  readonly additionalContent?: readonly ContentBlock[];
  readonly sensitiveValues?: readonly (string | null | undefined)[];
};

export function formatCaptureSuccess(
  input: CaptureSuccessFormattingInput,
): CallToolResult {
  const metadata = captureResultMetadataSchema.parse(input.metadata);
  if (metadata.screenshotUrl !== undefined) {
    assertSafeScreenshotUrl(
      metadata.screenshotUrl,
      input.sensitiveValues ?? [],
    );
  }

  const summary = buildSuccessSummary(metadata);
  return {
    content: [
      { type: "text", text: summary },
      ...(input.additionalContent ?? []),
    ],
    structuredContent: { ...metadata },
  };
}

export function assertSafeScreenshotUrl(
  value: string,
  sensitiveValues: readonly (string | null | undefined)[] = [],
): void {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new UnsafeCaptureResultError(
      "Screenshot Scout returned an unsafe screenshot URL.",
    );
  }

  for (const key of parsed.searchParams.keys()) {
    if (isCredentialParameterName(key)) {
      throw new UnsafeCaptureResultError(
        "Screenshot Scout returned a credential-bearing screenshot URL.",
      );
    }
  }
  const fragmentParameters = new URLSearchParams(
    parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash,
  );
  for (const key of fragmentParameters.keys()) {
    if (isCredentialParameterName(key)) {
      throw new UnsafeCaptureResultError(
        "Screenshot Scout returned a credential-bearing screenshot URL.",
      );
    }
  }

  for (const sensitiveValue of sensitiveValues) {
    const encodedSensitiveValue =
      sensitiveValue === null || sensitiveValue === undefined
        ? undefined
        : safelyEncodeURIComponent(sensitiveValue);
    if (
      sensitiveValue !== null &&
      sensitiveValue !== undefined &&
      sensitiveValue.length > 0 &&
      (value.includes(sensitiveValue) ||
        (encodedSensitiveValue !== undefined &&
          value.includes(encodedSensitiveValue)))
    ) {
      throw new UnsafeCaptureResultError(
        "Screenshot Scout returned a screenshot URL containing a credential.",
      );
    }
  }
}

export class UnsafeCaptureResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCaptureResultError";
  }
}

function isCredentialParameterName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "accesskey" || normalized === "secretkey";
}

function safelyEncodeURIComponent(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function buildSuccessSummary(metadata: CaptureResultMetadata): string {
  const lines = [
    metadata.format === "pdf"
      ? "PDF capture completed."
      : "Screenshot capture completed.",
  ];

  if (metadata.screenshotUrl !== undefined) {
    lines.push(`Temporary result URL: ${metadata.screenshotUrl}`);
  }
  if (metadata.inlineImageIncluded === true) {
    lines.push("The compatible image is included inline.");
  } else if (metadata.inlineImageOmissionReason !== undefined) {
    lines.push(describeInlineImageOmission(metadata.inlineImageOmissionReason));
  }

  return lines.join("\n");
}

function describeInlineImageOmission(
  reason: InlineImageOmissionReason,
): string {
  switch (reason) {
    case INLINE_IMAGE_OMISSION_REASONS.RESULT_MODE_URL_ONLY:
      return "Inline image omitted because resultMode was url_only; use the temporary URL.";
    case INLINE_IMAGE_OMISSION_REASONS.FORMAT_NOT_INLINE_ELIGIBLE:
      return "This format is URL-only and was not embedded; use the temporary URL or resultMode: url_only.";
    case INLINE_IMAGE_OMISSION_REASONS.UNSUPPORTED_MIME_TYPE:
      return "The returned MIME type is not safe to embed; use the temporary URL or resultMode: url_only.";
    case INLINE_IMAGE_OMISSION_REASONS.MIME_TYPE_MISMATCH:
      return "The returned MIME type did not match the requested format, so it was not embedded; use the temporary URL or resultMode: url_only.";
    case INLINE_IMAGE_OMISSION_REASONS.RAW_SIZE_EXCEEDS_LIMIT:
      return "The image exceeded the raw inline-size limit, so it was not embedded; use the temporary URL.";
    case INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_UNAVAILABLE:
      return "The image dimensions could not be verified safely, so it was not embedded; use the temporary URL.";
    case INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_EXCEED_LIMIT:
      return "The image exceeded the 8,000-pixel inline dimension limit, so it was not embedded; use the temporary URL.";
    case INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE:
      return "The current client cannot safely display this image inline; use the temporary URL and resultMode: url_only for this client.";
    case INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_UNAVAILABLE:
      return "The complete tool result could not be measured safely, so the image was not embedded; use the temporary URL or resultMode: url_only.";
    case INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT:
      return "The complete tool result exceeded the inline serialized-size limit, so the image was not embedded; use the temporary URL.";
  }
}
