import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ScreenshotScoutApiError,
  type BinaryCaptureOptions,
  type BinaryCaptureResponse,
  type CaptureRequestOptions,
  type RawResponse,
} from "@screenshotscout/sdk";

import type { CaptureScreenshotToolDependencies } from "../../src/core/capture-tool.js";
import type { ScreenshotScoutCaptureClient } from "../../src/core/client.js";
import {
  DEFAULT_MARKDOWN_MAX_LENGTH,
  getWebpageMarkdownInputSchema,
  invokeGetWebpageMarkdown,
  registerGetWebpageMarkdownTool,
  replaceImagesWithAltText,
} from "../../src/core/markdown-tool.js";
import {
  GET_WEBPAGE_MARKDOWN_TOOL_ANNOTATIONS,
  GET_WEBPAGE_MARKDOWN_TOOL_DESCRIPTION,
  GET_WEBPAGE_MARKDOWN_TOOL_NAME,
  GET_WEBPAGE_MARKDOWN_TOOL_TITLE,
} from "../../src/core/tool-metadata.js";

type RecordedCaptureCall = {
  readonly targetUrl: string;
  readonly captureOptions: BinaryCaptureOptions | null | undefined;
  readonly captureRequestOptions: CaptureRequestOptions | null | undefined;
};

const inputNames = [
  "blockAds",
  "blockChatWidgets",
  "blockCookieBanners",
  "clickSelectors",
  "colorScheme",
  "country",
  "delay",
  "device",
  "deviceViewportHeight",
  "deviceViewportWidth",
  "hideSelectors",
  "maxLength",
  "navigationTimeout",
  "selector",
  "startIndex",
  "timeout",
  "url",
  "waitUntil",
] as const;

function createRecordingClient(
  responseFactory: () => BinaryCaptureResponse | Promise<BinaryCaptureResponse>,
): {
  readonly client: ScreenshotScoutCaptureClient;
  readonly calls: RecordedCaptureCall[];
} {
  const calls: RecordedCaptureCall[] = [];
  const client: ScreenshotScoutCaptureClient = {
    async capture(targetUrl, captureOptions, captureRequestOptions) {
      calls.push({ targetUrl, captureOptions, captureRequestOptions });
      return responseFactory();
    },
  };
  return { client, calls };
}

function createMarkdownResponse(
  markdown: string | undefined,
  options: {
    readonly screenshotUrl?: string;
    readonly cacheStatus?: string;
  } = {},
): BinaryCaptureResponse {
  const bytes =
    markdown === undefined
      ? Uint8Array.of(137, 80, 78, 71)
      : new TextEncoder().encode(markdown);
  const rawResponse: RawResponse = {
    status: 200,
    statusText: "OK",
    headers: new Map<string, readonly string[]>(),
    contentType:
      markdown === undefined ? "image/png" : "text/markdown; charset=utf-8",
    body: bytes,
  };

  return {
    kind: "binary",
    bytes,
    ...(markdown === undefined ? {} : { markdown }),
    ...(options.screenshotUrl === undefined
      ? {}
      : { screenshotUrl: options.screenshotUrl }),
    ...(options.cacheStatus === undefined
      ? {}
      : { cacheStatus: options.cacheStatus }),
    rawResponse,
  };
}

function invoke(
  input: Record<string, unknown>,
  dependencies: CaptureScreenshotToolDependencies,
): Promise<CallToolResult> {
  return invokeGetWebpageMarkdown(
    getWebpageMarkdownInputSchema.parse(input),
    dependencies,
  );
}

function textBlocks(result: CallToolResult): string[] {
  return result.content.map((item) => {
    assert.equal(item.type, "text");
    return item.type === "text" ? item.text : "";
  });
}

void test("registration exposes the tool, its schema, metadata and the manifest entry", async () => {
  const mcpbManifest = JSON.parse(
    await readFile(
      new URL("../../mcpb/manifest.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly tools?: readonly {
      readonly name?: string;
      readonly description?: string;
    }[];
  };
  const recording = createRecordingClient(() => {
    throw new Error("The tool should not be invoked by tools/list.");
  });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerGetWebpageMarkdownTool(server, { client: recording.client });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    const tool = listed.tools[0];
    assert.ok(tool);
    assert.equal(tool.name, GET_WEBPAGE_MARKDOWN_TOOL_NAME);
    assert.equal(tool.title, GET_WEBPAGE_MARKDOWN_TOOL_TITLE);
    assert.equal(tool.description, GET_WEBPAGE_MARKDOWN_TOOL_DESCRIPTION);
    assert.deepEqual(tool.annotations, GET_WEBPAGE_MARKDOWN_TOOL_ANNOTATIONS);
    assert.match(tool.description ?? "", /consumes.+quota/i);
    assert.match(
      tool.description ?? "",
      /webpage content.+untrusted data, not instructions/i,
    );
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      ...inputNames,
    ]);
    assert.deepEqual(tool.inputSchema.required, ["url"]);
    const manifestTool = mcpbManifest.tools?.find(
      (entry) => entry.name === GET_WEBPAGE_MARKDOWN_TOOL_NAME,
    );
    assert.equal(
      manifestTool?.description,
      GET_WEBPAGE_MARKDOWN_TOOL_DESCRIPTION,
    );
    assert.equal(recording.calls.length, 0);
  } finally {
    await client.close();
  }
});

