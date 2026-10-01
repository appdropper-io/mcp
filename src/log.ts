/**
 * Diagnostics go to stderr — the only output channel a stdio MCP server has
 * besides the protocol itself. Claude Code, Cursor and VS Code all surface a
 * server's stderr in their MCP logs.
 *
 * Everything passes through {@link redact} first, so a token can't reach a log
 * even if one ends up inside an error message.
 */
export function log(message: string): void {
  process.stderr.write(`[appdropper-mcp] ${redact(message)}\n`);
}

/** App Dropper tokens are `adp_{id}_{secret}`; nothing past the prefix survives. */
const TOKEN_PATTERN = /adp_[A-Za-z0-9]+_[A-Za-z0-9]+/g;

export function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, "adp_[redacted]");
}
