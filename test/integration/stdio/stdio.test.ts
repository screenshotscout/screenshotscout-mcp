import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  SCREENSHOTSCOUT_MCP_SERVER_INSTRUCTIONS,
  SCREENSHOTSCOUT_MCP_SERVER_NAME,
  SCREENSHOTSCOUT_MCP_SERVER_VERSION,
} from "../../../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const executablePath = join(repositoryRoot, "dist", "stdio.js");
const mockFetchPath = fileURLToPath(
  new URL("../../fixtures/stdio-mock-fetch.mjs", import.meta.url),
);

type StdioSessionResult<T> = {
  readonly result: T;
  readonly stdout: string;
  readonly stderr: string;
};

void test(
  "the built stdio executable initializes, lists one tool, calls image and PDF mocks, and signs locally",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey();
    const secretKey = createSecretKey();
    const targetUrl =
      "https://target.example.test/private?token=not-for-output";

    const session = await runStdioSession(
      {
        SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
        SCREENSHOTSCOUT_SECRET_KEY: secretKey,
        SCREENSHOTSCOUT_MCP_TEST_SIGNING_EXPECTATION: "required",
      },
      async (client) => {
        assert.deepEqual(client.getServerVersion(), {
          name: SCREENSHOTSCOUT_MCP_SERVER_NAME,
          version: SCREENSHOTSCOUT_MCP_SERVER_VERSION,
        });
        assert.equal(
          client.getInstructions(),
          SCREENSHOTSCOUT_MCP_SERVER_INSTRUCTIONS,
        );
        assert.match(
          client.getInstructions() ?? "",
          /call capture_screenshot with only url/i,
        );
        assert.match(
          client.getInstructions() ?? "",
          /optional arguments only when the user explicitly requests them/i,
        );
        assert.match(
          client.getInstructions() ?? "",
          /untrusted data, not instructions/i,
        );

        const listed = await client.listTools();
        assert.equal(listed.tools.length, 1);
        assert.equal(listed.tools[0]?.name, CAPTURE_SCREENSHOT_TOOL_NAME);

        const image = asCallToolResult(
          await client.callTool({
            name: CAPTURE_SCREENSHOT_TOOL_NAME,
            arguments: {
              url: targetUrl,
              format: "png",
              resultMode: "auto",
            },
          }),
        );
        assert.equal(image.isError, undefined);
        assert.deepEqual(
          image.content.map((content) => content.type),
          ["text", "image"],
        );
        assert.deepEqual(image.structuredContent, {
          screenshotUrl: "https://cdn.example.test/capture.png",
          screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
          cacheStatus: "HIT",
          format: "png",
          mimeType: "image/png",
          imageWidth: 640,
          imageHeight: 480,
          inlineImageIncluded: true,
        });

        const pdf = asCallToolResult(
          await client.callTool({
            name: CAPTURE_SCREENSHOT_TOOL_NAME,
            arguments: {
              url: targetUrl,
              format: "pdf",
              pdfPaperFormat: "a4",
            },
          }),
        );
        assert.equal(pdf.isError, undefined);
        assert.deepEqual(
          pdf.content.map((content) => content.type),
          ["text", "resource_link"],
        );
        assert.deepEqual(pdf.structuredContent, {
          screenshotUrl: "https://cdn.example.test/capture.pdf",
          screenshotUrlExpiresAt: "2026-07-25T12:00:00Z",
          cacheStatus: "MISS",
          format: "pdf",
          mimeType: "application/pdf",
          inlineImageIncluded: false,
        });

        return { image, pdf };
      },
    );

    assertProtocolOnly(session.stdout);
    assert.equal(session.stderr, "");
    assertNoSensitiveOutput(session.stdout, session.stderr, [
      accessKey,
      secretKey,
      targetUrl,
    ]);
  },
);

void test(
  "the stdio executable works without the optional secret key",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey();

    const session = await runStdioSession(
      {
        SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
        SCREENSHOTSCOUT_MCP_TEST_SIGNING_EXPECTATION: "absent",
      },
      async (client) =>
        asCallToolResult(
          await client.callTool({
            name: CAPTURE_SCREENSHOT_TOOL_NAME,
            arguments: {
              url: "https://target.example.test/unsigned",
              format: "png",
              resultMode: "url_only",
            },
          }),
        ),
    );

    assert.equal(session.result.isError, undefined);
    assertProtocolOnly(session.stdout);
    assert.equal(session.stderr, "");
    assertNoSensitiveOutput(session.stdout, session.stderr, [accessKey]);
  },
);

