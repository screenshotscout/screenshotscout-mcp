import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_SERIALIZED_RESULT_BYTES,
  INLINE_IMAGE_OMISSION_REASONS,
  MAX_INLINE_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_RAW_BYTES,
  asInlineImageMimeType,
  evaluateInlineImage,
  inspectImageDimensions,
  normalizeMimeType,
  resolveImageDimensions,
  type InlineImageCandidate,
} from "../../src/core/image.js";
import {
  createGifHeader,
  createJpegHeader,
  createPngHeader,
  createWebpHeader,
} from "../fixtures/image-headers.js";

const supportsInlineImage = () => true;
const buildSerializedResult: InlineImageCandidate["buildSerializedResult"] = (
  image,
  dimensions,
) => ({
  content: [{ type: "text", text: "capture" }, image],
  structuredContent: {
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
    inlineImageIncluded: true,
  },
});

function evaluate(
  candidate: Omit<
    InlineImageCandidate,
    "buildSerializedResult" | "clientSupportsInlineImage" | "resultMode"
  > &
    Partial<
      Pick<
        InlineImageCandidate,
        "buildSerializedResult" | "clientSupportsInlineImage" | "resultMode"
      >
    >,
) {
  return evaluateInlineImage({
    resultMode: "auto",
    clientSupportsInlineImage: supportsInlineImage,
    buildSerializedResult,
    ...candidate,
  });
}

void test("MIME types are normalized without widening the inline allowlist", () => {
  assert.equal(normalizeMimeType(" IMAGE/PNG ; charset=binary "), "image/png");
  assert.equal(normalizeMimeType("image/jpeg"), "image/jpeg");
  assert.equal(normalizeMimeType("  "), undefined);
  assert.equal(normalizeMimeType(null), undefined);

  assert.equal(asInlineImageMimeType("IMAGE/WEBP; q=1"), "image/webp");
  assert.equal(asInlineImageMimeType("image/tiff"), undefined);
  assert.equal(asInlineImageMimeType("image/jpg"), undefined);
});

void test("bounded header inspection reads PNG, JPEG, WebP, and GIF dimensions", () => {
  const cases = [
    {
      bytes: createPngHeader(1_200, 800),
      mimeType: "image/png",
    },
    {
      bytes: createJpegHeader(1_201, 801),
      mimeType: "IMAGE/JPEG; charset=binary",
    },
    {
      bytes: createWebpHeader(1_202, 802),
      mimeType: "image/webp",
    },
    {
      bytes: createGifHeader(1_203, 803),
      mimeType: "image/gif",
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    assert.deepEqual(inspectImageDimensions(item.bytes, item.mimeType), {
      width: 1_200 + index,
      height: 800 + index,
    });
  }
});

void test("unknown or corrupt dimensions are rejected while corrupt trusted metadata falls back to a valid header", () => {
  assert.equal(
    inspectImageDimensions(Uint8Array.of(1, 2, 3), "image/png"),
    undefined,
  );
  assert.equal(
    inspectImageDimensions(createPngHeader(640, 480), "image/png", 20),
    undefined,
  );
  assert.deepEqual(
    resolveImageDimensions(createPngHeader(640, 480), "image/png", {
      imageWidth: 0,
      imageHeight: Number.NaN,
    }),
    { width: 640, height: 480 },
  );
  assert.deepEqual(
    resolveImageDimensions(Uint8Array.of(1, 2, 3), "image/png", {
      imageWidth: 320,
      imageHeight: 200,
    }),
    { width: 320, height: 200 },
  );
});

void test("every approved inline format, including the jpg/jpeg alias pair, produces an MCP image", () => {
  const cases = [
    {
      format: "png",
      mimeType: "image/png",
      bytes: createPngHeader(640, 480),
    },
    {
      format: "jpg",
      mimeType: "image/jpeg",
      bytes: createJpegHeader(641, 481),
    },
    {
      format: "jpeg",
      mimeType: "IMAGE/JPEG; charset=binary",
      bytes: createJpegHeader(642, 482),
    },
    {
      format: "webp",
      mimeType: "image/webp",
      bytes: createWebpHeader(643, 483),
    },
    {
      format: "gif",
      mimeType: "image/gif",
      bytes: createGifHeader(644, 484),
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const result = evaluate(item);
    assert.equal(result.included, true);
    if (!result.included) continue;
    assert.equal(result.image.type, "image");
    assert.equal(result.image.mimeType, normalizeMimeType(item.mimeType));
    assert.equal(
      Buffer.from(result.image.data, "base64").byteLength,
      item.bytes.byteLength,
    );
    assert.deepEqual(result.dimensions, {
      width: 640 + index,
      height: 480 + index,
    });
  }
});

void test("url_only, TIFF, and PDF are URL-only result branches", () => {
  const urlOnly = evaluate({
    format: "png",
    resultMode: "url_only",
    mimeType: "image/png",
    bytes: createPngHeader(640, 480),
  });
  assert.deepEqual(urlOnly, {
    included: false,
    reason: INLINE_IMAGE_OMISSION_REASONS.RESULT_MODE_URL_ONLY,
    rawBytes: 24,
    serializedSizeLimitBytes: DEFAULT_MAX_SERIALIZED_RESULT_BYTES,
  });

  for (const item of [
    {
      format: "tiff",
      mimeType: "image/tiff",
      bytes: Uint8Array.of(1, 2, 3),
    },
    {
      format: "pdf",
      mimeType: "application/pdf",
      bytes: Uint8Array.of(1, 2, 3),
    },
  ] as const) {
    const result = evaluate(item);
    assert.equal(result.included, false);
    if (result.included) continue;
    assert.equal(
      result.reason,
      INLINE_IMAGE_OMISSION_REASONS.FORMAT_NOT_INLINE_ELIGIBLE,
    );
  }
});

void test("unsupported, mismatched, and client-incompatible images remain non-error fallbacks", () => {
  const unsupported = evaluate({
    format: "png",
    mimeType: "image/tiff",
    bytes: createPngHeader(640, 480),
  });
  assert.equal(unsupported.included, false);
  if (!unsupported.included) {
    assert.equal(
      unsupported.reason,
      INLINE_IMAGE_OMISSION_REASONS.UNSUPPORTED_MIME_TYPE,
    );
  }

  const mismatch = evaluate({
    format: "png",
    mimeType: "image/jpeg",
    bytes: createJpegHeader(640, 480),
  });
  assert.equal(mismatch.included, false);
  if (!mismatch.included) {
    assert.equal(
      mismatch.reason,
      INLINE_IMAGE_OMISSION_REASONS.MIME_TYPE_MISMATCH,
    );
  }

  const clientIncompatible = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(640, 480),
    clientSupportsInlineImage: () => false,
  });
  assert.equal(clientIncompatible.included, false);
  if (!clientIncompatible.included) {
    assert.equal(
      clientIncompatible.reason,
      INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE,
    );
    assert.deepEqual(clientIncompatible.dimensions, {
      width: 640,
      height: 480,
    });
  }
});

