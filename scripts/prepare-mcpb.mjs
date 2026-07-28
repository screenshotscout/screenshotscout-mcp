import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bundleRoot = path.join(repositoryRoot, "mcpb");
const serverRoot = path.join(bundleRoot, "server");
const compiledRoot = path.join(repositoryRoot, "dist");
const stagedCompiledRoot = path.join(serverRoot, "dist");
const runtimeFileAllowlist = new Set([
  "core/capture-input.js",
  "core/capture-tool.js",
  "core/client.js",
  "core/errors.js",
  "core/image.js",
  "core/redaction.js",
  "core/result.js",
  "core/tool-metadata.js",
  "server.js",
  "stdio.js",
]);

assertChildPath(bundleRoot, serverRoot);

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(bundleRoot, "manifest.json"), "utf8"),
);

if (packageJson.version !== manifest.version) {
  throw new Error(
    `MCPB version ${manifest.version} does not match package version ${packageJson.version}.`,
  );
}

await rm(serverRoot, { force: true, recursive: true });
await mkdir(serverRoot, { recursive: true });
await cp(compiledRoot, stagedCompiledRoot, { recursive: true });
await removeDevelopmentBuildFiles(stagedCompiledRoot);

await cp(
  path.join(repositoryRoot, "package.json"),
  path.join(serverRoot, "package.json"),
);
await cp(
  path.join(repositoryRoot, "package-lock.json"),
  path.join(serverRoot, "package-lock.json"),
);

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("Run MCPB preparation through `npm run mcpb:prepare`.");
}

const install = spawnSync(
  process.execPath,
  [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  {
    cwd: serverRoot,
    stdio: "inherit",
  },
);
if (install.status !== 0) {
  throw new Error(
    `Production dependency installation failed (${install.status}).`,
  );
}
await pruneProductionDependencies(path.join(serverRoot, "node_modules"));

const runtimePackage = {
  name: "screenshotscout-mcp-runtime",
  version: packageJson.version,
  private: true,
  type: "module",
  engines: packageJson.engines,
  dependencies: packageJson.dependencies,
};
await writeFile(
  path.join(serverRoot, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
);
await rm(path.join(serverRoot, "package-lock.json"), { force: true });
await writeFile(path.join(serverRoot, ".gitkeep"), "\n");

process.stdout.write(
  `Prepared MCPB runtime at ${path.relative(repositoryRoot, serverRoot)}.\n`,
);

async function removeDevelopmentBuildFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    assertChildPath(serverRoot, entryPath);

    if (entry.isDirectory()) {
      await removeDevelopmentBuildFiles(entryPath);
      if ((await readdir(entryPath)).length === 0) {
        await rm(entryPath, { recursive: true });
      }
      continue;
    }

    const relativePath = path
      .relative(stagedCompiledRoot, entryPath)
      .split(path.sep)
      .join("/");
    if (!runtimeFileAllowlist.has(relativePath)) {
      await rm(entryPath);
      continue;
    }

    const source = await readFile(entryPath, "utf8");
    const withoutSourceMapReference = source.replace(
      /\n?\/\/# sourceMappingURL=.*(?:\r?\n)?$/u,
      "\n",
    );
    await writeFile(entryPath, withoutSourceMapReference);
  }
}

async function pruneProductionDependencies(directory, isRoot = true) {
  const nonRuntimeDirectoryNames = new Set([
    ".bin",
    ".github",
    "__tests__",
    "benchmark",
    "benchmarks",
    "test",
    "tests",
  ]);

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    assertChildPath(serverRoot, entryPath);

    if (entry.isDirectory()) {
      if (nonRuntimeDirectoryNames.has(entry.name.toLowerCase())) {
        await rm(entryPath, { force: true, recursive: true });
      } else {
        await pruneProductionDependencies(entryPath, false);
      }
      continue;
    }

    if (
      entry.name === ".package-lock.json" ||
      entry.name.endsWith(".map") ||
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".tsx") ||
      entry.name.endsWith(".cts") ||
      entry.name.endsWith(".mts") ||
      entry.name.endsWith(".tsbuildinfo")
    ) {
      await rm(entryPath);
    }
  }

  if (!isRoot && (await readdir(directory)).length === 0) {
    await rm(directory, { recursive: true });
  }
}

function assertChildPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  if (
    relative.length === 0 ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe MCPB staging path: ${candidate}`);
  }
}
