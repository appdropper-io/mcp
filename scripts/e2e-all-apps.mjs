// LIVE production check of "all apps" tokens: a brand-new account with no
// apps mints an all-apps token, and its first upload_build creates the app.
// Cleans up everything it creates. Same prerequisites as e2e-production.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = process.env.APPDROPPER_WORKSPACE ?? path.resolve(import.meta.dirname, "../..");
const FN = `${ROOT}/app-dropper-web/functions`;
const require = createRequire(import.meta.url);
process.env.GOOGLE_CLOUD_PROJECT = "app-dropper";
const admin = require(`${FN}/node_modules/firebase-admin/lib/index.js`);
admin.initializeApp({ projectId: "app-dropper" });
const db = admin.firestore();
const KEY = fs.readFileSync(`${ROOT}/app-dropper-web/.env.local`, "utf8").match(/NEXT_PUBLIC_FIREBASE_API_KEY=(.+)/)[1].trim();
const APK = `${FN}/test/test-app.apk`;
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

const stamp = Date.now();
let uid;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "adp-allapps-"));
try {
  const signUp = await (
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `mcp-allapps-${stamp}@appdropper-e2e.dev`, password: `Pw!${stamp}zZ`, returnSecureToken: true }),
    })
  ).json();
  uid = signUp.localId;
  await db.collection("users").doc(uid).set({ uid, email: `mcp-allapps-${stamp}@appdropper-e2e.dev`, name: "All Apps E2E", emailVerified: true });

  const minted = await (
    await fetch("https://us-central1-app-dropper.cloudfunctions.net/createApiToken", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signUp.idToken}` },
      body: JSON.stringify({ data: { allApps: true, name: "All apps E2E", expiresInDays: 1 } }),
    })
  ).json();
  console.log("\n=== all-apps tokens against live production ===");
  check("an account with no apps can mint an all-apps token", minted.result?.allApps === true, JSON.stringify(minted));
  const TOKEN = minted.result.token;

  const transport = new StdioClientTransport({
    command: SERVER.endsWith(".js") ? process.execPath : SERVER,
    args: SERVER.endsWith(".js") ? [SERVER] : [],
    cwd: home,
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: home, APPDROPPER_CONFIG_DIR: home, APPDROPPER_TOKEN: TOKEN },
  });
  const client = new Client({ name: "allapps-e2e", version: "0" });
  await client.connect(transport);

  const who = await client.callTool({ name: "whoami", arguments: {} });
  check("whoami reports all apps and zero apps today",
    who.structuredContent?.all_apps === true && who.structuredContent.apps.length === 0, text(who));

  const up = await client.callTool({ name: "upload_build", arguments: { file_path: APK, release_notes: "First build" } });
  check("the first upload of a new bundle ID creates the app", !up.isError && up.structuredContent?.bundle_id === "org.fdroid.fdroid", text(up));
  const page = up.structuredContent?.install_url ? await fetch(up.structuredContent.install_url) : { status: 0 };
  check("its install page is live", page.status === 200, `HTTP ${page.status}`);

  const apps = await client.callTool({ name: "list_apps", arguments: {} });
  check("list_apps now shows the new app", apps.structuredContent?.apps?.length === 1, text(apps));

  const again = await client.callTool({ name: "upload_build", arguments: { file_path: APK } });
  const projects = await db.collection("projects").where("ownerId", "==", uid).get();
  check("a second upload joins the same app", !again.isError && projects.size === 1, `${projects.size} projects; ${text(again)}`);
  await client.close();
} catch (err) {
  console.error("HARNESS ERROR:", err);
  failures.push("harness");
} finally {
  if (uid) {
    const bucket = admin.storage().bucket("app-dropper.firebasestorage.app");
    const projects = await db.collection("projects").where("ownerId", "==", uid).get();
    for (const p of projects.docs) {
      await bucket.deleteFiles({ prefix: `builds/${p.id}/`, force: true }).catch(() => {});
      await bucket.deleteFiles({ prefix: `icons/${p.id}/`, force: true }).catch(() => {});
      const shareId = p.get("shareId");
      const slug = p.get("slug");
      await db.recursiveDelete(p.ref).catch(() => {});
      if (shareId) await db.collection("shares").doc(shareId).delete().catch(() => {});
      if (slug) await db.collection("slugs").doc(slug).delete().catch(() => {});
    }
    await bucket.deleteFiles({ prefix: `uploads/${uid}/`, force: true }).catch(() => {});
    await db.collection("users").doc(uid).delete().catch(() => {});
    await db.collection("rateLimits").doc(`upload_${uid}`).delete().catch(() => {});
    for (const coll of ["apiTokens", "uploads"]) {
      const docs = await db.collection(coll).where("uid", "==", uid).get();
      await Promise.all(docs.docs.map((d) => d.ref.delete()));
    }
    await admin.auth().deleteUser(uid).catch(() => {});
  }
  fs.rmSync(home, { recursive: true, force: true });
  console.log("  cleaned up");
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}
