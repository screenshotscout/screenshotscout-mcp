import assert from "node:assert/strict";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  INLINE_IMAGE_OMISSION_REASONS,
  type InlineImageOmissionReason,
} from "../../src/core/image.js";
import { formatCaptureSuccess } from "../../src/core/result.js";

function resultText(result: CallToolResult): string {
  const content = result.content[0];
  assert.ok(content?.type === "text");
  return content.text;
}

void test("every inline omission branch returns a non-error, model-actionable explanation", () => {
  const cases: readonly {
    readonly reason: InlineImageOmissionReason;
    readonly expectedText: readonly RegExp[];
  }[] = [
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.RESULT_MODE_URL_ONLY,
      expectedText: [/resultMode was url_only/, /temporary URL/i],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.FORMAT_NOT_INLINE_ELIGIBLE,
      expectedText: [/URL-only/, /resultMode: url_only/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.UNSUPPORTED_MIME_TYPE,
      expectedText: [/MIME type/, /resultMode: url_only/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.MIME_TYPE_MISMATCH,
      expectedText: [/did not match/, /resultMode: url_only/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.RAW_SIZE_EXCEEDS_LIMIT,
      expectedText: [/raw inline-size limit/, /temporary URL/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_UNAVAILABLE,
      expectedText: [/could not be verified safely/, /temporary URL/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.DIMENSIONS_EXCEED_LIMIT,
      expectedText: [/8,000-pixel/, /temporary URL/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.CLIENT_NOT_COMPATIBLE,
      expectedText: [/current client/, /resultMode: url_only/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_UNAVAILABLE,
      expectedText: [/could not be measured/, /resultMode: url_only/],
    },
    {
      reason: INLINE_IMAGE_OMISSION_REASONS.SERIALIZED_SIZE_EXCEEDS_LIMIT,
      expectedText: [/complete tool result/, /temporary URL/],
    },
  ];

  for (const item of cases) {
    const result = formatCaptureSuccess({
      metadata: {
        screenshotUrl: "https://cdn.example/capture.png",
        format: "png",
        mimeType: "image/png",
        inlineImageIncluded: false,
        inlineImageOmissionReason: item.reason,
      },
    });
    const text = resultText(result);

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(
      result.structuredContent?.inlineImageOmissionReason,
      item.reason,
    );
    for (const pattern of item.expectedText) {
      assert.match(text, pattern);
    }
  }
});
