// Drives the MCP server against LIVE production App Dropper with a throwaway
// account, then deletes everything it created. Not shipped (outside `files`).
//
//   MCP_SERVER_BIN=/path/to/node_modules/.bin/appdropper-mcp node scripts/e2e-production.mjs
//
// Needs Google application-default credentials for project `app-dropper`
// (the same setup as app-dropper-web/functions/test/cli-e2e.js).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// The folder holding app-dropper-web next to this repo.
const ROOT = process.env.APPDROPPER_WORKSPACE ?? path.resolve(import.meta.dirname, "../..");
const FN = `${ROOT}/app-dropper-web/functions`;
const require = createRequire(import.meta.url);
process.env.GOOGLE_CLOUD_PROJECT = "app-dropper";
const admin = require(`${FN}/node_modules/firebase-admin/lib/index.js`);
admin.initializeApp({ projectId: "app-dropper" });
const db = admin.firestore();
const KEY = fs
  .readFileSync(`${ROOT}/app-dropper-web/.env.local`, "utf8")
  .match(/NEXT_PUBLIC_FIREBASE_API_KEY=(.+)/)[1]
  .trim();
const APK = `${FN}/test/test-app.apk`; // F-Droid 1.23.2, org.fdroid.fdroid
const SERVER = process.env.MCP_SERVER_BIN ?? path.resolve(import.meta.dirname, "../dist/index.js");

