import { Buffer } from "node:buffer";

import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";

import type {
  CaptureResultMode,
  CaptureScreenshotInput,
} from "./capture-input.js";

export const MAX_INLINE_IMAGE_DIMENSION = 8_000;
export const MAX_INLINE_IMAGE_RAW_BYTES = 5 * 1_024 * 1_024;
export const DEFAULT_MAX_SERIALIZED_RESULT_BYTES = 128_000;
export const DEFAULT_MAX_IMAGE_HEADER_BYTES = 64 * 1_024;

export const INLINE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];
export type CaptureFormat = CaptureScreenshotInput["format"];

export const INLINE_IMAGE_OMISSION_REASONS = {
  RESULT_MODE_URL_ONLY: "result_mode_url_only",
  FORMAT_NOT_INLINE_ELIGIBLE: "format_not_inline_eligible",
  UNSUPPORTED_MIME_TYPE: "unsupported_mime_type",
  MIME_TYPE_MISMATCH: "mime_type_mismatch",
  RAW_SIZE_EXCEEDS_LIMIT: "raw_size_exceeds_limit",
  DIMENSIONS_UNAVAILABLE: "dimensions_unavailable",
  DIMENSIONS_EXCEED_LIMIT: "dimensions_exceed_limit",
  CLIENT_NOT_COMPATIBLE: "client_not_compatible",
  SERIALIZED_SIZE_UNAVAILABLE: "serialized_size_unavailable",
  SERIALIZED_SIZE_EXCEEDS_LIMIT: "serialized_size_exceeds_limit",
} as const;

export type InlineImageOmissionReason =
  (typeof INLINE_IMAGE_OMISSION_REASONS)[keyof typeof INLINE_IMAGE_OMISSION_REASONS];

export type ImageDimensions = {
  readonly width: number;
  readonly height: number;
};

export type TrustedImageDimensions = {
  readonly imageWidth?: number;
  readonly imageHeight?: number;
};

export type InlineImageIncluded = {
  readonly included: true;
  readonly image: ImageContent;
  readonly dimensions: ImageDimensions;
  readonly rawBytes: number;
  readonly serializedBytes: number;
  readonly serializedSizeLimitBytes: number;
};

export type InlineImageOmitted = {
  readonly included: false;
  readonly reason: InlineImageOmissionReason;
  readonly dimensions?: ImageDimensions;
  readonly rawBytes: number;
  readonly serializedSizeLimitBytes: number;
};

export type InlineImageEvaluation = InlineImageIncluded | InlineImageOmitted;

export type InlineImageCandidate = {
  readonly format: CaptureFormat;
  readonly resultMode: CaptureResultMode;
  readonly mimeType: string | null | undefined;
  readonly bytes: Uint8Array;
  readonly trustedDimensions?: TrustedImageDimensions;
  readonly serializedSizeLimitBytes?: number;
  readonly clientSupportsInlineImage: (
    mimeType: InlineImageMimeType,
  ) => boolean;
  readonly buildSerializedResult: (
    image: ImageContent,
    dimensions: ImageDimensions,
  ) => unknown;
  readonly stringify?: (value: unknown) => string | undefined;
};

const inlineMimeTypeSet = new Set<string>(INLINE_IMAGE_MIME_TYPES);
const inlineFormatMimeTypes: Readonly<
  Partial<Record<CaptureFormat, InlineImageMimeType>>
> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
});

export function normalizeMimeType(
  value: string | null | undefined,
): string | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0
    ? undefined
    : mediaType;
}

export function asInlineImageMimeType(
  value: string | null | undefined,
): InlineImageMimeType | undefined {
  const normalized = normalizeMimeType(value);
  return normalized !== undefined && inlineMimeTypeSet.has(normalized)
    ? (normalized as InlineImageMimeType)
    : undefined;
}

export function resolveImageDimensions(
  bytes: Uint8Array,
  mimeType: string | null | undefined,
  trustedDimensions: TrustedImageDimensions | undefined,
  maxHeaderBytes = DEFAULT_MAX_IMAGE_HEADER_BYTES,
): ImageDimensions | undefined {
  const trusted = normalizeDimensions(
    trustedDimensions?.imageWidth,
    trustedDimensions?.imageHeight,
  );
  return trusted ?? inspectImageDimensions(bytes, mimeType, maxHeaderBytes);
}

/**
 * Reads only bounded format headers. It does not decode pixels or transform
 * the payload.
 */
export function inspectImageDimensions(
  bytes: Uint8Array,
  mimeType: string | null | undefined,
  maxHeaderBytes = DEFAULT_MAX_IMAGE_HEADER_BYTES,
): ImageDimensions | undefined {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const inspectionLength = boundedInspectionLength(
    bytes.byteLength,
    maxHeaderBytes,
  );

  switch (normalizedMimeType) {
    case "image/png":
      return inspectPng(bytes, inspectionLength);
    case "image/jpeg":
      return inspectJpeg(bytes, inspectionLength);
    case "image/gif":
      return inspectGif(bytes, inspectionLength);
    case "image/webp":
      return inspectWebp(bytes, inspectionLength);
    default:
      return undefined;
  }
}

