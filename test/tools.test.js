// End-to-end over the MCP protocol: the built server is spawned over stdio
// and driven by the official MCP client, against a fake App Dropper API.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILD, READY, TOKEN, connect, startFakeApi, text, tmpDir, writeBuild } from "./helpers.js";

/** Runs `fn` with a fresh API + server, and checks no response leaked the token. */
async function withServer(scenario, fn, connectOptions = {}) {
  const api = await startFakeApi(scenario);
  const session = await connect({ apiUrl: api.url, ...connectOptions });
  const results = [];
  const call = async (name, args = {}, options) => {
    const result = await session.client.callTool({ name, arguments: args }, options);
    results.push(result);
    return result;
  };
  try {
    await fn({ api, session, call });
  } finally {
    await session.close();
    await api.close();
  }
  for (const result of results) {
    assert.ok(!JSON.stringify(result).includes(TOKEN.split("_")[2]), "a tool result leaked the token");
  }
  assert.ok(!session.stderr().includes(TOKEN.split("_")[2]), "stderr leaked the token");
}

let project;
before(() => {
  project = tmpDir("adp-project-");
  writeBuild(path.join(project, "build/app/outputs/flutter-apk/app-release.apk"));
  writeBuild(path.join(project, "My Builds/Acme Release.ipa"));
  fs.writeFileSync(path.join(project, "notes.txt"), "not a build");
});
after(() => fs.rmSync(project, { recursive: true, force: true }));