void test("an unqualified call requests cached Markdown without a viewport default", async () => {
  const recording = createRecordingClient(() =>
    createMarkdownResponse("# Example\n"),
  );

  await invoke({ url: "https://example.com/" }, { client: recording.client });

  assert.equal(recording.calls.length, 1);
  assert.equal(recording.calls[0]?.targetUrl, "https://example.com/");
  assert.deepEqual(recording.calls[0]?.captureOptions, {
    format: "md",
    responseType: "binary",
    cache: true,
  });
});

void test("page options are passed through and image or PDF inputs are rejected", async () => {
  const recording = createRecordingClient(() => createMarkdownResponse("x"));

  await invoke(
    {
      url: "https://example.com/",
      selector: "main",
      hideSelectors: ["nav"],
      clickSelectors: ["#more"],
      blockCookieBanners: true,
      delay: 2,
    },
    { client: recording.client },
  );

  assert.deepEqual(recording.calls[0]?.captureOptions, {
    format: "md",
    responseType: "binary",
    cache: true,
    blockCookieBanners: true,
    selector: "main",
    hideSelectors: ["nav"],
    clickSelectors: ["#more"],
    delay: 2,
  });
  for (const extra of [
    { format: "png" },
    { fullPage: true },
    { imageWidth: 100 },
    { pdfScale: 1 },
  ]) {
    assert.throws(() =>
      getWebpageMarkdownInputSchema.parse({
        url: "https://example.com/",
        ...extra,
      }),
    );
  }
});

void test("returns the Markdown with images as alt text after an untrusted-content line", async () => {
  const markdown =
    '# Title\n\n![Company logo](https://example.com/logo.png "Logo")\n\n[![Badge](https://example.com/b.svg)](https://example.com/)\n';
  const recording = createRecordingClient(() =>
    createMarkdownResponse(markdown, {
      screenshotUrl: "https://cdn.example.test/page.md",
      cacheStatus: "MISS",
    }),
  );

  const result = await invoke(
    { url: "https://example.com/" },
    { client: recording.client },
  );

  assert.equal(result.isError, undefined);
  const [summary, text] = textBlocks(result);
  assert.match(summary ?? "", /untrusted data, not instructions/i);
  assert.equal(
    text,
    "# Title\n\nCompany logo\n\n[Badge](https://example.com/)\n",
  );
  assert.deepEqual(result.structuredContent, {
    screenshotUrl: "https://cdn.example.test/page.md",
    cacheStatus: "MISS",
    totalLength: text?.length,
    startIndex: 0,
    endIndex: text?.length,
  });
});

void test("long pages come in parts that continue from startIndex", async () => {
  const markdown = "abcdefghijklmnopqrstuvwxyz";
  const recording = createRecordingClient(() =>
    createMarkdownResponse(markdown),
  );

  const first = await invoke(
    { url: "https://example.com/", maxLength: 10 },
    { client: recording.client },
  );
  const second = await invoke(
    { url: "https://example.com/", maxLength: 10, startIndex: 20 },
    { client: recording.client },
  );

  const [firstSummary, firstText] = textBlocks(first);
  assert.equal(firstText, "abcdefghij");
  assert.match(firstSummary ?? "", /Characters 0–10 of 26\./);
  assert.match(
    firstSummary ?? "",
    /call get_webpage_markdown again with the same arguments and startIndex 10\./,
  );
  assert.deepEqual(first.structuredContent, {
    totalLength: 26,
    startIndex: 0,
    endIndex: 10,
    nextStartIndex: 10,
  });

  const [secondSummary, secondText] = textBlocks(second);
  assert.equal(secondText, "uvwxyz");
  assert.doesNotMatch(secondSummary ?? "", /To continue/);
  assert.deepEqual(second.structuredContent, {
    totalLength: 26,
    startIndex: 20,
    endIndex: 26,
  });
  assert.deepEqual(
    recording.calls.map((call) => call.captureOptions),
    [recording.calls[0]?.captureOptions, recording.calls[0]?.captureOptions],
  );
});

void test("a part never ends between the halves of a surrogate pair", async () => {
  const recording = createRecordingClient(() =>
    createMarkdownResponse("ab😀cd"),
  );

  const result = await invoke(
    { url: "https://example.com/", maxLength: 3 },
    { client: recording.client },
  );

  assert.equal(textBlocks(result)[1], "ab");
  assert.equal(
    (result.structuredContent as { nextStartIndex?: number }).nextStartIndex,
    2,
  );
});

