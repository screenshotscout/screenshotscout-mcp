# Claude Desktop extension

This directory contains the files used to build the Screenshot Scout MCPB for
Claude Desktop. The `v0.3.0` bundle supports Windows.

To install the extension, download `screenshotscout-mcp-<version>.mcpb` from the
matching GitHub release. In Claude Desktop, open
**Settings → Extensions → Advanced settings → Install Extension…** and select
the downloaded file.

Claude Desktop prompts for a Screenshot Scout access key. Supply the optional
secret key only when the selected API key requires signed requests.

## Build from source

From the repository root:

```sh
npm run mcpb:validate
npm run mcpb:pack
npm run mcpb:clean
```

Packing writes `screenshotscout-mcp-<version>.mcpb` at the repository root.
