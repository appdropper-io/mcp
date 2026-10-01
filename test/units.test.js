// Unit tests for the pieces with the most edge cases: build discovery and
// the mapping from every kind of failure to what the model is told.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AbortError,
  ApiError,
  BuildFileError,
  BuildProcessingError,
  StillProcessingError,
  TransferError,
} from "appdropper/api";
import { defaultSearchDirectory, findBuilds } from "../dist/discovery.js";
import { LocalInputError, NotAuthenticatedError, failureText, toFailure } from "../dist/errors.js";
import { redact } from "../dist/log.js";
import { tmpDir, writeBuild } from "./helpers.js";

describe("findBuilds", () => {
  test("skips dependency, hidden and intermediate folders", async () => {
    const root = tmpDir();
    try {
      writeBuild(path.join(root, "android/app/build/outputs/apk/release/app-release.apk"));
      for (const skipped of [
        "node_modules/some-lib/sample.apk",
        ".git/objects/x.apk",
        ".dart_tool/cache/x.apk",
        ".gradle/x.apk",
        "ios/Pods/Thing/x.ipa",
        "android/app/build/intermediates/apk/x.apk",
      ]) {
        writeBuild(path.join(root, skipped));
      }
      const result = await findBuilds({ directory: root, platform: "any", limit: 50 });
      assert.deepEqual(result.builds.map((b) => path.relative(root, b.path)), [
        "android/app/build/outputs/apk/release/app-release.apk",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("never follows symlinks out of the directory", async () => {
    const root = tmpDir();
    const outside = tmpDir();
    try {
      writeBuild(path.join(outside, "secret.apk"));
      fs.symlinkSync(outside, path.join(root, "linked-dir"));
      fs.symlinkSync(path.join(outside, "secret.apk"), path.join(root, "linked.apk"));
      const result = await findBuilds({ directory: root, platform: "any", limit: 50 });
      assert.equal(result.total_found, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("sorts newest first, applies the limit and reports the total", async () => {
    const root = tmpDir();
    try {
      for (let i = 0; i < 5; i++) {
        const file = writeBuild(path.join(root, `out/app-${i}.apk`));
        const when = new Date(Date.UTC(2026, 0, 1 + i));
        fs.utimesSync(file, when, when);
      }
      const result = await findBuilds({ directory: root, platform: "android", limit: 2 });
      assert.deepEqual(result.builds.map((b) => b.file_name), ["app-4.apk", "app-3.apk"]);
      assert.equal(result.total_found, 5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("infers the variant and ignores empty files", async () => {
    const root = tmpDir();
    try {
      writeBuild(path.join(root, "build/app/outputs/flutter-apk/app-debug.apk"));
      writeBuild(path.join(root, "build/ios/ipa/Runner.ipa"));
      fs.writeFileSync(path.join(root, "half-written.apk"), "");
      const result = await findBuilds({ directory: root, platform: "any", limit: 10 });
      const byName = Object.fromEntries(result.builds.map((b) => [b.file_name, b]));
      assert.equal(byName["app-debug.apk"].variant, "debug");
      assert.equal(byName["Runner.ipa"].variant, null);
      assert.equal(byName["half-written.apk"], undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaultSearchDirectory refuses the home directory and the filesystem root", () => {
    assert.throws(() => defaultSearchDirectory({}, os.homedir()), LocalInputError);
    assert.throws(() => defaultSearchDirectory({}, path.parse(process.cwd()).root), LocalInputError);
    assert.equal(defaultSearchDirectory({ CLAUDE_PROJECT_DIR: "/work/acme" }, os.homedir()), "/work/acme");
    assert.equal(defaultSearchDirectory({}, "/work/acme"), "/work/acme");
  });
});

describe("toFailure", () => {
  const cases = [
    [new NotAuthenticatedError(), "not_authenticated", false],
    [new ApiError(401, "unauthorized", "revoked"), "unauthorized", false],
    [new ApiError(402, "upgrade_required", "Too big. Upgrade to Pro at https://appdropper.io/pricing"), "plan_limit", false],
    [new ApiError(403, "forbidden", "nope"), "forbidden", false],
    [new ApiError(404, "not_found", "No such build."), "not_found", false],
    [new ApiError(429, "rate_limited", "Try again in 3 min."), "rate_limited", true],
    [new ApiError(400, "invalid_request", "bad"), "invalid_request", false],
    [new ApiError(502, "http_error", "Request failed with HTTP 502."), "server_error", true],
    [new BuildFileError("not_found", "No such file: x", "x"), "file_not_found", false],
    [new BuildFileError("unsupported_type", "Only .apk", "x"), "unsupported_file_type", false],
    [new BuildFileError("empty", "empty", "x"), "empty_file", false],
    [new BuildProcessingError("invalid_build", "bad zip", "up1"), "invalid_build", false],
    [new BuildProcessingError("upgrade_required", "app number 6. Upgrade to Pro at https://appdropper.io/pricing", "up1"), "plan_limit", false],
    [new StillProcessingError("up1"), "processing_timeout", false],
    [new TransferError("socket hang up", "up1"), "upload_interrupted", true],
    [new AbortError(), "cancelled", true],
    [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "network_error", true],
    [new Error("The request timed out."), "network_error", true],
  ];
  for (const [err, code, retryable] of cases) {
    test(`${err.constructor.name}${err.status ? ` ${err.status}` : ""} → ${code}`, () => {
      const failure = toFailure(err);
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, retryable);
    });
  }

  test("extracts the upgrade link from a plan-limit message, minus trailing punctuation", () => {
    const failure = toFailure(new ApiError(402, "upgrade_required", "Upgrade to Pro at https://appdropper.io/pricing."));
    assert.equal(failure.upgrade_url, "https://appdropper.io/pricing");
    assert.equal(failure.http_status, 402);
  });

  test("keeps the upgrade link on a 429 that is really a plan's hourly cap", () => {
    const failure = toFailure(
      new ApiError(429, "rate_limited", "Upload limit reached (10 per hour). Try again in 9 min. Upgrade to Pro at https://appdropper.io/pricing")
    );
    assert.equal(failure.code, "rate_limited");
    assert.equal(failure.upgrade_url, "https://appdropper.io/pricing");
  });

  test("never lets a token through, wherever it appears", () => {
    const token = "adp_abc123_ZZZZsecretZZZZsecretZZZZsecret";
    const failure = toFailure(new ApiError(400, "invalid_request", `Bad token ${token} sent`));
    assert.ok(!failure.message.includes("secret"));
    assert.ok(!failureText("x", failure).includes("secret"));
    assert.equal(redact(`Bearer ${token}`), "Bearer adp_[redacted]");
  });

  test("failureText puts the outcome first and the code last", () => {
    const lines = failureText("Upload failed", toFailure(new StillProcessingError("up9"))).split("\n");
    assert.match(lines[0], /^Upload failed: The build uploaded/);
    assert.match(lines.at(-1), /^\(error code: processing_timeout\)$/);
    assert.ok(lines.includes("Upload ID: up9"));
  });
});
