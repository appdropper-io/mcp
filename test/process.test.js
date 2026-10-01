// The server as an operating-system process: what it writes to stdout, how
// it exits, and how much memory a large upload costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SERVER_ENTRY, TOKEN, startFakeApi, tmpDir } from "./helpers.js";

const GUARD = new URL("../dist/stdio-guard.js", import.meta.url).href;

/** Spawns the server and speaks raw newline-delimited JSON-RPC to it. */
function spawnServer(env = {}) {
  const home = tmpDir("adp-proc-");
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, APPDROPPER_CONFIG_DIR: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = stdout.split("\n").find((l) => l && JSON.parse(l).id === id);
      if (line) return JSON.parse(line);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no response to ${id}; stderr: ${stderr}`);
  };
  const initialize = async () => {
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    });
    await waitFor("init");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return {
    child,
    home,
    send,
    waitFor,
    initialize,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test("stdout carries nothing but JSON-RPC, through every tool", async () => {
  const api = await startFakeApi();
  const server = spawnServer({ APPDROPPER_API_URL: api.url, APPDROPPER_TOKEN: TOKEN });
  try {
    await server.initialize();
    const apk = path.join(server.home, "app.apk");
    fs.writeFileSync(apk, Buffer.alloc(2048, 1));
    const calls = [
      ["upload_build", { file_path: apk }],
      ["upload_build", { file_path: "missing.apk" }],
      ["find_builds", { directory: server.home }],
      ["list_apps", {}],
      ["list_builds", { app_id: "app123" }],
      ["get_build", { build_id: "build123" }],
      ["whoami", {}],
    ];
    for (const [i, [name, args]] of calls.entries()) {
      server.send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
      await server.waitFor(i);
    }
    const lines = server.stdout().split("\n").filter(Boolean);
    assert.equal(lines.length, calls.length + 1);
    for (const line of lines) {
      const message = JSON.parse(line); // throws on any non-JSON line
      assert.equal(message.jsonrpc, "2.0");
    }
    assert.match(server.stderr(), /ready on stdio/, "diagnostics belong on stderr");
    assert.ok(!server.stdout().includes(TOKEN) && !server.stderr().includes(TOKEN));
  } finally {
    server.child.kill();
    await server.exited;
    server.cleanup();
    await api.close();
  }
});

test("the stdout guard reroutes stray writes to stderr and keeps the protocol channel", () => {
  const script = `
    const { claimStdout } = await import(${JSON.stringify(GUARD)});
    const channel = claimStdout();
    console.log("stray console.log");
    console.info("stray console.info");
    process.stdout.write("stray stdout.write\\n");
    channel.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n');
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
});

test("exits promptly and cleanly when the client closes stdin", async () => {
  const server = spawnServer();
  try {
    await server.initialize();
    server.child.stdin.end();
    const timer = setTimeout(() => server.child.kill("SIGKILL"), 5000);
    const { code, signal } = await server.exited;
    clearTimeout(timer);
    assert.equal(signal, null, "had to be killed — it did not exit on its own");
    assert.equal(code, 0);
    assert.match(server.stderr(), /Shutting down \(stdin closed\)/);
  } finally {
    server.cleanup();
  }
});

test("exits cleanly on SIGTERM", async () => {
  const server = spawnServer();
  try {
    await server.initialize();
    server.child.kill("SIGTERM");
    const { code } = await server.exited;
    assert.equal(code, 0);
  } finally {
    server.cleanup();
  }
});

test("--version prints the version to stderr and leaves stdout empty", () => {
  const result = spawnSyncNode([SERVER_ENTRY, "--version"]);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^0\.1\.0\n$/);
});

test("a 1 GB build is streamed, not buffered: memory stays flat", { timeout: 180_000 }, async () => {
  const GB = 1024 ** 3;
  const api = await startFakeApi();
  const server = spawnServer({ APPDROPPER_API_URL: api.url, APPDROPPER_TOKEN: TOKEN });
  const big = path.join(server.home, "huge release.apk");
  // Sparse: allocates no disk, but reads back as a real 1 GB file.
  fs.closeSync(fs.openSync(big, "w"));
  fs.truncateSync(big, GB);

  let peakKb = 0;
  const sampler = setInterval(() => {
    try {
      const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.child.pid)], { encoding: "utf8" }).trim());
      peakKb = Math.max(peakKb, kb);
    } catch {
      // process gone
    }
  }, 100);
  try {
    await server.initialize();
    server.send({ jsonrpc: "2.0", id: "big", method: "tools/call", params: { name: "upload_build", arguments: { file_path: big } } });
    const response = await server.waitFor("big", 170_000);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    assert.equal(response.result.structuredContent.size_bytes, GB);
    const put = api.requests.find((r) => r.method === "PUT");
    assert.equal(put.bytes, GB, "every byte must reach storage");
    const peakMb = peakKb / 1024;
    assert.ok(peakMb < 250, `peak RSS ${peakMb.toFixed(0)} MB — the file is being buffered`);
    process.stderr.write(`    1 GB upload: peak RSS ${peakMb.toFixed(0)} MB\n`);
  } finally {
    clearInterval(sampler);
    server.child.kill();
    await server.exited;
    server.cleanup();
    await api.close();
  }
});

function spawnSyncNode(args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
}
