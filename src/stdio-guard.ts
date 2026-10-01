import { Writable } from "node:stream";

/**
 * On a stdio MCP server, stdout *is* the protocol: the client parses every
 * line of it as JSON-RPC. One stray `console.log` — ours or a dependency's —
 * corrupts the stream and the editor drops the connection.
 *
 * So stdout is claimed before anything else runs. The MCP transport gets a
 * private stream bound to the real stdout; everything else that tries to write
 * there (`process.stdout.write`, `console.log/info/debug`) is sent to stderr,
 * which clients show as server logs. Lint forbids console.log in this package
 * too, but this is what actually guarantees it.
 */
export function claimStdout(): Writable {
  const stdout = process.stdout;
  const writeToStdout = stdout.write.bind(stdout);

  const channel = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeToStdout(chunk, (err) => callback(err ?? null));
    },
  });
  // A client that has gone away surfaces as EPIPE on stdout. Hand it to the
  // transport's stream instead of letting it crash the process.
  stdout.on("error", (err) => channel.destroy(err));

  stdout.write = ((...args: Parameters<typeof process.stderr.write>) =>
    process.stderr.write(...args)) as typeof process.stdout.write;
  for (const method of ["log", "info", "debug"] as const) {
    console[method] = (...args: unknown[]) => console.error(...args);
  }
  return channel;
}