for (const era of ["legacy", "modern"]) {
  describe(`tool discovery (${era} protocol)`, () => {
    test("lists exactly the six tools, each described and correctly annotated", async () => {
      await withServer({}, async ({ session }) => {
        const { tools } = await session.client.listTools();
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        assert.deepEqual(Object.keys(byName).sort(), [
          "find_builds",
          "get_build",
          "list_apps",
          "list_builds",
          "upload_build",
          "whoami",
        ]);
        for (const tool of tools) {
          assert.ok(tool.description.length > 80, `${tool.name} needs a real description`);
          assert.ok(tool.outputSchema, `${tool.name} has no outputSchema`);
          assert.equal(tool.inputSchema.type, "object");
        }
        assert.equal(byName.upload_build.annotations.readOnlyHint, false);
        assert.equal(byName.upload_build.annotations.openWorldHint, true);
        assert.match(byName.upload_build.description, /notifies that app's testers/);
        assert.deepEqual(byName.upload_build.inputSchema.required, ["file_path"]);
        for (const name of ["find_builds", "list_apps", "list_builds", "get_build", "whoami"]) {
          assert.equal(byName[name].annotations.readOnlyHint, true, `${name} must be read-only`);
        }
        assert.equal(byName.find_builds.annotations.openWorldHint, false);
      }, { era });
    });

    test("upload_build returns the install link and structured build data", async () => {
      await withServer({}, async ({ call }) => {
        const result = await call("upload_build", {
          file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk"),
        });
        assert.equal(result.isError, undefined, text(result));
        assert.match(text(result), /^Acme 2\.4\.1 \(318\) uploaded to App Dropper\.\nInstall: https:\/\/appdropper\.io\/acme\?build=build123/);
        assert.deepEqual(result.structuredContent, {
          status: "ready",
          app_name: "Acme",
          app_id: "app123",
          platform: "android",
          version: "2.4.1",
          build_number: "318",
          bundle_id: "com.acme.app",
          build_id: "build123",
          install_url: READY.install_url,
          qr_url: READY.qr_url,
          expires_at: "2026-11-01T00:00:00.000Z",
          file_name: "app-release.apk",
          size_bytes: 4096,
        });
      }, { era });
    });
  });
}

describe("upload_build", () => {
  test("sends release notes and tag, no CI block, and identifies itself", async () => {
    await withServer({}, async ({ api, call }) => {
      await call("upload_build", {
        file_path: path.join(project, "My Builds/Acme Release.ipa"),
        release_notes: "Fix login on iOS 18",
        tag: "qa",
      });
      const reserve = api.requests.find((r) => r.method === "POST");
      const body = JSON.parse(reserve.body);
      assert.equal(body.file_name, "Acme Release.ipa");
      assert.equal(body.file_size, 4096);
      assert.equal(body.release_notes, "Fix login on iOS 18");
      assert.equal(body.tag, "qa");
      assert.equal(body.ci, undefined, "an editor upload must not pretend to be CI");
      assert.equal(reserve.headers.authorization, `Bearer ${TOKEN}`);
      assert.match(reserve.headers["user-agent"], /^appdropper-mcp\/0\.1\.0 appdropper\/1\.2\.0 node\//);
      const put = api.requests.find((r) => r.method === "PUT");
      assert.equal(put.bytes, 4096, "the whole file reached storage");
      assert.equal(put.headers.authorization, undefined, "the token must never go to storage");
    });
  });

  test("resolves a relative path (with spaces) against the project directory", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("upload_build", { file_path: "My Builds/Acme Release.ipa" });
      assert.equal(result.isError, undefined, text(result));
      assert.equal(result.structuredContent.file_name, "Acme Release.ipa");
    }, { cwd: project });
  });

  test("prefers CLAUDE_PROJECT_DIR over the process directory for relative paths", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("upload_build", { file_path: "build/app/outputs/flutter-apk/app-release.apk" });
      assert.equal(result.isError, undefined, text(result));
    }, { env: { CLAUDE_PROJECT_DIR: project } });
  });

  test("waits through a slow processing phase", async () => {
    await withServer(
      { poll: ({ json, polls }) => json(polls < 3 ? 202 : 200, polls < 3 ? { upload_id: "up1", status: "processing" } : READY) },
      async ({ api, call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, undefined, text(result));
        assert.equal(api.requests.filter((r) => r.url.startsWith("/uploads/up1")).length, 3);
      }
    );
  });

  test("reports progress to a client that asks for it", async () => {
    await withServer({}, async ({ call }) => {
      const updates = [];
      const result = await call(
        "upload_build",
        { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") },
        { onprogress: (p) => updates.push(p) }
      );
      assert.equal(result.isError, undefined, text(result));
      assert.ok(updates.length >= 2, `expected progress, got ${JSON.stringify(updates)}`);
      const values = updates.map((u) => u.progress);
      assert.deepEqual(values, [...values].sort((a, b) => a - b), "progress must only increase");
      assert.ok(updates.every((u) => u.total === 100 && typeof u.message === "string"));
    });
  });

  const failures = [
    ["a missing file", { file_path: "/definitely/not/here/app.apk" }, /No such file[\s\S]*find_builds[\s\S]*error code: file_not_found/],
    ["an unsupported file", { file_path: "notes.txt" }, /Only \.apk and \.ipa[\s\S]*error code: unsupported_file_type/],
    ["a directory", { file_path: "build" }, /Not a file[\s\S]*error code: not_a_file/],
    ["a URL", { file_path: "https://example.com/app.apk" }, /not a URL[\s\S]*error code: invalid_path/],
    ["a file: URL", { file_path: "file:///tmp/app.apk" }, /not a URL[\s\S]*error code: invalid_path/],
  ];
  for (const [label, args, expected] of failures) {
    test(`refuses ${label} without contacting App Dropper`, async () => {
      await withServer({}, async ({ api, call }) => {
        const result = await call("upload_build", args);
        assert.equal(result.isError, true);
        assert.match(text(result), expected);
        assert.equal(api.requests.length, 0, "nothing may be sent for a local error");
      }, { cwd: project });
    });
  }

  test("rejects invalid arguments as a tool error", async () => {
    await withServer({}, async ({ api, call }) => {
      for (const args of [{}, { file_path: "" }, { file_path: "a.apk", tag: "x".repeat(41) }, { file_path: 42 }]) {
        const result = await call("upload_build", args);
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.match(text(result), /Input validation error/);
      }
      assert.equal(api.requests.length, 0);
    });
  });

  const apiFailures = [
    [401, "unauthorized", "This API token has been revoked.", /token was rejected[\s\S]*appdropper login/],
    [
      402,
      "upgrade_required",
      "This build is 620 MB. Your plan allows up to 500 MB per build. Upgrade to Studio at https://appdropper.io/pricing",
      /620 MB[\s\S]*Upgrade: https:\/\/appdropper\.io\/pricing\n[\s\S]*error code: plan_limit, HTTP 402/,
    ],
    [403, "forbidden", "This token isn't allowed to reach that app.", /list_apps[\s\S]*error code: forbidden/],
    [429, "rate_limited", "Rate limit reached (300 requests per hour for this token). Try again in 12 min.", /Try again in 12 min[\s\S]*error code: rate_limited, HTTP 429, retryable/],
    [500, "server_error", "Something went wrong.", /temporary problem[\s\S]*status[\s\S]*error code: server_error, HTTP 500, retryable/],
    [503, "service_unavailable", "App Dropper is in maintenance.", /error code: server_error, HTTP 503, retryable/],
  ];
  for (const [status, code, message, expected] of apiFailures) {
    test(`turns an HTTP ${status} into an actionable error`, async () => {
      await withServer({ reserve: ({ error }) => error(status, code, message) }, async ({ api, call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, true);
        assert.match(text(result), expected);
        assert.ok(!api.requests.some((r) => r.method === "PUT"), "no bytes after a refused reservation");
      });
    });
  }

  test("reports a binary App Dropper couldn't read as invalid_build", async () => {
    await withServer(
      { poll: ({ json }) => json(200, { upload_id: "up1", status: "error", error: { code: "invalid_build", message: "This doesn't look like a valid APK." } }) },
      async ({ call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, true);
        assert.match(text(result), /valid APK[\s\S]*signed \.apk[\s\S]*Upload ID: up1[\s\S]*error code: invalid_build/);
      }
    );
  });

  test("reports a plan cap hit during processing (e.g. app count) with its upgrade link", async () => {
    await withServer(
      {
        poll: ({ json }) =>
          json(200, {
            upload_id: "up1",
            status: "error",
            error: { code: "upgrade_required", message: "That would be app number 6. Upgrade to Pro at https://appdropper.io/pricing" },
          }),
      },
      async ({ call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.match(text(result), /app number 6[\s\S]*Upgrade: https:\/\/appdropper\.io\/pricing[\s\S]*error code: plan_limit/);
      }
    );
  });

  test("reports an upload that dropped and couldn't resume", async () => {
    await withServer(
      {
        put: (req, res) => {
          if (req.headers["content-range"]?.startsWith("bytes */")) {
            res.writeHead(410);
            return res.end();
          }
          res.writeHead(503);
          res.end("backend error");
        },
      },
      async ({ call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, true);
        assert.match(text(result), /HTTP 503[\s\S]*Try the upload again[\s\S]*error code: upload_interrupted, retryable/);
      }
    );
  });

  test("resumes an interrupted upload from where storage left off", async () => {
    let attempt = 0;
    await withServer(
      {
        put: (req, res) => {
          if (req.headers["content-range"]?.startsWith("bytes */")) {
            res.writeHead(308, { range: "bytes=0-1023" });
            return res.end();
          }
          attempt += 1;
          if (attempt === 1) {
            req.socket.destroy(); // dropped connection mid-transfer
            return;
          }
          assert.equal(req.headers["content-range"], "bytes 1024-4095/4096");
          res.writeHead(200);
          res.end();
        },
      },
      async ({ call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, undefined, text(result));
        assert.equal(attempt, 2);
      }
    );
  });

  test("a network failure is reported as such", async () => {
    // Nothing listens on port 9: the connection is refused outright.
    const session = await connect({ apiUrl: "http://127.0.0.1:9" });
    try {
      const result = await session.client.callTool({
        name: "upload_build",
        arguments: { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /Couldn't reach App Dropper[\s\S]*error code: network_error, retryable/);
    } finally {
      await session.close();
    }
  });

  test("not signed in: says exactly how to sign in, sends nothing", async () => {
    await withServer({}, async ({ api, call }) => {
      const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
      assert.equal(result.isError, true);
      assert.match(text(result), /isn't signed in[\s\S]*npx appdropper login[\s\S]*error code: not_authenticated/);
      assert.equal(api.requests.length, 0);
    }, { token: null });
  });

  test("uses a saved `appdropper login` when APPDROPPER_TOKEN is not set", async () => {
    const api = await startFakeApi();
    const session = await connect({ apiUrl: api.url, token: null });
    try {
      fs.writeFileSync(
        path.join(session.configDir, "config"),
        JSON.stringify({ credentials: { [api.url]: { token: "adp_saved_LOGINloginLOGINlogin" } } })
      );
      // Written after the server started: the login is picked up without a restart.
      const result = await session.client.callTool({
        name: "upload_build",
        arguments: { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") },
      });
      assert.equal(result.isError, undefined, text(result));
      assert.equal(api.requests[0].headers.authorization, "Bearer adp_saved_LOGINloginLOGINlogin");
    } finally {
      await session.close();
      await api.close();
    }
  });

  test("hands back the upload ID when processing outlasts the wait", async () => {
    await withServer(
      { poll: ({ json }) => json(202, { upload_id: "up1", status: "processing" }) },
      async ({ call }) => {
        const result = await call("upload_build", { file_path: path.join(project, "build/app/outputs/flutter-apk/app-release.apk") });
        assert.equal(result.isError, true);
        assert.match(text(result), /still processing[\s\S]*list_builds[\s\S]*Upload ID: up1[\s\S]*error code: processing_timeout/);
      },
      { env: { APPDROPPER_MCP_TIMEOUT: "0.001" } }
    );
  });

  test("a cancelled call stops the transfer", async () => {
    let putStarted;
    const started = new Promise((resolve) => (putStarted = resolve));
    await withServer(
      {
        put: (req) => {
          putStarted();
          req.resume(); // accept bytes, never answer
        },
      },
      async ({ api, call }) => {
        const big = writeBuild(path.join(project, "big.apk"), 8 * 1024 * 1024);
        const controller = new AbortController();
        const pending = call("upload_build", { file_path: big }, { signal: controller.signal });
        await started;
        controller.abort();
        await assert.rejects(pending);
        // The server must not keep polling or resume after the cancel.
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(api.requests.filter((r) => r.method === "PUT").length, 1);
        assert.ok(!api.requests.some((r) => r.url.startsWith("/uploads/up1")));
        fs.rmSync(big);
      }
    );
  });
});

describe("find_builds", () => {
  test("lists builds newest first with platform and variant, never uploading", async () => {
    await withServer({}, async ({ api, call }) => {
      const older = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(project, "My Builds/Acme Release.ipa"), older, older);
      const result = await call("find_builds", { directory: project });
      assert.equal(result.isError, undefined, text(result));
      const builds = result.structuredContent.builds;
      assert.equal(builds[0].file_name, "app-release.apk");
      assert.equal(builds[0].platform, "android");
      assert.equal(builds[0].variant, "release");
      assert.equal(builds[1].platform, "ios");
      assert.match(text(result), /Found 2 builds/);
      assert.equal(api.requests.length, 0, "find_builds must not touch the network");
    });
  });

  test("defaults to CLAUDE_PROJECT_DIR and filters by platform", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("find_builds", { platform: "ios" });
      assert.deepEqual(result.structuredContent.builds.map((b) => b.file_name), ["Acme Release.ipa"]);
    }, { env: { CLAUDE_PROJECT_DIR: project } });
  });

  test("refuses to crawl the home directory by default", async () => {
    await withServer({}, async ({ call, session }) => {
      const result = await call("find_builds", {});
      assert.equal(result.isError, true);
      assert.match(text(result), /too broad to search[\s\S]*Pass `directory`/);
      assert.ok(session.configDir);
    }, { cwd: undefined, env: {} });
  });

  test("reports a missing directory", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("find_builds", { directory: "/no/such/project" });
      assert.equal(result.isError, true);
      assert.match(text(result), /No such directory[\s\S]*error code: invalid_directory/);
    });
  });
});

