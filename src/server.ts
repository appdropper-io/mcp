import { createRequire } from "node:module";
import * as path from "node:path";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  AppDropperClient,
  apiUrl,
  inspectBuildFile,
  resolveTokenWithSource,
  uploadBuild,
  type BuildDetail,
  type BuildSummary,
  type TokenIdentity,
  type UploadPhase,
} from "appdropper/api";
import { defaultSearchDirectory, findBuilds } from "./discovery.js";
import {
  LocalInputError,
  LOGIN_HINT,
  NotAuthenticatedError,
  failureText,
  toFailure,
} from "./errors.js";
import { log } from "./log.js";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;
const CLI_VERSION: string = (() => {
  try {
    return require("appdropper/package.json").version as string;
  } catch {
    return "unknown";
  }
})();

/** Limits the App Dropper API enforces; checked here so a bad call fails fast. */
const MAX_RELEASE_NOTES = 4000;
const MAX_TAG = 40;
/** Firestore document IDs, plus `self` for a token that covers one app. */
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Must be an App Dropper ID, as returned by list_apps or list_builds.");

export interface ServerOptions {
  /** Base for relative paths and the default search directory. */
  cwd?: string;
  /**
   * How long upload_build waits for processing. Defaults to
   * APPDROPPER_MCP_TIMEOUT (seconds), then 10 minutes.
   */
  processingTimeoutMs?: number;
}

const INSTRUCTIONS = `App Dropper hosts Android (.apk) and iOS (.ipa) test builds and gives each one an install link for testers.

Typical flow: if you don't already know where the build is, call find_builds with the project directory, pick the newest artifact matching what the user asked for (release vs debug, Android vs iOS), then call upload_build with its absolute path. Relay the install URL from the result to the user.

upload_build publishes the build to the app's testers and notifies them by email and push, so only call it when the user asked to upload, share, send or distribute a build. Never upload a file the user didn't ask for, and never upload more than one build per request unless asked.

App Dropper does not sign or re-sign apps. An .ipa must already be signed with a provisioning profile that includes the testers' devices (ad hoc or enterprise) to install.`;

