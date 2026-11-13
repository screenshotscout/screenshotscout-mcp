import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CaptureRequestOptions } from "@screenshotscout/sdk";

import {
  createScreenshotScoutClient,
  type ScreenshotScoutCaptureClient,
  type ScreenshotScoutClientDependencies,
} from "./core/client.js";
import type { InlineImageMimeType } from "./core/image.js";
import {
  redactText,
  toRedactedDiagnostic,
  type RedactedDiagnostic,
} from "./core/redaction.js";
import { createScreenshotScoutMcpServer } from "./server.js";

export const SCREENSHOTSCOUT_API_KEY_MCP_PATH = "/mcp/api-key";
export const DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES = 64 * 1_024;

const BEARER_AUTHORIZATION_PATTERN =
  /^[\t ]*Bearer +([A-Za-z0-9\-._~+/]+=*)[\t ]*$/i;
const JSON_RPC_CONTENT_TYPE = "application/json";
const HTTP_METHOD_ALLOWLIST = "POST";
const AUTHENTICATION_CHALLENGE = 'Bearer realm="Screenshot Scout"';
const INVALID_AUTHENTICATION_CHALLENGE =
  'Bearer realm="Screenshot Scout", error="invalid_token"';

export type ScreenshotScoutApiKeyHttpHandler = (
  request: Request,
) => Promise<Response>;

export type ScreenshotScoutApiKeyHttpHandlerOptions = {
  /**
   * Hostnames accepted from the Host header. Values do not include ports.
   * Host validation is mandatory and port-agnostic.
   */
  readonly allowedHosts: readonly string[];
  /**
   * Origins accepted when an Origin header is present. An omitted or empty
   * list rejects every supplied Origin while still allowing non-browser
   * clients that do not send one.
   */
  readonly allowedOrigins?: readonly string[];
  readonly maxRequestBodyBytes?: number;
  /** Base URL that captures are sent to. Defaults to the Screenshot Scout API. */
  readonly baseUrl?: string;
  readonly clientDependencies?: ScreenshotScoutClientDependencies;
  readonly clientSupportsInlineImage?: (
    mimeType: InlineImageMimeType,
  ) => boolean;
  readonly maxSerializedResultBytes?: number;
  readonly onUnexpectedError?: (diagnostic: RedactedDiagnostic) => void;
};

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("The MCP request body exceeded the configured limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

class RequestBodyReadError extends Error {
  constructor() {
    super("The MCP request body could not be read.");
    this.name = "RequestBodyReadError";
  }
}

/**
 * Creates the provider-neutral Fetch handler for the authenticated, stateless
 * Screenshot Scout MCP endpoint. Each POST receives a fresh MCP server and
 * official Web Standards transport, as required by the SDK's stateless mode.
 */
export function createScreenshotScoutApiKeyHttpHandler(
  options: ScreenshotScoutApiKeyHttpHandlerOptions,
): ScreenshotScoutApiKeyHttpHandler {
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
  const maxRequestBodyBytes = resolveRequestBodyLimit(
    options.maxRequestBodyBytes,
  );

  return async (request) => {
    const sensitiveValues: string[] = [];

    try {
      const hostError = validateHost(request, allowedHosts);
      if (hostError !== undefined) return secureResponse(hostError);

      const originError = validateOrigin(request, allowedOrigins);
      if (originError !== undefined) return secureResponse(originError);

      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== SCREENSHOTSCOUT_API_KEY_MCP_PATH) {
        return secureResponse(jsonRpcErrorResponse(404, -32004, "Not found."));
      }
      if (requestUrl.search.length > 0) {
        return secureResponse(
          jsonRpcErrorResponse(
            400,
            -32600,
            "Query parameters are not supported at this MCP endpoint.",
          ),
        );
      }

      if (hasForbiddenCredentialHeader(request.headers)) {
        return secureResponse(
          jsonRpcErrorResponse(
            400,
            -32600,
            "Remote credentials are accepted only as an access key in the Authorization header.",
          ),
        );
      }

      const authorization = resolveBearerAccessKey(
        request.headers.get("authorization"),
      );
      if (!authorization.ok) {
        return secureResponse(
          jsonRpcErrorResponse(
            401,
            -32001,
            authorization.missing
              ? "Authentication is required."
              : "Authentication is invalid.",
            {
              "WWW-Authenticate": authorization.missing
                ? AUTHENTICATION_CHALLENGE
                : INVALID_AUTHENTICATION_CHALLENGE,
            },
          ),
        );
      }
      const accessKey = authorization.accessKey;
      sensitiveValues.push(accessKey);

      if (request.method !== HTTP_METHOD_ALLOWLIST) {
        return secureResponse(methodNotAllowedResponse());
      }

      if (!isJsonContentType(request.headers.get("content-type"))) {
        return secureResponse(
          jsonRpcErrorResponse(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json.",
          ),
        );
      }

      const declaredLength = readContentLength(
        request.headers.get("content-length"),
      );
      if (
        declaredLength === "invalid" ||
        (typeof declaredLength === "number" &&
          declaredLength > maxRequestBodyBytes)
      ) {
        return secureResponse(
          jsonRpcErrorResponse(
            413,
            -32000,
            "The MCP request body is too large.",
          ),
        );
      }

      let parsedBody: unknown;
      try {
        parsedBody = await readJsonBody(request, maxRequestBodyBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return secureResponse(
            jsonRpcErrorResponse(
              413,
              -32000,
              "The MCP request body is too large.",
            ),
          );
        }
        return secureResponse(
          jsonRpcErrorResponse(400, -32700, "Parse error: Invalid JSON."),
        );
      }

      if (containsForbiddenCredentialField(parsedBody)) {
        return secureResponse(
          jsonRpcErrorResponse(
            400,
            -32600,
            "Remote credentials are accepted only as an access key in the Authorization header.",
          ),
        );
      }

      const baseClient = createScreenshotScoutClient(
        { accessKey },
        options.clientDependencies,
        options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
      );
      const client = bindRequestCancellation(baseClient, request.signal);
      const server = createScreenshotScoutMcpServer({
        client,
        clientSupportsInlineImage:
          options.clientSupportsInlineImage ?? (() => true),
        ...(options.maxSerializedResultBytes === undefined
          ? {}
          : { maxSerializedResultBytes: options.maxSerializedResultBytes }),
        sensitiveValues,
        onUnexpectedError: (diagnostic) => {
          reportDiagnostic(options.onUnexpectedError, diagnostic);
        },
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const reportProtocolError = (error: unknown): void => {
        reportDiagnostic(
          options.onUnexpectedError,
          toRedactedDiagnostic(error, {
            sensitiveValues,
            redactUrls: true,
          }),
        );
      };
      transport.onerror = reportProtocolError;
      server.server.onerror = reportProtocolError;

      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request, {
          parsedBody,
        });
        return secureResponse(response);
      } finally {
        try {
          await server.close();
        } catch (error) {
          reportProtocolError(error);
        }
      }
    } catch (error) {
      reportDiagnostic(
        options.onUnexpectedError,
        toRedactedDiagnostic(error, {
          sensitiveValues,
          redactUrls: true,
        }),
      );
      return secureResponse(
        jsonRpcErrorResponse(500, -32603, "Internal server error."),
      );
    }
  };
}

