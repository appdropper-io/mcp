import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUILD_EXTENSIONS, type BuildPlatform } from "appdropper/api";
import { LocalInputError } from "./errors.js";

/**
 * Finds .apk and .ipa files under one directory, newest first. Read-only: it
 * lists names, sizes and dates and never opens a file.
 *
 * Bounded on purpose. It skips dependency and VCS folders, never follows a
 * symlink (so it can't wander outside the directory it was given), and stops
 * after a fixed number of folders, so pointing it at a large monorepo costs
 * a fraction of a second rather than a crawl.
 */

/** Folders that never hold a build worth uploading, at any depth. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "Pods",
  "Carthage",
  "DerivedData",
  "intermediates",
  "tmp",
  "temp",
  "vendor",
  "bower_components",
  "__pycache__",
  "venv",
]);

const MAX_DEPTH = 10;
const MAX_DIRECTORIES = 8000;

export interface FoundBuild {
  path: string;
  file_name: string;
  platform: BuildPlatform;
  /** `release`, `debug` or `profile` when the name or path says so. */
  variant: "release" | "debug" | "profile" | null;
  size_bytes: number;
  modified_at: string;
}

export interface FindBuildsResult {
  directory: string;
  builds: FoundBuild[];
  /** How many matched before `limit` was applied. */
  total_found: number;
  /** True when the folder cap was hit and some of the tree went unsearched. */
  truncated: boolean;
}

export interface FindBuildsOptions {
  directory: string;
  platform: BuildPlatform | "any";
  limit: number;
}

export async function findBuilds(options: FindBuildsOptions): Promise<FindBuildsResult> {
  const root = await checkDirectory(options.directory);
  const wanted = (ext: string): BuildPlatform | null => {
    const platform = BUILD_EXTENSIONS[ext];
    if (!platform) return null;
    return options.platform === "any" || options.platform === platform ? platform : null;
  };

  const found: FoundBuild[] = [];
  let visited = 0;
  let truncated = false;
  // Breadth-first, so the cap trims the deepest corners of a huge tree rather
  // than whole top-level folders.
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (visited >= MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    visited += 1;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable folder: skip it, the rest of the tree still counts.
    }

    for (const entry of entries) {
      // Dirent reports a symlink as a symlink, never as what it points to, so
      // neither linked folders nor linked files are ever followed.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) continue;
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const platform = wanted(path.extname(entry.name).toLowerCase());
      if (!platform) continue;
      try {
        const stats = await fs.stat(full);
        if (stats.size === 0) continue;
        found.push({
          path: full,
          file_name: entry.name,
          platform,
          variant: variantOf(path.relative(root, full)),
          size_bytes: stats.size,
          modified_at: stats.mtime.toISOString(),
        });
      } catch {
        // Vanished between listing and stat — a build tool cleaning up.
      }
    }
  }

  found.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return {
    directory: root,
    builds: found.slice(0, options.limit),
    total_found: found.length,
    truncated,
  };
}

/** Reads the build variant off the path: `flutter-apk/app-release.apk` → release. */
function variantOf(relativePath: string): FoundBuild["variant"] {
  const lower = relativePath.toLowerCase();
  for (const variant of ["release", "debug", "profile"] as const) {
    if (new RegExp(`(^|[^a-z])${variant}([^a-z]|$)`).test(lower)) return variant;
  }
  return null;
}

async function checkDirectory(directory: string): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(directory);
  } catch {
    throw new LocalInputError(
      "invalid_directory",
      `No such directory: ${directory}`,
      "Pass the absolute path of the project you are working in."
    );
  }
  const stats = await fs.stat(real);
  if (!stats.isDirectory()) {
    throw new LocalInputError("invalid_directory", `Not a directory: ${directory}`);
  }
  return real;
}

/**
 * Where to search when the caller doesn't say: the project the editor opened.
 *
 * Claude Code tells its MCP servers via CLAUDE_PROJECT_DIR. Otherwise the
 * process's working directory is used — but never the home directory or the
 * filesystem root, which is where some editors start servers, and scanning
 * either would mean crawling someone's whole disk.
 */
export function defaultSearchDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
  const candidate = env.CLAUDE_PROJECT_DIR?.trim() || cwd;
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    throw new LocalInputError(
      "invalid_directory",
      `The MCP server was started in ${resolved}, which is too broad to search.`,
      "Pass `directory` as the absolute path of the project you are working in."
    );
  }
  return resolved;
}
