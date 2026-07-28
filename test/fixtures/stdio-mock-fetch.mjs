import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { URLSearchParams } from "node:url";

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
  const body = validateRequest(input, init);
  const format = body.format;

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

function validateRequest(input, init) {
  if (String(input) !== captureEndpoint || init?.method !== "POST") {
    throw new Error("The stdio test mock received an unexpected request.");
  }

  const accessKey = process.env.SCREENSHOTSCOUT_ACCESS_KEY;
  const secretKey = process.env.SCREENSHOTSCOUT_SECRET_KEY;
  if (accessKey === undefined) {
    throw new Error("The stdio test mock could not verify authentication.");
  }

  const headers = new globalThis.Headers(init.headers);
  if (headers.get("authorization") !== `Bearer ${accessKey}`) {
    throw new Error("The stdio test mock rejected authentication.");
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

  const signingExpectation =
    process.env.SCREENSHOTSCOUT_MCP_TEST_SIGNING_EXPECTATION;
  if (signingExpectation === "required") {
    if (
      secretKey === undefined ||
      body.signature !== createExpectedSignature(body, accessKey, secretKey)
    ) {
      throw new Error("The stdio test mock rejected request signing.");
    }
  } else if (
    signingExpectation === "absent" &&
    Object.hasOwn(body, "signature")
  ) {
    throw new Error("The stdio test mock received unexpected request signing.");
  } else if (
    signingExpectation !== "required" &&
    signingExpectation !== "absent"
  ) {
    throw new Error("The stdio test mock has no signing expectation.");
  }

  return body;
}

function createExpectedSignature(body, accessKey, secretKey) {
  const entries = [];
  let index = 0;

  for (const [name, value] of Object.entries(body)) {
    if (name === "signature") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push({ name, value: String(item), index });
        index += 1;
      }
    } else {
      entries.push({ name, value: String(value), index });
      index += 1;
    }
  }
  entries.push({ name: "access_key", value: accessKey, index });
  entries.sort((left, right) =>
    left.name === right.name
      ? left.index - right.index
      : left.name < right.name
        ? -1
        : 1,
  );

  const canonical = new URLSearchParams();
  for (const entry of entries) {
    canonical.append(entry.name, entry.value);
  }
  return createHmac("sha256", secretKey)
    .update(canonical.toString(), "utf8")
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
