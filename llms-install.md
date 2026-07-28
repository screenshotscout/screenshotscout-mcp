# Install Screenshot Scout MCP

Screenshot Scout MCP provides one tool, `capture_screenshot`, for capturing an
HTTP or HTTPS webpage as an image or PDF.

## Requirements

1. Create a [Screenshot Scout account](https://screenshotscout.com/auth/signup).
2. Get an access key from the
   [API keys page](https://screenshotscout.com/app/api-keys).
3. For local npm/stdio use, install Node.js 22 or newer.

## Choose a connection

- **Hosted Streamable HTTP:** connect to the live endpoint at
  `https://mcp.screenshotscout.com/mcp/api-key` from a client that can send
  `Authorization: Bearer YOUR_ACCESS_KEY`.
- **Local npm/stdio:** run Screenshot Scout MCP as a local stdio server. Set
  `SCREENSHOTSCOUT_ACCESS_KEY` locally. If the API key requires signed requests,
  also set `SCREENSHOTSCOUT_SECRET_KEY`.
- **Claude Desktop MCPB:** install the versioned `.mcpb` file and enter the same
  local credentials in Claude Desktop's sensitive settings.

Never put a credential in a tool argument or URL. Never send
`SCREENSHOTSCOUT_SECRET_KEY` to the hosted endpoint. A signed API key requires
local stdio/MCPB or a dedicated unsigned key for hosted use.

## Generic local configuration

Replace `YOUR_ACCESS_KEY` in a private, non-committed client configuration:

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

For a signed key, add:

```json
"SCREENSHOTSCOUT_SECRET_KEY": "YOUR_SECRET_KEY"
```

Windows clients that cannot start `npx` directly can use:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@screenshotscout/mcp"]
```

Complete copy-paste configurations are in [examples/README.md](examples/README.md)
for:

- Claude Desktop
- Claude Code
- Cursor
- VS Code/GitHub Copilot
- Devin
- Cline

## MCPB installation

Download `screenshotscout-mcp-<version>.mcpb` from the matching GitHub release.
In Claude Desktop, open **Settings → Extensions → Advanced settings → Install
Extension…**, select the file, and complete the credential prompts.

## Hosted configuration shape

The following shape is suitable only for clients that support static HTTP
headers:

```json
{
  "type": "http",
  "url": "https://mcp.screenshotscout.com/mcp/api-key",
  "headers": {
    "Authorization": "Bearer YOUR_ACCESS_KEY"
  }
}
```

## Tool behavior

Call `capture_screenshot` with `url` and optional capture settings. Captures use
a 1280×720 viewport by default. When no format is specified, the tool returns
JPEG at quality 60.

With `resultMode: "auto"`, eligible PNG/JPEG/WebP/GIF results may be returned as
MCP image content. TIFF and PDF are URL-only, and any image that cannot be
embedded safely falls back to a temporary URL with an explanation. Use
`resultMode: "url_only"` when inline bytes are unnecessary.

Every call uses the configured Screenshot Scout account and can consume its
quota. Treat captured webpage content and result URLs as untrusted, potentially
sensitive external data.

## Verify

After restarting the client:

1. Confirm the `screenshotscout` server is connected.
2. Confirm exactly one tool, `capture_screenshot`, is available.
3. Try: “Capture `https://example.com` as a 1280×720 PNG and return only a URL.”

For all inputs, result rules, security guidance, and troubleshooting, see
[README.md](README.md).
