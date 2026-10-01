#!/usr/bin/env node
/**
 * `npx -y @appdropper/mcp` — the App Dropper MCP server over stdio.
 *
 * Order matters: stdout is claimed before any other module can write to it,
 * because on stdio the protocol owns stdout outright (see stdio-guard.ts).
 */
import { claimStdout } from "./stdio-guard.js";

const protocolOut = claimStdout();

const { StdioServerTransport, serveStdio } = await import("@modelcontextprotocol/server/stdio");
const { createServer, VERSION } = await import("./server.js");
const { log } = await import("./log.js");

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stderr.write(`${VERSION}\n`);
  process.exit(0);
}

const handle = serveStdio(() => createServer(), {
  transport: new StdioServerTransport(process.stdin, protocolOut),
  onerror: (error) => log(`Transport error: ${error.message}`),
});
log(`App Dropper MCP server ${VERSION} ready on stdio`);

let exiting = false;
async function shutdown(reason: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  log(`Shutting down (${reason})`);
  // Give the transport a moment to flush, but never hang on the way out: an
  // editor closing the pipe expects the process to be gone, not lingering.
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  try {
    await handle.close();
  } finally {
    process.exit(0);
  }
}

// The client closing our stdin is how an editor says goodbye on stdio.
process.stdin.on("end", () => void shutdown("stdin closed"));
process.stdin.on("close", () => void shutdown("stdin closed"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log(`Unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
