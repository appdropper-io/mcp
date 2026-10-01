# @appdropper/mcp

An MCP server for [App Dropper](https://appdropper.io). It lets your coding agent upload a local `.apk` or `.ipa` and hand you the tester install link without leaving the editor.

Works with Claude Code, Cursor, VS Code with GitHub Copilot, GitHub Copilot CLI and any other MCP client that can launch a local stdio server.

```text
You:   Upload build/app/outputs/flutter-apk/app-release.apk to App Dropper and give me the install link.

Agent: Uploaded Acme 2.4.1 (318).
       Install: https://appdropper.io/acme?build=Xb81…
```

Full documentation: <https://appdropper.io/help/mcp>

## Setup

Requires Node.js 20 or newer.

**1. Sign in once.** This opens your browser to approve the machine and saves a token to `~/.appdropper/config`. The MCP server picks it up automatically.

```sh
npx appdropper login
```

**2. Add the server to your editor.**

Claude Code:

```sh
claude mcp add appdropper -s user -- npx -y @appdropper/mcp
```

On native Windows, use `-- cmd /c npx -y @appdropper/mcp`.

Cursor (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "appdropper": {
      "command": "npx",
      "args": ["-y", "@appdropper/mcp"]
    }
  }
}
```

VS Code with GitHub Copilot (`.vscode/mcp.json`, or run **MCP: Open User Configuration**). Note that the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "appdropper": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@appdropper/mcp"]
    }
  }
}
```

GitHub Copilot CLI:

```sh
copilot mcp add appdropper -- npx -y @appdropper/mcp
```

**3. Ask.** "Upload the latest Android build to App Dropper."

## Tools

| Tool | What it does | Side effects |
| --- | --- | --- |
| `upload_build` | Uploads a local `.apk` or `.ipa`, waits for processing, and returns the version, build number, install URL and QR code URL. | Publishes the build and notifies the app's testers by email and push. |
| `find_builds` | Finds `.apk` and `.ipa` files in a project directory, newest first. | None. Read-only, and never uploads. |
| `list_apps` | Lists the apps your token can upload to, with their IDs. | None |
| `list_builds` | Lists an app's recent builds with install links. | None |
| `get_build` | Gets one build's details by `build_id`. | None |
| `whoami` | Shows whether the server is signed in and what the credential covers. It never reveals the token. | None |

## Authentication

The server looks for a token in this order, the same order the `appdropper` CLI uses:

1. `APPDROPPER_TOKEN` in the server's environment
2. The saved login from `npx appdropper login`

Credentials are read on every call, so signing in after your editor started needs no restart.

`appdropper login` gives this machine access to **all your apps by default, including new ones**: the first upload of a new bundle ID creates its app. To use a token limited to specific apps instead, create one at <https://appdropper.io/dashboard/tokens> and set `APPDROPPER_TOKEN`. Don't paste a token into a config file you commit. Cursor and VS Code can read it from your environment with `"env": { "APPDROPPER_TOKEN": "${env:APPDROPPER_TOKEN}" }`, and Claude Code's `.mcp.json` with `"${APPDROPPER_TOKEN}"`. GitHub Copilot CLI doesn't pass your shell environment through to servers, so use `appdropper login` there.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPDROPPER_TOKEN` | — | API token; overrides the saved login |
| `APPDROPPER_MCP_TIMEOUT` | `600` | Seconds `upload_build` waits for App Dropper to process a build |
| `APPDROPPER_API_URL` | `https://appdropper.io/api/v1` | API base URL |

## Notes

- Uploads stream from disk and resume after a dropped connection, so large builds are fine. Your plan's size limit still applies.
- App Dropper doesn't sign or re-sign apps. An `.ipa` has to be signed for the testers' devices (ad hoc or enterprise) to install.
- Only `.apk` and `.ipa` files are accepted. `upload_build` uploads exactly the path it is given and rejects URLs.
- The server writes only MCP messages to stdout. Its logs go to stderr, which your editor shows in its MCP logs.

## License

MIT
