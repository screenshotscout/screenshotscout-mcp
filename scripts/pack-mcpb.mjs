import { spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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

const bundleRoot = path.join(repositoryRoot, "mcpb");
const artifactPath = path.join(repositoryRoot, artifactName);
if (path.dirname(artifactPath) !== repositoryRoot) {
  throw new Error(`Unsafe MCPB output path: ${artifactPath}`);
}

await access(path.join(bundleRoot, "server", "dist", "stdio.js"));
await rm(artifactPath, { force: true });

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("Run MCPB packing through `npm run mcpb:pack`.");
}

const pack = spawnSync(
  process.execPath,
  [npmCli, "exec", "--", "mcpb", "pack", bundleRoot, artifactPath],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);
if (pack.status !== 0) {
  throw new Error(`MCPB packing failed (${pack.status}).`);
}
