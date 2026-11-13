import {
  createScreenshotScoutApiKeyHttpHandler,
  type ScreenshotScoutApiKeyHttpHandler,
} from "../src/http.js";
import * as Sentry from "@sentry/cloudflare";

import {
  captureUnexpectedWorkerError,
  createSentryOptions,
  logSentryRequestCompletion,
  type WorkerEnv,
} from "./sentry.js";

let handleRequest: ScreenshotScoutApiKeyHttpHandler | undefined;

// Created on the first request, because the base URL comes from the Worker's vars.
function getRequestHandler(env: WorkerEnv): ScreenshotScoutApiKeyHttpHandler {
  handleRequest ??= createScreenshotScoutApiKeyHttpHandler({
    allowedHosts: ["mcp.screenshotscout.com"],
    ...(env.SCREENSHOTSCOUT_BASE_URL === undefined
      ? {}
      : { baseUrl: env.SCREENSHOTSCOUT_BASE_URL }),
    onUnexpectedError(diagnostic) {
      captureUnexpectedWorkerError(diagnostic);
      console.error("[mcpserver] Unexpected Worker failure.", diagnostic);
    },
  });
  return handleRequest;
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const startedAt = Date.now();
    const response = await getRequestHandler(env)(request);
    logSentryRequestCompletion(env, request, response, Date.now() - startedAt);
    return response;
  },
};

export default Sentry.withSentry<WorkerEnv>(createSentryOptions, worker);
