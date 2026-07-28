import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import {
  SCREENSHOTSCOUT_API_KEY_MCP_PATH,
  createScreenshotScoutApiKeyHttpHandler,
  type ScreenshotScoutApiKeyHttpHandler,
  type ScreenshotScoutApiKeyHttpHandlerOptions,
} from "../http.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const LOOPBACK_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

export type LoopbackScreenshotScoutHttpServerOptions = Omit<
  ScreenshotScoutApiKeyHttpHandlerOptions,
  "allowedHosts"
>;

export type LoopbackScreenshotScoutHttpServer = {
  readonly url: URL;
  readonly close: () => Promise<void>;
};

/**
 * Internal loopback adapter used by tests and local verification only. It is
 * deliberately not exported from the package root and has no CLI entry point.
 */
export async function startLoopbackScreenshotScoutHttpServer(
  options: LoopbackScreenshotScoutHttpServerOptions = {},
): Promise<LoopbackScreenshotScoutHttpServer> {
  const handler = createScreenshotScoutApiKeyHttpHandler({
    ...options,
    allowedHosts: LOOPBACK_ALLOWED_HOSTS,
  });
  const server = createServer((request, response) => {
    void handleNodeRequest(handler, server, request, response);
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("The loopback HTTP adapter did not receive a TCP address.");
  }

  return {
    url: new URL(
      `http://${LOOPBACK_ADDRESS}:${address.port}${SCREENSHOTSCOUT_API_KEY_MCP_PATH}`,
    ),
    close: () => closeServer(server),
  };
}

async function handleNodeRequest(
  handler: ScreenshotScoutApiKeyHttpHandler,
  server: Server,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const abortController = new AbortController();
  const abortRequest = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(
        new DOMException("The HTTP client disconnected.", "AbortError"),
      );
    }
  };
  const abortIncompleteResponse = (): void => {
    if (!outgoing.writableFinished) abortRequest();
  };
  incoming.once("aborted", abortRequest);
  incoming.once("error", abortRequest);
  outgoing.once("close", abortIncompleteResponse);

  try {
    const baseUrl = loopbackBaseUrl(server);
    const requestTarget = incoming.url ?? "/";
    const requestUrl = new URL(`${baseUrl}${requestTarget}`);
    const headers = readIncomingHeaders(incoming);
    const method = incoming.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      signal: abortController.signal,
      ...(body === undefined ? {} : { body, duplex: "half" }),
    };
    const response = await handler(new Request(requestUrl, init));

    if (outgoing.destroyed) return;
    const responseBody =
      response.body === null
        ? undefined
        : Buffer.from(await response.arrayBuffer());
    if (outgoing.destroyed) return;

    for (const [name, value] of response.headers) {
      outgoing.setHeader(name, value);
    }
    outgoing.statusCode = response.status;
    if (response.statusText.length > 0) {
      outgoing.statusMessage = response.statusText;
    }
    outgoing.end(responseBody);
  } catch {
    if (!outgoing.headersSent && !outgoing.destroyed) {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        }),
      );
      outgoing.writeHead(500, {
        "Cache-Control": "no-store",
        "Content-Length": String(body.byteLength),
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      });
      outgoing.end(body);
    } else if (!outgoing.destroyed) {
      outgoing.destroy();
    }
  } finally {
    incoming.removeListener("aborted", abortRequest);
    incoming.removeListener("error", abortRequest);
    outgoing.removeListener("close", abortIncompleteResponse);
  }
}

function readIncomingHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function loopbackBaseUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The loopback HTTP adapter is not listening on TCP.");
  }
  return `http://${LOOPBACK_ADDRESS}:${address.port}`;
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.removeListener("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.removeListener("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, LOOPBACK_ADDRESS);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}
