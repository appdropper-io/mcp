// Shared fixtures: a fake App Dropper API (plus the GCS resumable session it
// hands out) on a local port, and a real MCP client talking to the built
// server over stdio — the same way an editor does.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
export const TOKEN = "adp_tok123_SECRETsecretSECRETsecretSECRETsec";

export const READY = {
  upload_id: "up1",
  status: "ready",
  build_id: "build123",
  app_id: "app123",
  app_name: "Acme",
  app_icon: "",
  version: "2.4.1",
  build_number: "318",
  bundle_id: "com.acme.app",
  platform: "android",
  install_url: "https://appdropper.io/acme?build=build123",
  qr_url: "https://appdropper.io/api/v1/qr/share1.png?build=build123",
  expires_at: Date.UTC(2026, 10, 1),
};

export const BUILD = {
  build_id: "build123",
  app_id: "app123",
  app_name: "Acme",
  version: "2.4.1",
  build_number: "318",
  platform: "android",
  bundle_id: "com.acme.app",
  tag: "beta",
  release_notes: "Fix login",
  ci: null,
  file_size: 4096,
  min_os_version: "24",
  install_count: 3,
  status: "ready",
  uploaded_at: Date.UTC(2026, 9, 1),
  expires_at: Date.now() + 86_400_000,
  files_purged: false,
  install_url: "https://appdropper.io/acme?build=build123",
  qr_url: "https://appdropper.io/api/v1/qr/share1.png?build=build123",
};

/**
 * `scenario` decides each response, so a test can script exactly the failure
 * it is about. Every request is recorded (method, url, headers, body length).
 */
export async function startFakeApi(scenario = {}) {
  const requests = [];
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (!req.url.startsWith("/session")) chunks.push(chunk);
    }
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    requests.push({ method: req.method, url: req.url, headers: req.headers, body, bytes });
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const error = (status, code, message) => json(status, { error: { code, message } });

    if (scenario.everything) return scenario.everything(req, res, { json, error });

    if (req.method === "POST" && req.url === "/uploads") {
      if (scenario.reserve) return scenario.reserve({ json, error, body });
      return json(201, {
        upload_id: "up1",
        upload_url: `http://127.0.0.1:${server.address().port}/session/up1`,
        content_type: "application/octet-stream",
        all_apps: true,
      });
    }
    if (req.method === "PUT" && req.url.startsWith("/session")) {
      if (scenario.put) return scenario.put(req, res);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET" && req.url.startsWith("/uploads/up1")) {
      polls += 1;
      if (scenario.poll) return scenario.poll({ json, error, polls });
      return json(200, READY);
    }
    if (req.method === "GET" && (req.url === "/me" || req.url === "/apps")) {
      if (scenario.me) return scenario.me({ json, error });
      return json(200, {
        token_id: "tok123",
        token_name: "My laptop",
        hint: "adp_tok123_••••••Rsec",
        scopes: ["upload:builds"],
        expires_at: Date.UTC(2026, 11, 30),
        all_apps: true,
        apps: [
          { app_id: "app123", app_name: "Acme", bundle_id: "com.acme.app", install_url: "https://appdropper.io/acme" },
        ],
      });
    }
    const builds = req.url.match(/^\/apps\/([^/]+)\/builds\?limit=(\d+)$/);
    if (req.method === "GET" && builds) {
      if (scenario.builds) return scenario.builds({ json, error, appId: builds[1] });
      return json(200, {
        app_id: "app123",
        app_name: "Acme",
        bundle_id: "com.acme.app",
        platform: "android",
        install_url: "https://appdropper.io/acme",
        builds: Array.from({ length: Number(builds[2]) }, (_, i) => ({
          ...BUILD,
          build_id: `b${i}`,
          version: `2.4.${9 - i}`,
          uploaded_at: Date.UTC(2026, 9, 9 - i),
        })),
      });
    }
    if (req.method === "GET" && req.url.startsWith("/builds/")) {
      if (scenario.build) return scenario.build({ json, error });
      return json(200, BUILD);
    }
    error(404, "not_found", `No ${req.method} ${req.url} endpoint.`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function tmpDir(prefix = "adp-mcp-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Writes a non-empty fake build; App Dropper's parsing is the fake API's job. */
export function writeBuild(file, bytes = 4096) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

/**
 * Starts the real server over stdio and connects a real MCP client.
 * `era` is "legacy" (2025 handshake — what editors ship today) or "modern"
 * (pinned to the 2026-07-28 revision).
 */
export async function connect({ apiUrl, token = TOKEN, env = {}, cwd, era = "legacy" } = {}) {
  const configDir = tmpDir("adp-config-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: cwd ?? configDir,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: configDir,
      APPDROPPER_CONFIG_DIR: configDir,
      ...(apiUrl ? { APPDROPPER_API_URL: apiUrl } : {}),
      ...(token ? { APPDROPPER_TOKEN: token } : {}),
      ...env,
    },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client(
    { name: "appdropper-mcp-tests", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}
  );
  await client.connect(transport);
  return {
    client,
    configDir,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

/** The text of a tool result, joined. */
export function text(result) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