void test("8,000 pixels is included and 8,001 pixels is omitted", () => {
  const atBoundary = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(
      MAX_INLINE_IMAGE_DIMENSION,
      MAX_INLINE_IMAGE_DIMENSION,
    ),
  });
  assert.equal(atBoundary.included, true);

  for (const dimensions of [
    { width: MAX_INLINE_IMAGE_DIMENSION + 1, height: 1 },
    { width: 1, height: MAX_INLINE_IMAGE_DIMENSION + 1 },
  ]) {
    const overBoundary = evaluate({
      format: "png",
      mimeType: "image/png",
      bytes: createPngHeader(dimensions.width, dimensions.height),
    });
    assert.equal(overBoundary.included, false);
    if (!overBoundary.included) {
      assert.equal(
        overBoundary.reason,
        INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_EXCEED_LIMIT,
      );
      assert.deepEqual(overBoundary.dimensions, dimensions);
    }
  }
});

void test("unknown dimensions omit inline data without treating the capture as an error", () => {
  const result = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: Uint8Array.of(137, 80, 78, 71),
  });

  assert.equal(result.included, false);
  if (!result.included) {
    assert.equal(
      result.reason,
      INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_UNAVAILABLE,
    );
  }
});

void test("5 MiB is the inclusive raw ceiling and serialization remains a lower independent ceiling", () => {
  const atRawBoundary = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1, MAX_INLINE_IMAGE_RAW_BYTES),
  });
  assert.equal(atRawBoundary.included, false);
  if (!atRawBoundary.included) {
    assert.equal(
      atRawBoundary.reason,
      INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
    );
  }

  const overRawBoundary = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1, MAX_INLINE_IMAGE_RAW_BYTES + 1),
  });
  assert.equal(overRawBoundary.included, false);
  if (!overRawBoundary.included) {
    assert.equal(
      overRawBoundary.reason,
      INLINE_IMAGE_OMISSION_REASONS.RAW_SIZE_EXCEEDS_LIMIT,
    );
  }
});

void test("serialized-size checks include base64 and the complete tool-result overhead", () => {
  const baseline = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1),
  });
  assert.equal(baseline.included, true);
  if (!baseline.included) return;

  const exactBoundary = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1),
    serializedSizeLimitBytes: baseline.serializedBytes,
  });
  assert.equal(exactBoundary.included, true);

  const belowBoundary = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1),
    serializedSizeLimitBytes: baseline.serializedBytes - 1,
  });
  assert.equal(belowBoundary.included, false);
  if (!belowBoundary.included) {
    assert.equal(
      belowBoundary.reason,
      INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
    );
  }

  const base64FitsButEnvelopeDoesNot = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: Uint8Array.of(1, 2, 3),
    trustedDimensions: { imageWidth: 1, imageHeight: 1 },
    serializedSizeLimitBytes: 4,
  });
  assert.equal(base64FitsButEnvelopeDoesNot.included, false);
  if (!base64FitsButEnvelopeDoesNot.included) {
    assert.equal(
      base64FitsButEnvelopeDoesNot.reason,
      INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
    );
  }
});

void test("unmeasurable serialization and compatibility probes fail closed", () => {
  const serializationUnavailable = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1),
    stringify: () => undefined,
  });
  assert.equal(serializationUnavailable.included, false);
  if (!serializationUnavailable.included) {
    assert.equal(
      serializationUnavailable.reason,
      INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_UNAVAILABLE,
    );
  }

  const compatibilityUnavailable = evaluate({
    format: "png",
    mimeType: "image/png",
    bytes: createPngHeader(1, 1),
    clientSupportsInlineImage: () => {
      throw new Error("probe failure");
    },
  });
  assert.equal(compatibilityUnavailable.included, false);
  if (!compatibilityUnavailable.included) {
    assert.equal(
      compatibilityUnavailable.reason,
      INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE,
    );
  }
});