export function evaluateInlineImage(
  candidate: InlineImageCandidate,
): InlineImageEvaluation {
  const serializedSizeLimitBytes = resolveSerializedSizeLimit(
    candidate.serializedSizeLimitBytes,
  );
  const baseOmission = {
    rawBytes: candidate.bytes.byteLength,
    serializedSizeLimitBytes,
  } as const;

  if (candidate.resultMode === "url_only") {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.RESULT_MODE_URL_ONLY,
      ...baseOmission,
    };
  }

  const expectedMimeType = inlineFormatMimeTypes[candidate.format];
  if (expectedMimeType === undefined) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.FORMAT_NOT_INLINE_ELIGIBLE,
      ...baseOmission,
    };
  }

  const mimeType = asInlineImageMimeType(candidate.mimeType);
  if (mimeType === undefined) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.UNSUPPORTED_MIME_TYPE,
      ...baseOmission,
    };
  }
  if (mimeType !== expectedMimeType) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.MIME_TYPE_MISMATCH,
      ...baseOmission,
    };
  }

  if (candidate.bytes.byteLength > MAX_INLINE_IMAGE_RAW_BYTES) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.RAW_SIZE_EXCEEDS_LIMIT,
      ...baseOmission,
    };
  }

  const dimensions = resolveImageDimensions(
    candidate.bytes,
    mimeType,
    candidate.trustedDimensions,
  );
  if (dimensions === undefined) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_UNAVAILABLE,
      ...baseOmission,
    };
  }
  if (
    dimensions.width > MAX_INLINE_IMAGE_DIMENSION ||
    dimensions.height > MAX_INLINE_IMAGE_DIMENSION
  ) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_EXCEED_LIMIT,
      dimensions,
      ...baseOmission,
    };
  }

  const clientSupportsInlineImage = safelyCheckClientImageSupport(
    candidate.clientSupportsInlineImage,
    mimeType,
  );
  if (!clientSupportsInlineImage) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE,
      dimensions,
      ...baseOmission,
    };
  }

  const minimumBase64Bytes = 4 * Math.ceil(candidate.bytes.byteLength / 3);
  if (minimumBase64Bytes > serializedSizeLimitBytes) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
      dimensions,
      ...baseOmission,
    };
  }

  const image: ImageContent = {
    type: "image",
    data: Buffer.from(
      candidate.bytes.buffer,
      candidate.bytes.byteOffset,
      candidate.bytes.byteLength,
    ).toString("base64"),
    mimeType,
  };

  let serialized: string | undefined;
  try {
    serialized = (candidate.stringify ?? JSON.stringify)(
      candidate.buildSerializedResult(image, dimensions),
    );
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_UNAVAILABLE,
      dimensions,
      ...baseOmission,
    };
  }

  const serializedBytes = new TextEncoder().encode(serialized).byteLength;
  if (serializedBytes > serializedSizeLimitBytes) {
    return {
      included: false,
      reason: INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
      dimensions,
      ...baseOmission,
    };
  }

  return {
    included: true,
    image,
    dimensions,
    rawBytes: candidate.bytes.byteLength,
    serializedBytes,
    serializedSizeLimitBytes,
  };
}

export function resolveSerializedSizeLimit(
  requestedLimitBytes: number | undefined,
): number {
  if (requestedLimitBytes === undefined) {
    return DEFAULT_MAX_SERIALIZED_RESULT_BYTES;
  }
  if (!Number.isSafeInteger(requestedLimitBytes) || requestedLimitBytes <= 0) {
    return 0;
  }
  return Math.min(requestedLimitBytes, DEFAULT_MAX_SERIALIZED_RESULT_BYTES);
}

function normalizeDimensions(
  width: number | undefined,
  height: number | undefined,
): ImageDimensions | undefined {
  return isPositiveSafeInteger(width) && isPositiveSafeInteger(height)
    ? { width, height }
    : undefined;
}

function safelyCheckClientImageSupport(
  supportsInlineImage: (mimeType: InlineImageMimeType) => boolean,
  mimeType: InlineImageMimeType,
): boolean {
  try {
    return supportsInlineImage(mimeType);
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function boundedInspectionLength(
  byteLength: number,
  maxHeaderBytes: number,
): number {
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes <= 0) return 0;
  return Math.min(byteLength, maxHeaderBytes, DEFAULT_MAX_IMAGE_HEADER_BYTES);
}

function inspectPng(
  bytes: Uint8Array,
  inspectionLength: number,
): ImageDimensions | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (
    inspectionLength < 24 ||
    !matchesBytes(bytes, 0, signature) ||
    readUint32BigEndian(bytes, 8) !== 13 ||
    !matchesAscii(bytes, 12, "IHDR")
  ) {
    return undefined;
  }

  return normalizeDimensions(
    readUint32BigEndian(bytes, 16),
    readUint32BigEndian(bytes, 20),
  );
}

function inspectGif(
  bytes: Uint8Array,
  inspectionLength: number,
): ImageDimensions | undefined {
  if (
    inspectionLength < 10 ||
    (!matchesAscii(bytes, 0, "GIF87a") && !matchesAscii(bytes, 0, "GIF89a"))
  ) {
    return undefined;
  }
  return normalizeDimensions(
    readUint16LittleEndian(bytes, 6),
    readUint16LittleEndian(bytes, 8),
  );
}

