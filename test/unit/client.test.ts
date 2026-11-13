import assert from "node:assert/strict";
import test from "node:test";

import type {
  ScreenshotScoutClientOptions,
  ScreenshotScoutFetch,
} from "@screenshotscout/sdk";

import {
  createScreenshotScoutClient,
  type ScreenshotScoutClientSettings,
} from "../../src/core/client.js";

const PRODUCTION_CAPTURE_URL = "https://api.screenshotscout.com/v1/capture";

function recordOptions(
  settings?: ScreenshotScoutClientSettings,
): ScreenshotScoutClientOptions {
  let recorded: ScreenshotScoutClientOptions | undefined;
  createScreenshotScoutClient(
    { accessKey: "access-key" },
    {
      clientFactory: (options) => {
        recorded = options;
        return {
          capture: () => Promise.reject(new Error("Unexpected capture")),
        };
      },
    },
    settings,
  );
  assert.ok(recorded);
  return recorded;
}

void test("the core passes the production base URL unless a non-empty base URL is set", () => {
  const cases: readonly (ScreenshotScoutClientSettings | undefined)[] = [
    undefined,
    {},
    { baseUrl: "" },
    // A JavaScript caller can pass null despite the type.
    { baseUrl: null as unknown as string },
  ];

  for (const settings of cases) {
    assert.equal(
      recordOptions(settings).baseUrl,
      "https://api.screenshotscout.com",
    );
  }
  assert.equal(
    recordOptions({ baseUrl: "http://localhost:8787" }).baseUrl,
    "http://localhost:8787",
  );
});

void test("the core never lets the SDK read SCREENSHOTSCOUT_BASE_URL", async () => {
  const previous = process.env.SCREENSHOTSCOUT_BASE_URL;
  process.env.SCREENSHOTSCOUT_BASE_URL = "http://server-environment.invalid";

  try {
    for (const settings of [
      undefined,
      { baseUrl: "" },
      { baseUrl: null as unknown as string },
    ]) {
      const requestedUrls: string[] = [];
      const fetch: ScreenshotScoutFetch = (input) => {
        requestedUrls.push(
          input instanceof Request ? input.url : input.toString(),
        );
        return Promise.resolve(
          new Response(Uint8Array.of(1), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      };
      const client = createScreenshotScoutClient(
        { accessKey: "access-key" },
        { fetch },
        settings,
      );

      await client.capture("https://example.com");

      assert.deepEqual(requestedUrls, [PRODUCTION_CAPTURE_URL]);
    }
  } finally {
    if (previous === undefined) delete process.env.SCREENSHOTSCOUT_BASE_URL;
    else process.env.SCREENSHOTSCOUT_BASE_URL = previous;
  }
});