/** Creates the App Dropper MCP server. One instance serves one connection. */
export function createServer(options: ServerOptions = {}): McpServer {
  const env = process.env;
  const cwd = options.cwd ?? process.cwd();
  const timeoutSeconds = Number(env.APPDROPPER_MCP_TIMEOUT);
  const processingTimeoutMs =
    options.processingTimeoutMs ??
    (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined);
  const userAgent = `appdropper-mcp/${VERSION} appdropper/${CLI_VERSION} node/${process.versions.node}`;

  const server = new McpServer(
    { name: "appdropper", title: "App Dropper", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  /**
   * A client for one tool call. The credential is re-read every call, so a
   * user who runs `appdropper login` after the editor started doesn't have to
   * restart anything.
   */
  const clientFor = (ctx: ServerContext) => {
    const base = apiUrl();
    const credential = resolveTokenWithSource(base);
    if (!credential) throw new NotAuthenticatedError();
    return {
      base,
      source: credential.source,
      client: new AppDropperClient(base, credential.token, {
        userAgent,
        signal: ctx.mcpReq.signal,
      }),
    };
  };

  // ---------------------------------------------------------- upload_build

  server.registerTool(
    "upload_build",
    {
      title: "Upload build to App Dropper",
      description:
        "Upload a local Android .apk or iOS .ipa to App Dropper, wait for it to be processed, and return the app name, version, build number and the tester install URL. " +
        "Use when the user asks to upload, share, send or distribute a mobile build to testers. " +
        "Side effects: sends the file to App Dropper, publishes it as the newest build of its app (matched by bundle ID; a new bundle ID creates a new app when the token allows it), and notifies that app's testers by email and push. " +
        "Takes from a few seconds to several minutes for large builds. If the path is unknown, call find_builds first. Does not build, sign or re-sign the app.",
      inputSchema: z.object({
        file_path: z
          .string()
          .min(1)
          .max(4096)
          .describe(
            "Path to the .apk or .ipa on this machine. Prefer an absolute path; a relative path is resolved against the project directory. Local paths only — URLs are rejected."
          ),
        release_notes: z
          .string()
          .max(MAX_RELEASE_NOTES)
          .optional()
          .describe(
            "What changed, shown to testers on the install page and in the notification email. E.g. the latest commit message."
          ),
        tag: z
          .string()
          .max(MAX_TAG)
          .optional()
          .describe('Short label for the build, e.g. "beta", "nightly" or "qa". Defaults to "beta".'),
      }),
      outputSchema: z.object({
        status: z.literal("ready"),
        app_name: z.string(),
        app_id: z.string(),
        platform: z.string(),
        version: z.string(),
        build_number: z.string(),
        bundle_id: z.string(),
        build_id: z.string(),
        install_url: z.string(),
        qr_url: z.string(),
        expires_at: z.string().optional(),
        file_name: z.string(),
        size_bytes: z.number(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ file_path, release_notes, tag }, ctx) => {
      try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file_path) || /^file:/i.test(file_path)) {
          throw new LocalInputError(
            "invalid_path",
            "file_path must be a path on this machine, not a URL.",
            "Download or build the file locally first, then pass its path."
          );
        }
        const file = inspectBuildFile(file_path, projectDir(env, cwd));
        const { client } = clientFor(ctx);
        const progress = progressReporter(ctx, file.fileName);

        log(`Uploading ${file.fileName} (${file.size} bytes)`);
        const result = await uploadBuild({
          client,
          file,
          releaseNotes: release_notes,
          tag,
          // Left unset on purpose. The API's `ci` field describes a pipeline
          // run, and an upload from an editor isn't one.
          ci: undefined,
          timeoutMs: processingTimeoutMs,
          signal: ctx.mcpReq.signal,
          userAgent,
          onPhase: progress.phase,
          onProgress: progress.bytes,
        });
        log(`Uploaded ${file.fileName} as build ${result.build_id}`);

        const output = {
          status: "ready" as const,
          app_name: result.app_name ?? "",
          app_id: result.app_id ?? "",
          platform: result.platform ?? file.platform,
          version: result.version ?? "",
          build_number: result.build_number ?? "",
          bundle_id: result.bundle_id ?? "",
          build_id: result.build_id,
          install_url: result.install_url,
          qr_url: result.qr_url ?? "",
          expires_at: iso(result.expires_at),
          file_name: file.fileName,
          size_bytes: file.size,
        };
        return ok(
          [
            `${output.app_name} ${versionLabel(output)} uploaded to App Dropper.`,
            `Install: ${output.install_url}`,
            output.qr_url ? `QR code: ${output.qr_url}` : "",
            `Platform: ${platformName(output.platform)} · Bundle ID: ${output.bundle_id} · Build ID: ${output.build_id}`,
            output.expires_at ? `Expires: ${output.expires_at}` : "",
            "The app's testers have been notified.",
          ],
          output
        );
      } catch (err) {
        return fail("Upload failed", err);
      }
    }
  );

  // ----------------------------------------------------------- find_builds

  server.registerTool(
    "find_builds",
    {
      title: "Find APK and IPA builds",
      description:
        "Search a project directory for Android .apk and iOS .ipa build artifacts, newest first, with size, modification time, platform and release/debug variant. " +
        "Read-only: nothing is uploaded. Use when the user wants to upload 'the latest build' and you don't know the output path. " +
        "Skips dependency and hidden folders (node_modules, Pods, .git, .dart_tool, .gradle…) and never follows symlinks.",
      inputSchema: z.object({
        directory: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe(
            "Absolute path of the project to search. Defaults to the project the editor opened; pass it explicitly if you know it."
          ),
        platform: z
          .enum(["android", "ios", "any"])
          .optional()
          .describe('"android" for .apk, "ios" for .ipa, "any" for both (default).'),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 10)."),
      }),
      outputSchema: z.object({
        directory: z.string(),
        total_found: z.number(),
        truncated: z.boolean(),
        builds: z.array(
          z.object({
            path: z.string(),
            file_name: z.string(),
            platform: z.enum(["android", "ios"]),
            variant: z.enum(["release", "debug", "profile"]).nullable(),
            size_bytes: z.number(),
            modified_at: z.string(),
          })
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ directory, platform, limit }) => {
      try {
        const root = directory
          ? path.resolve(projectDir(env, cwd), directory)
          : defaultSearchDirectory(env, cwd);
        const result = await findBuilds({
          directory: root,
          platform: platform ?? "any",
          limit: limit ?? 10,
        });
        const lines =
          result.builds.length === 0
            ? [
                `No ${platform && platform !== "any" ? (platform === "ios" ? ".ipa " : ".apk ") : ".apk or .ipa "}files found under ${result.directory}.`,
                "Build the app first (e.g. `flutter build apk --release`, `./gradlew assembleRelease`, or an Xcode archive exported as an .ipa).",
              ]
            : [
                `Found ${result.total_found} build${result.total_found === 1 ? "" : "s"} under ${result.directory}${
                  result.total_found > result.builds.length ? ` (showing newest ${result.builds.length})` : ""
                }:`,
                ...result.builds.map(
                  (b) =>
                    `- ${b.path} — ${platformName(b.platform)}${b.variant ? ` ${b.variant}` : ""}, ${formatBytes(
                      b.size_bytes
                    )}, modified ${b.modified_at}`
                ),
              ];
        if (result.truncated) lines.push("The project is large; the deepest folders were not searched. Pass a narrower directory if a build is missing.");
        return ok(lines, { ...result });
      } catch (err) {
        return fail("Search failed", err);
      }
    }
  );

  // ------------------------------------------------------------- list_apps

  server.registerTool(
    "list_apps",
    {
      title: "List App Dropper apps",
      description:
        "List the App Dropper apps the configured token can upload to, with their app IDs, bundle IDs and public install pages. " +
        "Use to answer which apps are available, or to get an app_id for list_builds. Read-only.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        all_apps: z.boolean(),
        apps: z.array(appSchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, ctx) => {
      try {
        const identity = await clientFor(ctx).client.listApps();
        const output = { all_apps: identity.all_apps === true, apps: identity.apps.map(appOut) };
        return ok(
          [
            output.all_apps
              ? `This token covers all apps on the account, including new ones. ${output.apps.length} app${output.apps.length === 1 ? "" : "s"} today:`
              : `This token can upload to ${output.apps.length} app${output.apps.length === 1 ? "" : "s"}:`,
            ...output.apps.map((a) => `- ${a.app_name} (${a.bundle_id || "no bundle ID yet"}) — app_id ${a.app_id} — ${a.install_url}`),
            output.apps.length === 0 && output.all_apps
              ? "No apps yet. The first upload_build creates the app from the build's bundle ID."
              : "",
          ],
          output
        );
      } catch (err) {
        return fail("Couldn't list apps", err);
      }
    }
  );

  // ----------------------------------------------------------- list_builds

  server.registerTool(
    "list_builds",
    {
      title: "List recent builds",
      description:
        "List an App Dropper app's most recent builds, newest first, with version, build number, platform, upload date, status and install URL. " +
        "Use for questions like 'what were the last builds I sent' or to find a previous install link. Read-only.",
      inputSchema: z.object({
        app_id: ID.optional().describe(
          "The app, from list_apps. May be omitted only when the token covers exactly one app."
        ),
        limit: z.number().int().min(1).max(50).optional().describe("How many builds (default 10)."),
      }),
      outputSchema: z.object({
        app_id: z.string(),
        app_name: z.string(),
        bundle_id: z.string(),
        builds: z.array(buildSummarySchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app_id, limit }, ctx) => {
      try {
        const result = await clientFor(ctx).client.listBuilds(app_id ?? "self", limit ?? 10);
        const output = {
          app_id: result.app_id ?? app_id ?? "",
          app_name: result.app_name,
          bundle_id: result.bundle_id,
          builds: result.builds.map(buildOut),
        };
        return ok(
          [
            output.builds.length === 0
              ? `${output.app_name} has no builds yet.`
              : `Latest ${output.builds.length} build${output.builds.length === 1 ? "" : "s"} of ${output.app_name} (${output.bundle_id}):`,
            ...output.builds.map(
              (b) =>
                `- ${versionLabel(b)} · ${platformName(b.platform)} · ${b.uploaded_at ?? "unknown date"} · ${
                  b.expired ? "expired" : b.status || "ready"
                } · build_id ${b.build_id} · ${b.install_url}`
            ),
          ],
          output
        );
      } catch (err) {
        return fail("Couldn't list builds", err);
      }
    }
  );

  // ------------------------------------------------------------- get_build

  server.registerTool(
    "get_build",
    {
      title: "Get one build",
      description:
        "Get one App Dropper build by its build_id: app, version, build number, platform, release notes, upload and expiry dates, install count, install URL and QR code URL. Read-only.",
      inputSchema: z.object({
        build_id: ID.describe("The build, from upload_build or list_builds."),
        app_id: ID.optional().describe("The app it belongs to, if known. Speeds up the lookup."),
      }),
      outputSchema: buildSummarySchema.extend({
        app_id: z.string(),
        app_name: z.string(),
        bundle_id: z.string(),
        release_notes: z.string(),
        min_os_version: z.string(),
        qr_url: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ build_id, app_id }, ctx) => {
      try {
        const build = await clientFor(ctx).client.getBuild(build_id, app_id);
        const output = {
          ...buildOut(build),
          app_id: build.app_id,
          app_name: build.app_name,
          bundle_id: build.bundle_id,
          release_notes: build.release_notes ?? "",
          min_os_version: build.min_os_version ?? "",
          qr_url: build.qr_url ?? "",
        };
        return ok(
          [
            `${output.app_name} ${versionLabel(output)} (${platformName(output.platform)}, ${output.bundle_id})`,
            `Install: ${output.install_url}`,
            output.qr_url ? `QR code: ${output.qr_url}` : "",
            `Uploaded: ${output.uploaded_at ?? "unknown"} · ${output.expired ? "Expired" : `Expires: ${output.expires_at ?? "never"}`} · Installs: ${output.install_count}`,
            output.release_notes ? `Release notes: ${output.release_notes}` : "",
          ],
          output
        );
      } catch (err) {
        return fail("Couldn't get the build", err);
      }
    }
  );

  // ---------------------------------------------------------------- whoami

  server.registerTool(
    "whoami",
    {
      title: "Check App Dropper sign-in",
      description:
        "Check whether this MCP server is signed in to App Dropper and show the credential's name, where it was found, its expiry and which apps it covers. Never reveals the token. " +
        "Use to debug setup or when another App Dropper tool reports an authentication problem.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        authenticated: z.boolean(),
        api_url: z.string(),
        credential_source: z.enum(["APPDROPPER_TOKEN", "saved login", "none"]),
        problem: z.string().optional(),
        token_name: z.string().optional(),
        token_hint: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        expires_at: z.string().optional(),
        all_apps: z.boolean().optional(),
        apps: z.array(appSchema).optional(),
        server_version: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, ctx) => {
      const base = apiUrl();
      const credential = resolveTokenWithSource(base);
      const common = { api_url: base, server_version: VERSION };
      if (!credential) {
        return ok(
          [`Not signed in to App Dropper (${base}).`, LOGIN_HINT],
          { ...common, authenticated: false, credential_source: "none" as const, problem: "No credential found." }
        );
      }
      const source = credential.source === "APPDROPPER_TOKEN" ? "APPDROPPER_TOKEN" : "saved login";
      try {
        const identity: TokenIdentity = await clientFor(ctx).client.whoami();
        const output = {
          ...common,
          authenticated: true,
          credential_source: source as "APPDROPPER_TOKEN" | "saved login",
          token_name: identity.token_name,
          token_hint: identity.hint,
          scopes: identity.scopes,
          expires_at: iso(identity.expires_at),
          all_apps: identity.all_apps === true,
          apps: identity.apps.map(appOut),
        };
        return ok(
          [
            `Signed in to App Dropper with "${output.token_name}" (${output.token_hint}), from ${source}.`,
            output.all_apps
              ? `Covers all apps, including new ones (${output.apps.length} today).`
              : `Covers ${output.apps.length} app${output.apps.length === 1 ? "" : "s"}: ${output.apps.map((a) => a.app_name).join(", ") || "none"}.`,
            output.expires_at ? `Expires: ${output.expires_at}` : "",
          ],
          output
        );
      } catch (err) {
        const failure = toFailure(err);
        if (failure.code === "unauthorized") {
          return ok(
            [`The App Dropper credential from ${source} was rejected: ${failure.message}`, failure.hint ?? ""],
            { ...common, authenticated: false, credential_source: source, problem: failure.message }
          );
        }
        return fail("Couldn't check the sign-in", err);
      }
    }
  );

  return server;
}

// ----------------------------------------------------------------- helpers

const appSchema = z.object({
  app_id: z.string(),
  app_name: z.string(),
  bundle_id: z.string(),
  install_url: z.string(),
});

const buildSummarySchema = z.object({
  build_id: z.string(),
  version: z.string(),
  build_number: z.string(),
  platform: z.string(),
  tag: z.string(),
  status: z.string(),
  uploaded_at: z.string().optional(),
  expires_at: z.string().optional(),
  expired: z.boolean(),
  install_url: z.string(),
  install_count: z.number(),
  size_bytes: z.number(),
});

function appOut(app: TokenIdentity["apps"][number]) {
  return {
    app_id: app.app_id,
    app_name: app.app_name,
    bundle_id: app.bundle_id ?? "",
    install_url: app.install_url ?? "",
  };
}

function buildOut(build: BuildSummary | BuildDetail) {
  const expired =
    build.files_purged === true || (build.expires_at !== null && build.expires_at < Date.now());
  return {
    build_id: build.build_id,
    version: build.version ?? "",
    build_number: build.build_number ?? "",
    platform: build.platform ?? "",
    tag: build.tag ?? "",
    status: build.status ?? "",
    uploaded_at: iso(build.uploaded_at),
    expires_at: iso(build.expires_at),
    expired,
    install_url: build.install_url,
    install_count: build.install_count ?? 0,
    size_bytes: build.file_size ?? 0,
  };
}

function ok(lines: string[], structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
    structuredContent: structured,
  };
}

/**
 * A failed call, reported as a tool execution error so the model can read it
 * and recover. Deliberately text-only: an error result carries no
 * structuredContent, so it can never be mistaken for a schema-valid success.
 */
function fail(prefix: string, err: unknown): CallToolResult {
  const failure = toFailure(err);
  if (failure.code !== "cancelled") log(`${prefix}: [${failure.code}] ${failure.message}`);
  return { content: [{ type: "text", text: failureText(prefix, failure) }], isError: true };
}

/**
 * Throttled MCP progress for an upload. Only sent when the client asked for
 * it with a progress token; correctness never depends on a client showing it,
 * since the final result always carries the outcome.
 */
function progressReporter(ctx: ServerContext, fileName: string) {
  const token = ctx.mcpReq._meta?.progressToken;
  let last = -1;
  let lastAt = 0;
  const send = (progress: number, message: string, force = false) => {
    if (token === undefined || progress <= last) return;
    const now = Date.now();
    if (!force && now - lastAt < 1000) return;
    last = progress;
    lastAt = now;
    void ctx.mcpReq
      .notify({ method: "notifications/progress", params: { progressToken: token, progress, total: 100, message } })
      .catch(() => {});
  };
  return {
    phase(phase: UploadPhase) {
      if (phase === "reserving") send(1, `Preparing upload of ${fileName}`, true);
      if (phase === "uploading") send(2, `Uploading ${fileName}`, true);
      if (phase === "processing") {
        log("Upload complete; App Dropper is processing the build");
        send(95, "Processing on App Dropper", true);
      }
    },
    bytes(sent: number, total: number) {
      // 2–90 covers the transfer; processing takes the step to 95.
      send(2 + Math.floor((sent / Math.max(total, 1)) * 88), `Uploading ${fileName}: ${formatBytes(sent)} of ${formatBytes(total)}`);
    },
  };
}

function projectDir(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.CLAUDE_PROJECT_DIR?.trim() || cwd;
}

/**
 * An ISO date, or undefined (the field is then omitted) when there is none.
 * Omitted rather than null: a nullable field becomes `type: [..., "null"]` in
 * the advertised schema, which some MCP clients' schema dialects reject.
 */
function iso(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function versionLabel(b: { version: string; build_number: string }): string {
  return `${b.version || "unknown version"}${b.build_number ? ` (${b.build_number})` : ""}`;
}

function platformName(platform: string): string {
  return platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform || "unknown";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
