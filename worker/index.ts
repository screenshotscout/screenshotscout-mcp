import { createScreenshotScoutApiKeyHttpHandler } from "../src/http.js";
import * as Sentry from "@sentry/cloudflare";

import {
  captureUnexpectedWorkerError,
  createSentryOptions,
  logSentryRequestCompletion,
  type WorkerEnv,
} from "./sentry.js";

const handleRequest = createScreenshotScoutApiKeyHttpHandler({
  allowedHosts: ["mcp.screenshotscout.com"],
  onUnexpectedError(diagnostic) {
    captureUnexpectedWorkerError(diagnostic);
    console.error("[mcpserver] Unexpected Worker failure.", diagnostic);
  },
});

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const startedAt = Date.now();
    const response = await handleRequest(request);
    logSentryRequestCompletion(env, request, response, Date.now() - startedAt);
    return response;
  },
};

export default Sentry.withSentry<WorkerEnv>(createSentryOptions, worker);
