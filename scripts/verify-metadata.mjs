import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));

const packageJson = await readJson("package.json");
const manifest = await readJson("mcpb/manifest.json");
const server = await readJson("server.json");
const sourceServer = await readFile(
  path.join(repositoryRoot, "src/server.ts"),
  "utf8",
);

assert(
  packageJson.private === undefined,
  "The npm package must be publishable.",
);
assertEqual(
  packageJson.bin?.["screenshotscout-mcp"],
  "./dist/stdio.js",
  "npm executable",
);
assertEqual(
  packageJson.repository?.url,
  "git+https://github.com/screenshotscout/screenshotscout-mcp.git",
  "npm repository URL",
);
assertEqual(
  packageJson.homepage,
  "https://screenshotscout.com/mcp",
  "npm homepage",
);
assertEqual(
  packageJson.bugs?.url,
  "https://github.com/screenshotscout/screenshotscout-mcp/issues",
  "npm bugs URL",
);
assertEqual(packageJson.mcpName, server.name, "Registry server name");
assertEqual(packageJson.version, manifest.version, "MCPB version");
assertEqual(packageJson.version, server.version, "Registry version");
assertEqual(
  packageJson.version,
  server.packages?.[0]?.version,
  "Registry npm package version",
);

const sourceVersion = /SCREENSHOTSCOUT_MCP_SERVER_VERSION = "([^"]+)"/u.exec(
  sourceServer,
)?.[1];
assertEqual(packageJson.version, sourceVersion, "runtime server version");

assertEqual(manifest.manifest_version, "0.4", "MCPB manifest version");
assertEqual(
  manifest.server?.entry_point,
  "server/dist/stdio.js",
  "MCPB entry point",
);
assertEqual(
  manifest.user_config?.SCREENSHOTSCOUT_SECRET_KEY?.required,
  false,
  "optional MCPB secret requirement",
);
assertEqual(
  manifest.user_config?.SCREENSHOTSCOUT_SECRET_KEY?.default,
  "",
  "optional MCPB secret default",
);
assert(
  manifest.compatibility?.platforms?.length > 0,
  "MCPB must declare at least one tested platform.",
);
for (const key of [
  "SCREENSHOTSCOUT_ACCESS_KEY",
  "SCREENSHOTSCOUT_SECRET_KEY",
]) {
  assert(
    manifest.user_config?.[key]?.sensitive === true,
    `${key} must be sensitive MCPB user configuration.`,
  );
}
assert(
  manifest.user_config.SCREENSHOTSCOUT_ACCESS_KEY.required === true,
  "MCPB access key must be required.",
);
assert(
  manifest.user_config.SCREENSHOTSCOUT_SECRET_KEY.required === false,
  "MCPB secret key must be optional.",
);
assert(
  manifest.privacy_policies?.includes(
    "https://screenshotscout.com/privacy-policy",
  ),
  "MCPB privacy policy is missing.",
);

const remoteJson = JSON.stringify(server.remotes ?? []);
assert(
  remoteJson.includes('"name":"Authorization"'),
  "Registry remote must declare its Authorization header.",
);
assert(
  remoteJson.includes('"value":"Bearer {access_key}"'),
  "Registry remote must declare Bearer access-key substitution.",
);
assert(
  !/secret.?key/iu.test(remoteJson),
  "Registry remote must not declare a secret-key path.",
);

await verifyPng("assets/icon-400.png", 400, 400, true);
await verifyPng("mcpb/icon.png", 512, 512, true);

const topics = (
  await readFile(
    path.join(repositoryRoot, "metadata/github-topics.txt"),
    "utf8",
  )
)
  .split(/\r?\n/u)
  .filter((topic) => topic.length > 0);
assert(topics.length > 0, "GitHub topic list is empty.");
assertEqual(
  topics.join("\n"),
  [...new Set(topics)].sort().join("\n"),
  "sorted unique GitHub topics",
);

process.stdout.write("Repository metadata is consistent.\n");

async function verifyPng(
  relativePath,
  expectedWidth,
  expectedHeight,
  requireAlpha,
) {
  const bytes = await readFile(path.join(repositoryRoot, relativePath));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(
    bytes.subarray(0, signature.length).equals(signature),
    `${relativePath} is not a PNG.`,
  );
  assertEqual(bytes.readUInt32BE(16), expectedWidth, `${relativePath} width`);
  assertEqual(bytes.readUInt32BE(20), expectedHeight, `${relativePath} height`);
  if (requireAlpha) {
    assert(
      bytes[25] === 4 || bytes[25] === 6,
      `${relativePath} must use a PNG color type with alpha.`,
    );
  }
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