function bindRequestCancellation(
  client: ScreenshotScoutCaptureClient,
  requestSignal: AbortSignal,
): ScreenshotScoutCaptureClient {
  return {
    capture(targetUrl, captureOptions, captureRequestOptions) {
      const invocationSignal =
        captureRequestOptions?.signal === null
          ? undefined
          : captureRequestOptions?.signal;
      const signal =
        invocationSignal === undefined || invocationSignal === requestSignal
          ? requestSignal
          : AbortSignal.any([requestSignal, invocationSignal]);
      const requestOptions: CaptureRequestOptions = {
        ...(captureRequestOptions?.method === undefined ||
        captureRequestOptions.method === null
          ? {}
          : { method: captureRequestOptions.method }),
        signal,
      };

      return client.capture(targetUrl, captureOptions, requestOptions);
    },
  };
}

function validateHost(
  request: Request,
  allowedHosts: ReadonlySet<string>,
): Response | undefined {
  const hostname = parseHostHeader(request.headers.get("host"));
  if (hostname === undefined || !allowedHosts.has(hostname)) {
    return jsonRpcErrorResponse(403, -32000, "Forbidden Host header.");
  }
  return undefined;
}

function validateOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response | undefined {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null) return undefined;

  const origin = parseOrigin(rawOrigin);
  if (origin === undefined || !allowedOrigins.has(origin)) {
    return jsonRpcErrorResponse(403, -32000, "Forbidden Origin header.");
  }
  return undefined;
}

function normalizeAllowedHosts(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("At least one allowed Host hostname is required.");
  }

  const output = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new TypeError("Allowed Host values must be strings.");
    }
    const candidate = value.trim();
    const parsed = parseAuthority(candidate);
    if (
      parsed === undefined ||
      parsed.port.length > 0 ||
      candidate.includes("@")
    ) {
      throw new TypeError(
        "Allowed Host values must be hostnames without ports.",
      );
    }
    output.add(parsed.hostname);
  }
  return output;
}

