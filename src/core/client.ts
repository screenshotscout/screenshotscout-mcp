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

const defaultClientFactory: ScreenshotScoutClientFactory = (options) =>
  new ScreenshotScoutClient(options);

/**
 * Constructs the official SDK client from credentials supplied by the caller.
 * Environment, transport, and tool layers remain outside this core.
 */
export function createScreenshotScoutClient(
  credentials: ScreenshotScoutCredentials,
  dependencies: ScreenshotScoutClientDependencies = {},
): ScreenshotScoutCaptureClient {
  const options: ScreenshotScoutClientOptions = {
    accessKey: credentials.accessKey,
    ...(credentials.secretKey === undefined
      ? {}
      : { secretKey: credentials.secretKey }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };

  return (dependencies.clientFactory ?? defaultClientFactory)(options);
}
