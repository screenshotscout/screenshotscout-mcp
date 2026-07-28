export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_URL = "[REDACTED_URL]";

export type RedactionOptions = {
  readonly sensitiveValues?: readonly (string | null | undefined)[];
  readonly redactUrls?: boolean;
  readonly maxLength?: number;
};

export type RedactedDiagnostic = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

const sensitiveFieldNames = new Set([
  "accesskey",
  "authorization",
  "body",
  "bytes",
  "cookie",
  "cookies",
  "headers",
  "secretkey",
  "signature",
  "screenshoturl",
  "targeturl",
]);

export function redactText(
  input: string,
  options: RedactionOptions = {},
): string {
  let output = input
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED_VALUE}`)
    .replace(
      /([?&](?:access[_-]?key|secret[_-]?key|signature)=)[^&#\s]*/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      /((?:SCREENSHOTSCOUT_(?:ACCESS|SECRET)_KEY|access[_-]?key|secret[_-]?key|signature)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      `$1${REDACTED_VALUE}`,
    );

  const sensitiveValues = [...(options.sensitiveValues ?? [])]
    .filter((value): value is string => value !== null && value !== undefined)
    .filter((value) => value.length > 0)
    .flatMap((value) => {
      const encoded = safelyEncodeURIComponent(value);
      return encoded === undefined || encoded === value
        ? [value]
        : [value, encoded];
    })
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(sensitiveValues)) {
    output = output.split(value).join(REDACTED_VALUE);
  }

  if (options.redactUrls === true) {
    output = output.replace(/https?:\/\/[^\s<>"')\]}]+/gi, REDACTED_URL);
  }

  output = [...output]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127
        ? " "
        : character;
    })
    .join("")
    .trim();

  const maxLength = options.maxLength;
  if (
    maxLength !== undefined &&
    Number.isSafeInteger(maxLength) &&
    maxLength > 0 &&
    output.length > maxLength
  ) {
    return `${output.slice(0, Math.max(0, maxLength - 1))}…`;
  }
  return output;
}

export function redactUnknown(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  try {
    return redactUnknownInternal(value, options, new WeakSet<object>(), 0);
  } catch {
    return "[REDACTED_OBJECT]";
  }
}

export function toRedactedDiagnostic(
  error: unknown,
  options: RedactionOptions = {},
): RedactedDiagnostic {
  try {
    return toRedactedDiagnosticInternal(error, options);
  } catch {
    return {
      name: "UnknownError",
      message: "An unexpected value could not be inspected safely.",
    };
  }
}

function toRedactedDiagnosticInternal(
  error: unknown,
  options: RedactionOptions,
): RedactedDiagnostic {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: redactText("An unexpected non-Error value was thrown.", {
        ...options,
        maxLength: 2_000,
      }),
    };
  }

  const name = redactText(error.name || "Error", {
    ...options,
    maxLength: 200,
  });
  const message = redactText(
    error.message || "No error message was provided.",
    {
      ...options,
      redactUrls: true,
      maxLength: 2_000,
    },
  );
  const stack =
    error.stack === undefined
      ? undefined
      : redactText(error.stack, {
          ...options,
          redactUrls: true,
          maxLength: 8_000,
        });

  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
  };
}

function redactUnknownInternal(
  value: unknown,
  options: RedactionOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function") return "[REDACTED_FUNCTION]";
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "[REDACTED_BINARY]";
  }
  if (value instanceof Error) return toRedactedDiagnostic(value, options);
  if (depth >= 5) return "[REDACTED_DEPTH_LIMIT]";
  if (typeof value !== "object") return "[REDACTED_UNKNOWN]";
  if (seen.has(value)) return "[REDACTED_CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => redactUnknownInternal(item, options, seen, depth + 1));
  }

  let prototype: unknown;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "[REDACTED_OBJECT]";
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return "[REDACTED_OBJECT]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors).slice(0, 50)) {
    const item: unknown =
      "value" in descriptor
        ? (descriptor.value as unknown)
        : "[REDACTED_ACCESSOR]";
    output[key] = isSensitiveFieldName(key)
      ? REDACTED_VALUE
      : redactUnknownInternal(item, options, seen, depth + 1);
  }
  return output;
}

function isSensitiveFieldName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    sensitiveFieldNames.has(normalized) ||
    normalized.includes("accesskey") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("secretkey") ||
    normalized.includes("signature") ||
    normalized.includes("screenshoturl") ||
    normalized.includes("targeturl") ||
    normalized.endsWith("body") ||
    normalized.endsWith("bytes") ||
    normalized.endsWith("headers")
  );
}

function safelyEncodeURIComponent(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}