function normalizeAllowedOrigins(
  values: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(values)) {
    throw new TypeError("Allowed Origin values must be an array.");
  }

  const output = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new TypeError("Allowed Origin values must be strings.");
    }
    const origin = parseOrigin(value);
    if (origin === undefined) {
      throw new TypeError(
        "Allowed Origin values must be HTTP or HTTPS origins.",
      );
    }
    output.add(origin);
  }
  return output;
}

function parseHostHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.includes(",") ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.includes("@")
  ) {
    return undefined;
  }
  return parseAuthority(candidate)?.hostname;
}

function parseAuthority(
  value: string,
): { readonly hostname: string; readonly port: string } | undefined {
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.hostname.length === 0
    ) {
      return undefined;
    }
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

function parseOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function resolveBearerAccessKey(
  value: string | null,
):
  | { readonly ok: true; readonly accessKey: string }
  | { readonly ok: false; readonly missing: boolean } {
  if (value === null) return { ok: false, missing: true };
  const match = BEARER_AUTHORIZATION_PATTERN.exec(value);
  const accessKey = match?.[1];
  return accessKey === undefined
    ? { ok: false, missing: false }
    : { ok: true, accessKey };
}

function hasForbiddenCredentialHeader(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = normalizeCredentialName(name);
    if (
      normalized.endsWith("accesskey") ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("secretkey") ||
      normalized.endsWith("signature")
    ) {
      return true;
    }
  }
  return false;
}

function containsForbiddenCredentialField(value: unknown): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== "object" || item === null) continue;

    if (Array.isArray(item)) {
      for (const nested of item as unknown[]) {
        pending.push(nested);
      }
      continue;
    }

    for (const [key, nested] of Object.entries(item)) {
      const normalized = normalizeCredentialName(key);
      if (
        normalized === "accesskey" ||
        normalized === "apikey" ||
        normalized === "screenshotscoutaccesskey" ||
        normalized === "screenshotscoutapikey" ||
        normalized === "secretkey" ||
        normalized === "screenshotscoutsecretkey" ||
        normalized === "authorization" ||
        normalized === "signature"
      ) {
        return true;
      }
      pending.push(nested);
    }
  }

  return false;
}

function normalizeCredentialName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isJsonContentType(value: string | null): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() === JSON_RPC_CONTENT_TYPE
  );
}

function readContentLength(
  value: string | null,
): number | "invalid" | undefined {
  if (value === null) return undefined;
  const candidate = value.trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(candidate)) return "invalid";

  const length = Number(candidate);
  return Number.isSafeInteger(length) ? length : "invalid";
}

async function readJsonBody(
  request: Request,
  maxRequestBodyBytes: number,
): Promise<unknown> {
  const bytes = await readBodyBytes(request, maxRequestBodyBytes);

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyReadError();
  }
}

async function readBodyBytes(
  request: Request,
  maxRequestBodyBytes: number,
): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  if (request.signal.aborted) throw new RequestBodyReadError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let aborted = false;
  const abortRead = (): void => {
    aborted = true;
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener("abort", abortRead, { once: true });

  try {
    for (;;) {
      const next = await reader.read();
      if (aborted || request.signal.aborted) {
        throw new RequestBodyReadError();
      }
      if (next.done) break;

      totalBytes += next.value.byteLength;
      if (totalBytes > maxRequestBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof RequestBodyReadError
    ) {
      throw error;
    }
    throw new RequestBodyReadError();
  } finally {
    request.signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function resolveRequestBodyLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "The maximum HTTP request body size must be a positive safe integer.",
    );
  }
  return value;
}

function methodNotAllowedResponse(): Response {
  return jsonRpcErrorResponse(405, -32000, "Method not allowed.", {
    Allow: HTTP_METHOD_ALLOWLIST,
  });
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": JSON_RPC_CONTENT_TYPE,
        ...extraHeaders,
      },
    },
  );
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  appendVary(headers, "Authorization");
  appendVary(headers, "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVary(headers: Headers, value: string): void {
  const values = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
  values.add(value);
  headers.set("Vary", [...values].join(", "));
}

function reportDiagnostic(
  callback: ((diagnostic: RedactedDiagnostic) => void) | undefined,
  diagnostic: RedactedDiagnostic,
): void {
  if (callback === undefined) return;

  try {
    callback({
      name: redactText(diagnostic.name, {
        redactUrls: true,
        maxLength: 200,
      }),
      message: redactText(diagnostic.message, {
        redactUrls: true,
        maxLength: 2_000,
      }),
      ...(diagnostic.stack === undefined
        ? {}
        : {
            stack: redactText(diagnostic.stack, {
              redactUrls: true,
              maxLength: 8_000,
            }),
          }),
    });
  } catch {
    // Diagnostics must never affect the HTTP response.
  }
}
