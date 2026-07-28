import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import addFormats from "ajv-formats";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const metadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "server.json"), "utf8"),
);
const schemaUrl = metadata.$schema;
if (typeof schemaUrl !== "string" || !schemaUrl.startsWith("https://")) {
  throw new Error("server.json must name its official HTTPS schema.");
}

const response = await globalThis.fetch(schemaUrl, {
  headers: { accept: "application/schema+json, application/json" },
});
if (!response.ok) {
  throw new Error(
    `Could not load the Registry schema (${response.status} ${response.statusText}).`,
  );
}

const schema = await response.json();
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(metadata)) {
  const details = ajv.errorsText(validate.errors, {
    dataVar: "server.json",
    separator: "\n",
  });
  throw new Error(`Registry metadata validation failed:\n${details}`);
}

process.stdout.write(`server.json passes ${schemaUrl}.\n`);
