import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const captureEndpoint = "https://api.screenshotscout.com/v1/capture";
const stdoutCapturePath =
  process.env.SCREENSHOTSCOUT_MCP_TEST_STDOUT_CAPTURE_PATH;

if (stdoutCapturePath !== undefined) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function captureStdout(...arguments_) {
    const chunk = arguments_[0];
    appendFileSync(
      stdoutCapturePath,
      typeof chunk === "string" ? chunk : Buffer.from(chunk),
    );
    return originalWrite(...arguments_);
  };
}

globalThis.fetch = async (input, init) => {
  const format = validateRequest(input, init);

  if (format === "pdf") {
    return new globalThis.Response(Buffer.from("%PDF-1.7\n", "ascii"), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "screenshot-scout-cache-status": "MISS",
        "screenshot-scout-screenshot-url":
          "https://cdn.example.test/capture.pdf",
        "screenshot-scout-screenshot-url-expires-at": "2026-07-25T12:00:00Z",
      },
    });
  }

  if (format !== "png") {
    throw new Error("The stdio test mock received an unexpected format.");
  }

  return new globalThis.Response(createPngHeader(640, 480), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "screenshot-scout-cache-status": "HIT",
      "screenshot-scout-screenshot-url": "https://cdn.example.test/capture.png",
      "screenshot-scout-screenshot-url-expires-at": "2026-07-25T12:00:00Z",
    },
  });
};

/** Checks the request the way the API would and returns its capture format. */
function validateRequest(input, init) {
  const accessKey = process.env.SCREENSHOTSCOUT_ACCESS_KEY;
  const secretKey = process.env.SCREENSHOTSCOUT_SECRET_KEY;
  if (accessKey === undefined) {
    throw new Error("The stdio test mock could not verify authentication.");
  }

  const headers = new globalThis.Headers(init?.headers);
  if (headers.get("authorization") !== `Bearer ${accessKey}`) {
    throw new Error("The stdio test mock rejected authentication.");
  }

  const signingExpectation =
    process.env.SCREENSHOTSCOUT_MCP_TEST_SIGNING_EXPECTATION;
  if (signingExpectation === "required") {
    // Only GET requests can be signed.
    return validateSignedGetRequest(input, init, accessKey, secretKey);
  }
  if (signingExpectation === "absent") {
    return validateUnsignedPostRequest(input, init, headers);
  }
  throw new Error("The stdio test mock has no signing expectation.");
}

function validateSignedGetRequest(input, init, accessKey, secretKey) {
  const url = new URL(String(input));
  if (
    `${url.origin}${url.pathname}` !== captureEndpoint ||
    (init?.method ?? "GET") !== "GET" ||
    (init?.body !== undefined && init?.body !== null)
  ) {
    throw new Error("The stdio test mock received an unexpected request.");
  }

  const query = url.searchParams;
  if (query.get("response_type") !== "binary") {
    throw new Error("The stdio test mock rejected the request query.");
  }
  if (
    secretKey === undefined ||
    query.get("signature") !==
      createExpectedSignature(query, accessKey, secretKey)
  ) {
    throw new Error("The stdio test mock rejected request signing.");
  }

  return query.get("format");
}

function validateUnsignedPostRequest(input, init, headers) {
  if (String(input) !== captureEndpoint || init?.method !== "POST") {
    throw new Error("The stdio test mock received an unexpected request.");
  }
  if (headers.get("content-type") !== "application/json") {
    throw new Error("The stdio test mock rejected the request content type.");
  }
  if (typeof init.body !== "string") {
    throw new Error("The stdio test mock expected a JSON request body.");
  }

  const body = JSON.parse(init.body);
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    body.response_type !== "binary"
  ) {
    throw new Error("The stdio test mock rejected the request body.");
  }
  if (Object.hasOwn(body, "signature")) {
    throw new Error("The stdio test mock received unexpected request signing.");
  }

  return body.format;
}

// The API's signed text: the decoded query parameters except signature, plus
// the access key sent in the header, sorted by name (repeated names keep their
// order) and written with RFC 3986 percent-encoding.
function createExpectedSignature(query, accessKey, secretKey) {
  const entries = [];
  let index = 0;

  for (const [name, value] of query) {
    if (name === "signature") continue;
    entries.push({ name, value, index });
    index += 1;
  }
  entries.push({ name: "access_key", value: accessKey, index });
  entries.sort((left, right) =>
    left.name === right.name
      ? left.index - right.index
      : left.name < right.name
        ? -1
        : 1,
  );

  const encode = (text) =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const signedText = entries
    .map((entry) => `${encode(entry.name)}=${encode(entry.value)}`)
    .join("&");
  return createHmac("sha256", secretKey)
    .update(signedText, "utf8")
    .digest("hex");
}

function createPngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