describe("read-only tools", () => {
  test("list_apps returns IDs a later call can use", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("list_apps");
      assert.deepEqual(result.structuredContent, {
        all_apps: true,
        apps: [{ app_id: "app123", app_name: "Acme", bundle_id: "com.acme.app", install_url: "https://appdropper.io/acme" }],
      });
      assert.match(text(result), /all apps on the account, including new ones[\s\S]*app_id app123/);
    });
  });

  test("list_builds returns the last N builds, newest first", async () => {
    await withServer({}, async ({ api, call }) => {
      const result = await call("list_builds", { app_id: "app123", limit: 3 });
      assert.equal(result.structuredContent.builds.length, 3);
      assert.deepEqual(result.structuredContent.builds.map((b) => b.version), ["2.4.9", "2.4.8", "2.4.7"]);
      assert.equal(result.structuredContent.builds[0].uploaded_at, "2026-10-09T00:00:00.000Z");
      assert.ok(api.requests.some((r) => r.url === "/apps/app123/builds?limit=3"));
    });
  });

  test("list_builds without an app_id asks for the token's only app", async () => {
    await withServer({}, async ({ api, call }) => {
      await call("list_builds", {});
      assert.ok(api.requests.some((r) => r.url === "/apps/self/builds?limit=10"));
    });
  });

  test("list_builds rejects a malformed app_id before calling the API", async () => {
    await withServer({}, async ({ api, call }) => {
      const result = await call("list_builds", { app_id: "../../me" });
      assert.equal(result.isError, true);
      assert.equal(api.requests.length, 0);
    });
  });

  test("get_build returns one build's details", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("get_build", { build_id: "build123" });
      assert.equal(result.structuredContent.install_url, BUILD.install_url);
      assert.equal(result.structuredContent.release_notes, "Fix login");
      assert.equal(result.structuredContent.expired, false);
      assert.match(text(result), /Install: https:\/\/appdropper\.io\/acme\?build=build123/);
    });
  });

  test("get_build turns a 404 into not_found", async () => {
    await withServer({ build: ({ error }) => error(404, "not_found", "No such build.") }, async ({ call }) => {
      const result = await call("get_build", { build_id: "nope" });
      assert.equal(result.isError, true);
      assert.match(text(result), /No such build[\s\S]*error code: not_found, HTTP 404/);
    });
  });

  test("whoami reports the credential without revealing it", async () => {
    await withServer({}, async ({ call }) => {
      const result = await call("whoami");
      assert.equal(result.structuredContent.authenticated, true);
      assert.equal(result.structuredContent.credential_source, "APPDROPPER_TOKEN");
      assert.equal(result.structuredContent.token_name, "My laptop");
      assert.equal(result.structuredContent.all_apps, true);
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    });
  });

  test("whoami explains an expired token instead of failing", async () => {
    await withServer({ me: ({ error }) => error(401, "unauthorized", "This API token has expired.") }, async ({ call }) => {
      const result = await call("whoami");
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.authenticated, false);
      assert.match(text(result), /rejected: This API token has expired[\s\S]*appdropper login/);
    });
  });

  test("whoami with no credential says how to sign in", async () => {
    await withServer({}, async ({ api, call }) => {
      const result = await call("whoami");
      assert.equal(result.structuredContent.authenticated, false);
      assert.equal(result.structuredContent.credential_source, "none");
      assert.match(text(result), /appdropper login/);
      assert.equal(api.requests.length, 0);
    }, { token: null });
  });
});
