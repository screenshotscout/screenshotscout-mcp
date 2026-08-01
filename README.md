# Screenshot Scout MCP Server

Use [Screenshot Scout](https://screenshotscout.com/) from an MCP client to capture
HTTP or HTTPS webpages as images or PDFs.

This server exposes one tool, `capture_screenshot`. It supports full-page and
element captures, device and viewport controls, location selection, page
interaction and blocking options, image sizing and quality, PDF layout, caching,
temporary result URLs and eligible MCP image content.

## What you need

- A [Screenshot Scout account](https://screenshotscout.com/auth/signup) and an
  access key from the [API keys page](https://screenshotscout.com/app/api-keys).
- Node.js 22 or newer for npm/stdio installation. Claude Desktop's MCPB runtime
  is bundled by Claude.
- The optional secret key only when your selected API key requires signed
  Screenshot Scout requests.

Every capture uses your Screenshot Scout account and is subject to its plan,
quota, and rate limits.

## Local stdio with npm

Start with this local stdio configuration:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "command": "npx",
      "args": ["-y", "@screenshotscout/mcp"],
      "env": {
        "SCREENSHOTSCOUT_ACCESS_KEY": "YOUR_ACCESS_KEY"
      }
    }
  }
}
```

If the access key requires request signing, add the secret locally:

```json
"SCREENSHOTSCOUT_SECRET_KEY": "YOUR_SECRET_KEY"
```

Keep personal configuration files out of source control. Credentials are process
environment values, not tool arguments. See
[client-specific copy-paste configurations](examples/README.md) for Claude
Desktop, Claude Code, Cursor, VS Code/GitHub Copilot, Devin, and Cline.

### Run from a source checkout

```sh
npm ci
npm run build
```

Point the client at the absolute path to `dist/stdio.js` with `node`, and provide
the same environment variables shown above.

## Claude Desktop MCPB

To install the Claude Desktop extension:

1. Download `screenshotscout-mcp-<version>.mcpb` from that version's GitHub
   release.
2. In Claude Desktop, open **Settings → Extensions → Advanced settings** and
   choose **Install Extension…**.
3. Select the downloaded file.
4. Enter the required access key. Enter the secret key only for an API key that
   requires signed requests.

Claude Desktop treats both fields as sensitive settings. The `v0.1.0` MCPB
supports Windows.

## Hosted Streamable HTTP

The hosted API-key endpoint is live at:

```text
https://mcp.screenshotscout.com/mcp/api-key
```

It is intended only for clients that can attach a static HTTP header:

```text
Authorization: Bearer YOUR_ACCESS_KEY
```

The endpoint accepts an access key only. Never send a Screenshot Scout secret
key to it, and never put either key in the URL or a tool argument. Clients that
cannot attach a static Bearer header cannot use this endpoint.

API keys that require request signatures must instead use local stdio or MCPB,
or use a dedicated unsigned access key for the hosted endpoint.

## Local stdio with Docker

Build the production image from a source checkout:

```sh
docker build --tag screenshotscout-mcp:local .
```

Pass credentials from the local environment and keep stdin attached for MCP
stdio traffic:

```sh
docker run --rm -i --init --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  -e SCREENSHOTSCOUT_ACCESS_KEY \
  -e SCREENSHOTSCOUT_SECRET_KEY \
  screenshotscout-mcp:local