function inspectJpeg(
  bytes: Uint8Array,
  inspectionLength: number,
): ImageDimensions | undefined {
  if (inspectionLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 1 < inspectionLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < inspectionLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= inspectionLength) return undefined;

    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) return undefined;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > inspectionLength) return undefined;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength === undefined || segmentLength < 2) return undefined;
    if (isStartOfFrameMarker(marker)) {
      if (segmentLength < 7 || offset + 7 > inspectionLength) return undefined;
      return normalizeDimensions(
        readUint16BigEndian(bytes, offset + 5),
        readUint16BigEndian(bytes, offset + 3),
      );
    }

    const nextOffset = offset + segmentLength;
    if (nextOffset <= offset || nextOffset > inspectionLength) return undefined;
    offset = nextOffset;
  }

  return undefined;
}

function inspectWebp(
  bytes: Uint8Array,
  inspectionLength: number,
): ImageDimensions | undefined {
  if (
    inspectionLength < 20 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    return undefined;
  }

  let offset = 12;
  while (offset + 8 <= inspectionLength) {
    const chunkSize = readUint32LittleEndian(bytes, offset + 4);
    if (chunkSize === undefined) return undefined;
    const dataOffset = offset + 8;
    const chunkType = asciiAt(bytes, offset, 4);

    if (chunkType === "VP8X" && chunkSize >= 10) {
      if (dataOffset + 10 > inspectionLength) return undefined;
      return normalizeDimensions(
        1 + readUint24LittleEndian(bytes, dataOffset + 4),
        1 + readUint24LittleEndian(bytes, dataOffset + 7),
      );
    }

    if (chunkType === "VP8L" && chunkSize >= 5) {
      if (dataOffset + 5 > inspectionLength || bytes[dataOffset] !== 0x2f) {
        return undefined;
      }
      const byte1 = bytes[dataOffset + 1];
      const byte2 = bytes[dataOffset + 2];
      const byte3 = bytes[dataOffset + 3];
      const byte4 = bytes[dataOffset + 4];
      if (
        byte1 === undefined ||
        byte2 === undefined ||
        byte3 === undefined ||
        byte4 === undefined
      ) {
        return undefined;
      }
      return normalizeDimensions(
        1 + byte1 + ((byte2 & 0x3f) << 8),
        1 + (byte2 >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      );
    }

    if (chunkType === "VP8 " && chunkSize >= 10) {
      if (
        dataOffset + 10 > inspectionLength ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        return undefined;
      }
      const width = readUint16LittleEndian(bytes, dataOffset + 6);
      const height = readUint16LittleEndian(bytes, dataOffset + 8);
      return normalizeDimensions(
        width === undefined ? undefined : width & 0x3fff,
        height === undefined ? undefined : height & 0x3fff,
      );
    }

    const paddedChunkSize = chunkSize + (chunkSize % 2);
    const nextOffset = dataOffset + paddedChunkSize;
    if (nextOffset <= offset || nextOffset > inspectionLength) return undefined;
    offset = nextOffset;
  }

  return undefined;
}

function isStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  return matchesBytes(
    bytes,
    offset,
    [...expected].map((character) => character.charCodeAt(0)),
  );
}

function matchesBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string | undefined {
  if (offset < 0 || offset + length > bytes.byteLength) return undefined;
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16BigEndian(
  bytes: Uint8Array,
  offset: number,
): number | undefined {
  const high = bytes[offset];
  const low = bytes[offset + 1];
  return high === undefined || low === undefined
    ? undefined
    : high * 0x100 + low;
}

function readUint16LittleEndian(
  bytes: Uint8Array,
  offset: number,
): number | undefined {
  const low = bytes[offset];
  const high = bytes[offset + 1];
  return high === undefined || low === undefined
    ? undefined
    : low + high * 0x100;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10_000
  );
}

function readUint32BigEndian(
  bytes: Uint8Array,
  offset: number,
): number | undefined {
  const byte0 = bytes[offset];
  const byte1 = bytes[offset + 1];
  const byte2 = bytes[offset + 2];
  const byte3 = bytes[offset + 3];
  if (
    byte0 === undefined ||
    byte1 === undefined ||
    byte2 === undefined ||
    byte3 === undefined
  ) {
    return undefined;
  }
  return byte0 * 0x100_0000 + byte1 * 0x1_0000 + byte2 * 0x100 + byte3;
}

function readUint32LittleEndian(
  bytes: Uint8Array,
  offset: number,
): number | undefined {
  const byte0 = bytes[offset];
  const byte1 = bytes[offset + 1];
  const byte2 = bytes[offset + 2];
  const byte3 = bytes[offset + 3];
  if (
    byte0 === undefined ||
    byte1 === undefined ||
    byte2 === undefined ||
    byte3 === undefined
  ) {
    return undefined;
  }
  return byte0 + byte1 * 0x100 + byte2 * 0x1_0000 + byte3 * 0x100_0000;
}
