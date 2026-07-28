import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const accessKey = "screenshotscout-mcpb-smoke-access-key";
let stderr = "";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repositoryRoot, "mcpb/server/dist/stdio.js")],
  cwd: path.join(repositoryRoot, "mcpb/server"),
  env: {
    ...getDefaultEnvironment(),
    SCREENSHOTSCOUT_ACCESS_KEY: accessKey,
    SCREENSHOTSCOUT_SECRET_KEY: "",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({
  name: "screenshotscout-mcpb-smoke-client",
  version: "0.0.0",
});

try {
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), {
    name: "screenshotscout-mcp",
    version: packageJson.version,
  });
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["capture_screenshot"],
  );
} finally {
  await client.close().catch(() => undefined);
}

assert.equal(stderr.includes(accessKey), false);
process.stdout.write("Bundled MCPB stdio runtime starts and lists one tool.\n");