let pass = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
};
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function connect(env, cwd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adp-e2e-home-"));
  const transport = new StdioClientTransport({
    command: SERVER.endsWith(".js") ? process.execPath : SERVER,
    args: SERVER.endsWith(".js") ? [SERVER] : [],
    cwd,
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: home, APPDROPPER_CONFIG_DIR: home, ...env },
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const client = new Client({ name: "appdropper-e2e", version: "0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

const stamp = Date.now();
const email = `mcp-e2e-${stamp}@appdropper-e2e.dev`;
const shareId = `mcp${stamp.toString(36)}`;
const slug = `mcp-e2e-${stamp.toString(36)}`;
const projectRef = db.collection("projects").doc();
const project = fs.mkdtempSync(path.join(os.tmpdir(), "adp-e2e-project-"));
let uid;

try {
  const signUp = await (
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: `Pw!${stamp}zZ`, returnSecureToken: true }),
    })
  ).json();
  uid = signUp.localId;
  if (!uid) throw new Error(`signUp failed: ${JSON.stringify(signUp)}`);
  await db.collection("users").doc(uid).set({ uid, email, name: "MCP E2E", emailVerified: true, avatarUrl: "", udid: "" });
  await projectRef.set({
    name: "MCP E2E App", bundleId: "org.fdroid.fdroid", ownerId: uid, platform: "android",
    createdAt: admin.firestore.FieldValue.serverTimestamp(), memberCount: 1, shareId, slug, shareAccess: "public", buildCount: 0,
  });
  await projectRef.collection("members").doc(uid).set({
    uid, role: "manager", name: "MCP E2E", email, avatarUrl: "", udid: "", joinedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("shares").doc(shareId).set({
    projectId: projectRef.id, ownerId: uid, access: "public", appName: "MCP E2E App", iconUrl: "", platform: "android",
    bundleId: "org.fdroid.fdroid", slug, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("slugs").doc(slug).set({ shareId, projectId: projectRef.id });

  const minted = await (
    await fetch("https://us-central1-app-dropper.cloudfunctions.net/createApiToken", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signUp.idToken}` },
      body: JSON.stringify({ data: { projectIds: [projectRef.id], name: "MCP E2E", expiresInDays: 1 } }),
    })
  ).json();
  const TOKEN = minted.result.token;

  // A Flutter-shaped project with the real APK in two places.
  const flutterApk = path.join(project, "build/app/outputs/flutter-apk/app-release.apk");
  const spacedApk = path.join(project, "My Builds/F Droid release.apk");
  for (const file of [flutterApk, spacedApk]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(APK, file);
  }
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(spacedApk, old, old);

  console.log(`\n=== @appdropper/mcp against live production (${SERVER}) ===`);
  const s = await connect({ APPDROPPER_TOKEN: TOKEN, CLAUDE_PROJECT_DIR: project }, project);

  const who = await s.client.callTool({ name: "whoami", arguments: {} });
  check("whoami: authenticated, from APPDROPPER_TOKEN, covers the app",
    who.structuredContent?.authenticated === true &&
      who.structuredContent.credential_source === "APPDROPPER_TOKEN" &&
      who.structuredContent.apps?.[0]?.app_name === "MCP E2E App",
    text(who));

  const apps = await s.client.callTool({ name: "list_apps", arguments: {} });
  check("list_apps returns the app ID", apps.structuredContent?.apps?.[0]?.app_id === projectRef.id, text(apps));

  const found = await s.client.callTool({ name: "find_builds", arguments: { platform: "android" } });
  check("find_builds (default dir) finds the Flutter release APK first",
    found.structuredContent?.builds?.[0]?.path === fs.realpathSync(flutterApk) &&
      found.structuredContent.builds[0].variant === "release" &&
      found.structuredContent.total_found === 2,
    text(found));

  const started = Date.now();
  const up = await s.client.callTool({
    name: "upload_build",
    arguments: { file_path: "My Builds/F Droid release.apk", release_notes: "Fix login crash (MCP e2e)", tag: "mcp" },
  });
  const r = up.structuredContent ?? {};
  check("upload_build (relative path with spaces) succeeds", !up.isError, text(up));
  console.log(`      took ${((Date.now() - started) / 1000).toFixed(1)}s · ${text(up).split("\n")[0]}`);
  check("version, build number and bundle ID come from the binary",
    r.version === "1.23.2" && r.bundle_id === "org.fdroid.fdroid" && r.platform === "android" && !!r.build_number,
    JSON.stringify(r));
  check("install URL and QR URL are App Dropper URLs",
    /^https:\/\/appdropper\.io\/\S+\?build=/.test(r.install_url ?? "") && /^https:\/\/appdropper\.io\/api\/v1\/qr\//.test(r.qr_url ?? ""),
    `${r.install_url} ${r.qr_url}`);

  const page = await fetch(r.install_url);
  const html = await page.text();
  check("the install URL serves a live page for this app", page.status === 200 && html.includes("MCP E2E App"), `HTTP ${page.status}`);
  const qr = await fetch(r.qr_url);
  check("the QR URL serves a PNG", qr.status === 200 && qr.headers.get("content-type") === "image/png", `HTTP ${qr.status}`);

  const buildDoc = await projectRef.collection("builds").doc(r.build_id).get();
  check("the build exists in Firestore with the notes and tag",
    buildDoc.exists && buildDoc.get("releaseNotes") === "Fix login crash (MCP e2e)" && buildDoc.get("tag") === "mcp" && !buildDoc.get("ci"),
    buildDoc.exists ? JSON.stringify({ notes: buildDoc.get("releaseNotes"), tag: buildDoc.get("tag"), ci: buildDoc.get("ci") }) : "missing");

  const up2 = await s.client.callTool({ name: "upload_build", arguments: { file_path: flutterApk } });
  check("upload_build (absolute path) succeeds", !up2.isError, text(up2));

  const list = await s.client.callTool({ name: "list_builds", arguments: { app_id: projectRef.id, limit: 5 } });
  const ids = list.structuredContent?.builds?.map((b) => b.build_id) ?? [];
  check("list_builds shows both, newest first",
    ids.length === 2 && ids[0] === up2.structuredContent?.build_id && ids[1] === r.build_id, text(list));

  const one = await s.client.callTool({ name: "get_build", arguments: { build_id: r.build_id } });
  check("get_build returns the release notes and install URL",
    one.structuredContent?.release_notes === "Fix login crash (MCP e2e)" && one.structuredContent.install_url === r.install_url,
    text(one));

  const txt = path.join(project, "notes.txt");
  fs.writeFileSync(txt, "hello");
  const bad = await s.client.callTool({ name: "upload_build", arguments: { file_path: txt } });
  check("a .txt is refused locally", bad.isError === true && /unsupported_file_type/.test(text(bad)), text(bad));
  const missing = await s.client.callTool({ name: "get_build", arguments: { build_id: "doesNotExist123" } });
  check("an unknown build is a clean not_found (HTTP 404)", missing.isError === true && /not_found, HTTP 404/.test(text(missing)), text(missing));
  check("no token in the server's stderr", !s.stderr().includes(TOKEN.split("_")[2]));
  await s.close();

  const revoked = await connect({ APPDROPPER_TOKEN: `adp_${minted.result.tokenId}_${"x".repeat(32)}` }, project);
  const deny = await revoked.client.callTool({ name: "upload_build", arguments: { file_path: flutterApk } });
  check("a bad token gets an actionable 401", deny.isError === true && /unauthorized, HTTP 401[\s\S]*/.test(text(deny)) && /appdropper login/.test(text(deny)), text(deny));
  const who2 = await revoked.client.callTool({ name: "whoami", arguments: {} });
  check("whoami reports the rejected credential", who2.structuredContent?.authenticated === false, text(who2));
  await revoked.close();
} catch (err) {
  console.error("HARNESS ERROR:", err);
  failures.push("harness");
} finally {
  const bucket = admin.storage().bucket("app-dropper.firebasestorage.app");
  await bucket.deleteFiles({ prefix: `builds/${projectRef.id}/`, force: true }).catch(() => {});
  await bucket.deleteFiles({ prefix: `icons/${projectRef.id}/`, force: true }).catch(() => {});
  if (uid) await bucket.deleteFiles({ prefix: `uploads/${uid}/`, force: true }).catch(() => {});
  await db.recursiveDelete(projectRef).catch(() => {});
  await db.collection("shares").doc(shareId).delete().catch(() => {});
  await db.collection("slugs").doc(slug).delete().catch(() => {});
  if (uid) {
    await db.collection("users").doc(uid).delete().catch(() => {});
    await db.collection("rateLimits").doc(`upload_${uid}`).delete().catch(() => {});
    for (const coll of ["apiTokens", "uploads"]) {
      const docs = await db.collection(coll).where("uid", "==", uid).get();
      await Promise.all(docs.docs.map((d) => d.ref.delete()));
    }
    await admin.auth().deleteUser(uid).catch(() => {});
  }
  fs.rmSync(project, { recursive: true, force: true });
  console.log("  cleaned up");
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}
