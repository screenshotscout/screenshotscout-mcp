import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bundleRoot = path.join(repositoryRoot, "mcpb");
const serverRoot = path.join(bundleRoot, "server");
if (
  path.dirname(serverRoot) !== bundleRoot ||
  path.basename(serverRoot) !== "server"
) {
  throw new Error(`Unsafe MCPB staging path: ${serverRoot}`);
}

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const artifactName = `screenshotscout-mcp-${packageJson.version}.mcpb`;
if (
  !/^screenshotscout-mcp-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.mcpb$/u.test(
    artifactName,
  )
) {
  throw new Error(
    `Package version cannot form a safe MCPB filename: ${packageJson.version}`,
  );
}
const artifactPath = path.join(repositoryRoot, artifactName);
if (path.dirname(artifactPath) !== repositoryRoot) {
  throw new Error(`Unsafe MCPB artifact path: ${artifactPath}`);
}

await rm(serverRoot, { force: true, recursive: true });
await mkdir(serverRoot, { recursive: true });
await writeFile(path.join(serverRoot, ".gitkeep"), "\n");
await rm(artifactPath, { force: true });

process.stdout.write("Removed generated MCPB staging files and artifact.\n");