```

`SCREENSHOTSCOUT_SECRET_KEY` remains optional. The image runs as an unprivileged
user and contains only the compiled stdio server and its production dependencies.
It declares no port or container health check: an MCP client owns the stdio
process and verifies readiness by completing MCP initialization. The image and
its Docker MCP Catalog metadata in `docker-mcp-catalog.yaml` are local
preparation; no public image is implied by these commands.

## Tool: `capture_screenshot`

`capture_screenshot` sends one capture request for the supplied URL and options.
The target webpage is external, and its returned content must be treated as
untrusted.

### Inputs

Only `url` is required. Captures use a 1280×720 viewport by default. When no
format is specified, the tool returns JPEG at quality 60. `resultMode` defaults
to `"auto"`.

| Group                 | Inputs                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target and output     | `url`; `format` (`png`, `jpg`, `jpeg`, `webp`, `gif`, `tiff`, `pdf`); `resultMode` (`auto`, `url_only`)                                                                                      |
| Location and viewport | `country` (two-letter country code), `device`, `deviceViewportWidth`, `deviceViewportHeight`, `colorScheme` (`auto`, `dark`, `light`), `fullPage`                                            |
| Page preparation      | `blockCookieBanners`, `blockAds`, `blockChatWidgets`, `selector`, `hideSelectors`, `clickSelectors`                                                                                          |
| Timing                | `waitUntil` (`load`, `domcontentloaded`, `networkidle0`, `networkidle2`), `delay` (0–30 seconds), `navigationTimeout` (5–90 seconds), `timeout` (1–240 seconds)                              |
| Cache                 | `cache`, `cacheTtl` (14,400–2,592,000 seconds)                                                                                                                                               |
| Output resizing       | `imageWidth`, `imageHeight` (1–8,192; available for images and PDFs)                                                                                                                         |
| Image only            | `imageQuality` (0–100, JPEG/WebP only)                                                                                                                                                       |
| PDF only              | `pdfPaperFormat` (`letter`, `legal`, `tabloid`, `a4`, `a3`, `content`), `pdfLandscape`, `pdfPrintBackground`, `pdfMargin`, per-side margin fields, `pdfScale` (greater than 0 and at most 3) |

When both output dimensions are provided, their product cannot exceed 64,000,000
pixels. PDF margins accept non-negative values in `px`, `in`, `mm`, or `cm`.
`imageQuality` requires JPEG or WebP output, and PDF-only options require
`format: "pdf"`.

### Results

- PNG, JPEG, WebP, and GIF may be included as MCP image content when
  `resultMode` is `auto`, the MIME type is eligible, dimensions are known and at
  most 8,000 pixels per side, raw data is at most 5 MiB, and the complete
  serialized result fits the current 128,000-byte server limit.
- A capture that is not eligible to embed remains successful and returns its
  temporary URL plus an actionable omission reason.
- TIFF is URL-only.
- PDF bytes are never embedded. A PDF result includes safe text and structured
  metadata, plus a resource link when Screenshot Scout provides a result URL.
- `resultMode: "url_only"` omits image bytes for every format.

MCP clients control whether returned image content or resource links are
displayed or made available to a model.

Structured metadata can include `screenshotUrl`, `screenshotUrlExpiresAt`,
`cacheStatus`, `format`, `mimeType`, `imageWidth`, `imageHeight`,
`inlineImageIncluded`, and `inlineImageOmissionReason`.

Treat result URLs as sensitive, temporary links and respect their reported
expiry.

## Example prompts

- “Capture `https://example.com` as a full-page PNG in dark mode. Return only a
  URL.”
- “Take a 1280×720 JPEG screenshot of `https://example.com/pricing`, block cookie
  banners and ads, and use quality 80.”
- “Create an A4 PDF of `https://example.com/report` with backgrounds enabled and
  10 mm margins.”

## Privacy and security

The server sends the target URL and selected capture options to Screenshot Scout,
which loads the target website. Review the
[Screenshot Scout privacy policy](https://screenshotscout.com/privacy-policy)
before capturing private or regulated material.

- Do not capture pages you are not authorized to access.
- Do not paste credentials into prompts, tool inputs, URLs, issue reports, or
  logs.
- Keep local access and secret keys in client-managed secret storage or private
  environment configuration.
- The local stdio server adds no telemetry. Application logging for the hosted
  service is limited to request method, response status, duration, and sanitized
  unexpected errors. It is designed not to include credentials, target URLs,
  screenshot URLs, request or response content, or image bytes.
- Review each target and capture request before allowing tool use. The tool is
  open-world, consumes quota, and interacts with an external website.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run metadata:check
npm run registry:validate
npm run mcpb:validate
npm run mcpb:pack
```

## License

[MIT](LICENSE) © Oleksii Velykyi