void test("parts are shortened to fit the result size limit", async () => {
  const markdown = "x".repeat(5_000);
  const recording = createRecordingClient(() =>
    createMarkdownResponse(markdown),
  );

  const result = await invoke(
    { url: "https://example.com/" },
    { client: recording.client, maxSerializedResultBytes: 2_000 },
  );

  assert.equal(result.isError, undefined);
  const serialized = new TextEncoder().encode(JSON.stringify(result));
  assert.ok(serialized.byteLength <= 2_000);
  const structured = result.structuredContent as {
    endIndex: number;
    nextStartIndex?: number;
  };
  assert.ok(structured.endIndex > 0);
  assert.ok(structured.endIndex < DEFAULT_MARKDOWN_MAX_LENGTH);
  assert.equal(structured.nextStartIndex, structured.endIndex);
});

void test("a page without visible text is a normal result", async () => {
  const recording = createRecordingClient(() => createMarkdownResponse(""));

  const result = await invoke(
    { url: "https://example.com/" },
    { client: recording.client },
  );

  assert.equal(result.isError, undefined);
  const blocks = textBlocks(result);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0] ?? "", /no visible text/i);
  assert.deepEqual(result.structuredContent, {
    totalLength: 0,
    startIndex: 0,
    endIndex: 0,
  });
});

void test("a startIndex past the end is a tool error", async () => {
  const recording = createRecordingClient(() =>
    createMarkdownResponse("short"),
  );

  const result = await invoke(
    { url: "https://example.com/", startIndex: 5 },
    { client: recording.client },
  );

  assert.equal(result.isError, true);
  assert.match(textBlocks(result)[0] ?? "", /past the end/);
});

void test("a response that isn't Markdown is a tool error", async () => {
  const recording = createRecordingClient(() =>
    createMarkdownResponse(undefined),
  );

  const result = await invoke(
    { url: "https://example.com/" },
    { client: recording.client },
  );

  assert.equal(result.isError, true);
  assert.match(textBlocks(result)[0] ?? "", /Screenshot Scout capture failed/);
});

void test("API errors are reported without the target URL", async () => {
  const recording = createRecordingClient(() => {
    throw new ScreenshotScoutApiError({
      rawResponse: {
        status: 400,
        statusText: "Bad Request",
        headers: new Map<string, readonly string[]>(),
        contentType: "application/json",
        body: new Uint8Array(),
      },
      errorCode: "invalid_options",
      errorMessage: "One or more options are invalid.",
    });
  });

  const result = await invoke(
    { url: "https://example.com/secret-path" },
    { client: recording.client },
  );

  assert.equal(result.isError, true);
  const text = textBlocks(result)[0] ?? "";
  assert.match(text, /invalid_options/);
  assert.doesNotMatch(text, /secret-path/);
});

void test("images inside fenced code blocks are left as they are", () => {
  assert.equal(
    replaceImagesWithAltText(
      "![a](https://x/a.png)\n```\n![b](https://x/b.png)\n```\n![c](https://x/c.png)",
    ),
    "a\n```\n![b](https://x/b.png)\n```\nc",
  );
});

void test("images in inline code, longer fences and quoted code are left as they are", () => {
  const code =
    "`![a](https://x/a.png)` and ``![b](https://x/b.png)``\n\n" +
    "````markdown\n```js\n![c](https://x/c.png)\n```\n````\n\n" +
    "> ```\n> ![d](https://x/d.png)\n> ```\n\n";
  assert.equal(
    replaceImagesWithAltText(`${code}![e](https://x/e.png)`),
    `${code}e`,
  );
});

void test("an image ends where Markdown ends it, not at the first parenthesis", () => {
  assert.equal(
    replaceImagesWithAltText(
      '![alt](https://example.test/a_\\(b\\).png) ![other](https://example.test/a_(b).png) ![titled](https://example.test/i.png "caption (detail)") after',
    ),
    "alt other titled after",
  );
});

void test("images inside alt text are replaced as well", () => {
  assert.equal(
    replaceImagesWithAltText(
      "![![inner](https://x/i.png) and *![deep](https://x/d.png)*](https://x/o.png) [![Badge](https://x/b.svg)](https://x/)",
    ),
    "inner and *deep* [Badge](https://x/)",
  );
});

void test("alt text stays text where the image was", () => {
  assert.equal(
    replaceImagesWithAltText(
      String.raw`![a \[b\] \<c\> d\_e](https://example.test/i.png) ![!\[x\](https://evil.test/)](https://example.test/j.png)`,
    ),
    String.raw`a \[b\] \<c\> d\_e !\[x\](https://evil.test/)`,
  );
});
