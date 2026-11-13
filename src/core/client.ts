import {
  ScreenshotScoutClient,
  type BinaryCaptureOptions,
  type BinaryCaptureResponse,
  type CaptureRequestOptions,
  type ScreenshotScoutClientOptions,
  type ScreenshotScoutFetch,
} from "@screenshotscout/sdk";

export type ScreenshotScoutCredentials = {
  readonly accessKey: string;
  readonly secretKey?: string;
};

export interface ScreenshotScoutCaptureClient {
  capture(
    targetUrl: string,
    captureOptions?: BinaryCaptureOptions | null,
    captureRequestOptions?: CaptureRequestOptions | null,
  ): Promise<BinaryCaptureResponse>;
}

export type ScreenshotScoutClientFactory = (
  options: ScreenshotScoutClientOptions,
) => ScreenshotScoutCaptureClient;

export type ScreenshotScoutClientDependencies = {
  readonly clientFactory?: ScreenshotScoutClientFactory;
  readonly fetch?: ScreenshotScoutFetch;
};

export type ScreenshotScoutClientSettings = {
  /** Base URL that captures are sent to. Defaults to the Screenshot Scout API. */
  readonly baseUrl?: string;
};

const DEFAULT_BASE_URL = "https://api.screenshotscout.com";

const defaultClientFactory: ScreenshotScoutClientFactory = (options) =>
  new ScreenshotScoutClient(options);

/**
 * Constructs the official SDK client from credentials and settings supplied by
 * the caller. Environment, transport, and tool layers remain outside this core.
 */
export function createScreenshotScoutClient(
  credentials: ScreenshotScoutCredentials,
  dependencies: ScreenshotScoutClientDependencies = {},
  settings: ScreenshotScoutClientSettings = {},
): ScreenshotScoutCaptureClient {
  const options: ScreenshotScoutClientOptions = {
    accessKey: credentials.accessKey,
    ...(credentials.secretKey === undefined
      ? {}
      : { secretKey: credentials.secretKey }),
    // Always a non-empty string, so the SDK never falls back to SCREENSHOTSCOUT_BASE_URL here,
    // even when a JavaScript caller passes null.
    baseUrl:
      typeof settings.baseUrl === "string" && settings.baseUrl !== ""
        ? settings.baseUrl
        : DEFAULT_BASE_URL,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };

  return (dependencies.clientFactory ?? defaultClientFactory)(options);
}