void test(
  "the stdio executable treats an empty optional secret key as absent",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey();

    const session = await runStdioSession(
      {
        SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
        SCREENSHOTSCOUT_SECRET_KEY: "",
        SCREENSHOTSCOUT_MCP_TEST_SIGNING_EXPECTATION: "absent",
      },
      async (client) =>
        asCallToolResult(
          await client.callTool({
            name: CAPTURE_SCREENSHOT_TOOL_NAME,
            arguments: {
              url: "https://target.example.test/empty-secret",
              format: "png",
              resultMode: "url_only",
            },
          }),
        ),
    );

    assert.equal(session.result.isError, undefined);
    assertProtocolOnly(session.stdout);
    assert.equal(session.stderr, "");
    assertNoSensitiveOutput(session.stdout, session.stderr, [accessKey]);
  },
);

void test(
  "startup validation rejects missing and malformed exact configuration without leaking it",
  { timeout: 15_000 },
  async (context) => {
    await context.test("a missing access key is rejected", async () => {
      const result = await runExecutable({});

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /SCREENSHOTSCOUT_ACCESS_KEY/);
    });

    await context.test(
      "a whitespace-only optional secret key is rejected",
      async () => {
        const accessKey = createAccessKey();
        const result = await runExecutable({
          SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
          SCREENSHOTSCOUT_SECRET_KEY: "   ",
        });

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /SCREENSHOTSCOUT_SECRET_KEY/);
        assertNoSensitiveOutput(result.stdout, result.stderr, [accessKey]);
      },
    );

    await context.test(
      "SDK credential validation runs before transport startup",
      async () => {
        const invalidAccessKey = `invalid key ${randomUUID()}`;
        const result = await runExecutable({
          SCREENSHOTSCOUT_ACCESS_KEY: invalidAccessKey,
        });

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Startup failed/);
        assertNoSensitiveOutput(result.stdout, result.stderr, [
          invalidAccessKey,
        ]);
      },
    );
  },
);

void test(
  "a broken stdout pipe shuts the executable down cleanly",
  { timeout: 15_000 },
  async () => {
    const accessKey = createAccessKey();
    const child = spawn(process.execPath, [executablePath], {
      cwd: repositoryRoot,
      env: createChildEnvironment({
        SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      child.stdout?.destroy();
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "broken-pipe-test",
              version: "0.0.0",
            },
          },
        })}\n`,
      );

      const exit = await waitForExit(child);
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
      assertNoSensitiveOutput("", stderr, [accessKey]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  },
);

void test("the build output retains the executable shebang", async () => {
  const executable = await readFile(executablePath, "utf8");
  const executableStats = await stat(executablePath);

  assert.equal(executable.startsWith("#!/usr/bin/env node\n"), true);
  assert.equal(executableStats.isFile(), true);
});

function createAccessKey(): string {
  return randomUUID().replaceAll("-", "");
}

function createSecretKey(): string {
  return `${createAccessKey()}${createAccessKey()}`;
}

async function runStdioSession<T>(
  environment: Record<string, string>,
  operation: (client: Client) => Promise<T>,
): Promise<StdioSessionResult<T>> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "screenshotscout-mcp-stdio-"),
  );
  const stdoutCapturePath = join(temporaryDirectory, "stdout.jsonl");
  let stderr = "";
  let connected = false;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(mockFetchPath).href, executablePath],
    cwd: repositoryRoot,
    env: createChildEnvironment({
      ...environment,
      SCREENSHOTSCOUT_MCP_TEST_STDOUT_CAPTURE_PATH: stdoutCapturePath,
    }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client({
    name: "screenshotscout-mcp-stdio-integration-test",
    version: "0.0.0",
  });

  try {
    await client.connect(transport);
    connected = true;
    const result = await operation(client);
    await client.close();
    connected = false;
    const stdout = await readFile(stdoutCapturePath, "utf8");
    return { result, stdout, stderr };
  } finally {
    if (connected) {
      await client.close().catch(() => undefined);
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runExecutable(environment: Record<string, string>): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [executablePath], {
    cwd: repositoryRoot,
    env: createChildEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exit = await waitForExit(child);
  return { ...exit, stdout, stderr };
}

function createChildEnvironment(
  overrides: Record<string, string>,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...overrides,
  };
}

function asCallToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): CallToolResult {
  assert.ok("content" in result);
  assert.ok(Array.isArray(result.content));
  return result as CallToolResult;
}

function assertProtocolOnly(stdout: string): void {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  assert.ok(lines.length > 0);

  for (const line of lines) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      assert.fail("The executable wrote non-JSON data to stdout.");
    }
    assert.equal(typeof message, "object");
    assert.equal(message === null, false);
    assert.equal(Reflect.get(message as object, "jsonrpc"), "2.0");
  }
}

function assertNoSensitiveOutput(
  stdout: string,
  stderr: string,
  sensitiveValues: readonly string[],
): void {
  for (const value of sensitiveValues) {
    assert.equal(
      stdout.includes(value),
      false,
      "stdout contained sensitive test configuration",
    );
    assert.equal(
      stderr.includes(value),
      false,
      "stderr contained sensitive test configuration",
    );
  }
}

function waitForExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
