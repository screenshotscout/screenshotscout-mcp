#!/usr/bin/env node

import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ScreenshotScoutClient,
  ScreenshotScoutConfigurationError,
} from "@screenshotscout/sdk";

import {
  redactText,
  toRedactedDiagnostic,
  type RedactedDiagnostic,
} from "./core/redaction.js";
import { createScreenshotScoutMcpServer } from "./server.js";

const ACCESS_KEY_ENVIRONMENT_VARIABLE = "SCREENSHOTSCOUT_ACCESS_KEY";
const SECRET_KEY_ENVIRONMENT_VARIABLE = "SCREENSHOTSCOUT_SECRET_KEY";

async function main(): Promise<void> {
  const sensitiveValues = readSensitiveValues();
  // The SDK reads both keys from the environment, and with a secret key it signs and sends GET.
  const client = new ScreenshotScoutClient();
  const server = createScreenshotScoutMcpServer({
    client,
    clientSupportsInlineImage: () => true,
    sensitiveValues,
    onUnexpectedError: (diagnostic) => {
      writeRedactedDiagnostic(
        "Unexpected capture failure",
        diagnostic,
        sensitiveValues,
      );
    },
  });
  const transport = new StdioServerTransport();
  let requestedExitCode = 0;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (exitCode: number): Promise<void> => {
    if (exitCode !== 0) requestedExitCode = 1;
    shutdownPromise ??= (async () => {
      try {
        await server.close();
      } catch (error) {
        requestedExitCode = 1;
        writeRedactedDiagnostic(
          "Stdio shutdown failure",
          toRedactedDiagnostic(error, {
            sensitiveValues,
            redactUrls: true,
          }),
          sensitiveValues,
        );
      } finally {
        process.stdin.destroy();
        process.exitCode = requestedExitCode;
      }
    })();
    return shutdownPromise;
  };

  const requestShutdown = (exitCode: number): void => {
    void shutdown(exitCode);
  };

  process.stderr.on("error", () => {
    // A closed diagnostics pipe cannot be recovered from within this process.
  });
  process.stdout.on("error", (error) => {
    if (isBrokenPipeError(error)) {
      requestShutdown(0);
      return;
    }

    writeRedactedDiagnostic(
      "Stdio output failure",
      toRedactedDiagnostic(error, {
        sensitiveValues,
        redactUrls: true,
      }),
      sensitiveValues,
    );
    requestShutdown(1);
  });
  process.stdin.once("end", () => requestShutdown(0));
  process.once("SIGINT", () => requestShutdown(0));
  process.once("SIGTERM", () => requestShutdown(0));
  server.server.onerror = (error) => {
    const diagnostic = toRedactedDiagnostic(error, {
      sensitiveValues,
      redactUrls: true,
    });
    writeStderr(
      `[screenshotscout-mcp] MCP protocol error (${redactText(diagnostic.name, {
        sensitiveValues,
        redactUrls: true,
        maxLength: 200,
      })}).\n`,
    );
  };

  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

/** The raw key values, so diagnostics can redact them. */
function readSensitiveValues(): (string | undefined)[] {
  return [
    process.env[ACCESS_KEY_ENVIRONMENT_VARIABLE],
    process.env[SECRET_KEY_ENVIRONMENT_VARIABLE],
  ];
}

function writeRedactedDiagnostic(
  label: string,
  diagnostic: RedactedDiagnostic,
  sensitiveValues: readonly (string | null | undefined)[],
): void {
  const name = redactText(diagnostic.name, {
    sensitiveValues,
    redactUrls: true,
    maxLength: 200,
  });
  const message = redactText(diagnostic.message, {
    sensitiveValues,
    redactUrls: true,
    maxLength: 1_000,
  });
  writeStderr(`[screenshotscout-mcp] ${label} (${name}): ${message}\n`);
}

function writeStderr(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // Diagnostics must not turn a recoverable failure into a process crash.
  }
}

function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  try {
    const code = Reflect.get(error, "code") as unknown;
    return (
      code === "EPIPE" ||
      code === "ECONNRESET" ||
      code === "ERR_STREAM_DESTROYED" ||
      code === "ERR_STREAM_WRITE_AFTER_END"
    );
  } catch {
    return false;
  }
}

void main().catch((error: unknown) => {
  const sensitiveValues = readSensitiveValues();

  if (error instanceof ScreenshotScoutConfigurationError) {
    const message = redactText(error.message, {
      sensitiveValues,
      redactUrls: true,
      maxLength: 1_000,
    });
    writeStderr(`[screenshotscout-mcp] Startup failed: ${message}\n`);
  } else {
    writeRedactedDiagnostic(
      "Startup failed",
      toRedactedDiagnostic(error, {
        sensitiveValues,
        redactUrls: true,
      }),
      sensitiveValues,
    );
  }
  process.exitCode = 1;
});
