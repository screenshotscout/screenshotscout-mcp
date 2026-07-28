# Client configuration examples

These examples configure either the hosted Streamable HTTP endpoint or the
`@screenshotscout/mcp` local stdio package.

Get an access key from the
[Screenshot Scout API keys page](https://screenshotscout.com/app/api-keys).
Examples use `YOUR_ACCESS_KEY` and `YOUR_SECRET_KEY` placeholders—never commit
real values. Omit `SCREENSHOTSCOUT_SECRET_KEY` unless the chosen API key requires
signed requests. The hosted endpoint accepts only access keys that do not
require signed requests and never accepts a secret key.

## Claude Desktop

Install the versioned `.mcpb` file from
**Settings → Extensions → Advanced settings → Install Extension…** and complete
its sensitive credential prompts.

For npm/stdio, open **Settings → Developer → Edit Config** and add this entry to
`claude_desktop_config.json`:

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

The configuration file is normally at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after saving.

## Claude Code

For the live hosted endpoint, put the access key in the environment where Claude
Code runs and add this to a private `.mcp.json`:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "type": "http",
      "url": "https://mcp.screenshotscout.com/mcp/api-key",
      "headers": {
        "Authorization": "Bearer ${SCREENSHOTSCOUT_ACCESS_KEY}"
      }
    }
  }
}
```

Do not set a secret key for the hosted connection.

For local stdio, add an unsigned key at user scope:

```sh
claude mcp add --env SCREENSHOTSCOUT_ACCESS_KEY=YOUR_ACCESS_KEY --transport stdio --scope user screenshotscout -- npx -y @screenshotscout/mcp
```

For an API key that requires signing:

```sh
claude mcp add --env SCREENSHOTSCOUT_ACCESS_KEY=YOUR_ACCESS_KEY --env SCREENSHOTSCOUT_SECRET_KEY=YOUR_SECRET_KEY --transport stdio --scope user screenshotscout -- npx -y @screenshotscout/mcp
```

On native Windows, use `cmd /c` for the `npx` command:

```sh
claude mcp add --env SCREENSHOTSCOUT_ACCESS_KEY=YOUR_ACCESS_KEY --transport stdio --scope user screenshotscout -- cmd /c npx -y @screenshotscout/mcp
```

Alternatively, put this in a private `.mcp.json`. Claude Code expands the
credential from its own environment:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@screenshotscout/mcp"],
      "env": {
        "SCREENSHOTSCOUT_ACCESS_KEY": "${SCREENSHOTSCOUT_ACCESS_KEY}"
      }
    }
  }
}
```

Check the connection with `claude mcp list` or `/mcp`.

## Cursor

Add this to `.cursor/mcp.json` in a project or `~/.cursor/mcp.json` for your user:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "url": "https://mcp.screenshotscout.com/mcp/api-key",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_KEY"
      }
    }
  }
}
```

Use a private user configuration when placing the access key directly in the
file. Do not add a secret key to the hosted connection.

For local stdio, use:

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

Open Cursor settings, select **Tools & MCP**, and confirm the server is enabled.

## VS Code and GitHub Copilot

Run **MCP: Open User Configuration** for a private user-level setup, or create
`.vscode/mcp.json` for a workspace. For local stdio, this configuration prompts
for the access key as a masked password input:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "screenshotscout-access-key",
      "description": "Screenshot Scout access key",
      "password": true
    }
  ],
  "servers": {
    "screenshotscout": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@screenshotscout/mcp"],
      "env": {
        "SCREENSHOTSCOUT_ACCESS_KEY": "${input:screenshotscout-access-key}"
      }
    }
  }
}
```

For a signed key, add a second password input and map it to
`SCREENSHOTSCOUT_SECRET_KEY`.

For the live hosted endpoint, use a password input with an HTTP header:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "screenshotscout-access-key",
      "description": "Screenshot Scout access key",
      "password": true
    }
  ],
  "servers": {
    "screenshotscout": {
      "type": "http",
      "url": "https://mcp.screenshotscout.com/mcp/api-key",
      "headers": {
        "Authorization": "Bearer ${input:screenshotscout-access-key}"
      }
    }
  }
}
```

The hosted configuration must not include `SCREENSHOTSCOUT_SECRET_KEY`.

## Devin

In Devin, open **Settings → Connections → MCP servers**, select
**Add a custom MCP**, and configure:

- Transport: **HTTP**
- Server URL: `https://mcp.screenshotscout.com/mcp/api-key`
- Authentication: **Auth Header**
- Header name: `Authorization`
- Header value: `Bearer YOUR_ACCESS_KEY`

Save the server and choose **Test listing tools**. The result should contain
exactly one tool, `capture_screenshot`. Do not provide a secret key.

## Cline

Open **MCP Servers → Configure → Configure MCP Servers** and add the live hosted
endpoint:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "type": "streamableHttp",
      "url": "https://mcp.screenshotscout.com/mcp/api-key",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Keep this configuration private and do not add a secret key. For local stdio,
use:

```json
{
  "mcpServers": {
    "screenshotscout": {
      "command": "npx",
      "args": ["-y", "@screenshotscout/mcp"],
      "env": {
        "SCREENSHOTSCOUT_ACCESS_KEY": "YOUR_ACCESS_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Enable the server after saving.

## Windows `npx` fallback

If a Windows client reports that it cannot spawn `npx`, replace:

```json
"command": "npx",
"args": ["-y", "@screenshotscout/mcp"]
```

with:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@screenshotscout/mcp"]
```

## Example prompts

- “Capture `https://example.com` as a full-page PNG in dark mode. Return only a
  URL.”
- “Take a 1280×720 JPEG screenshot of `https://example.com/pricing`, block cookie
  banners and ads, and use quality 80.”
- “Create an A4 PDF of `https://example.com/report` with backgrounds enabled and
  10 mm margins.”

Every capture can consume Screenshot Scout quota and loads an external webpage.
Review the request and treat captured content as untrusted.
