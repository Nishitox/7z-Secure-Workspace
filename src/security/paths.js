"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function parentUri(uri) {
  const rel = normalizeFsPath(uri.path);
  if (!rel) return uri.with({ path: "/" });
  const i = rel.lastIndexOf("/");
  const parent = i >= 0 ? rel.slice(0, i) : "";
  return uri.with({ path: parent ? `/${parent}` : "/" });
}

function normalizeFsPath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeArchivePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function validateVirtualPath(relPath) {
  if (!relPath) return "";

  if (
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(relPath)
  ) {
    throw new Error(`Unsafe absolute archive path: ${relPath}`);
  }

  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`Unsafe archive path segment: ${relPath}`);
    }
    if (part.includes("\0")) {
      throw new Error("NUL is not allowed in archive paths.");
    }
  }

  return relPath;
}

function validateArchiveEntries(entries) {
  const seen = new Map();

  for (const entry of entries) {
    if (typeof entry.path !== "string") {
      throw new Error("Archive contains an entry with a non-string path.");
    }

    const raw = entry.path;
    if (raw.includes("\0")) {
      throw new Error("Archive contains NUL in an item path.");
    }

    // Keep leading separators visible until after validation.
    const separated = raw.replace(/\\/g, "/");

    if (
      separated.startsWith("/") ||
      /^[A-Za-z]:/.test(separated)
    ) {
      throw new Error(
        `Archive contains an absolute/drive path: ${raw}`
      );
    }

    const clean = separated.replace(/\/+$/g, "");
    if (!clean) {
      throw new Error("Archive contains an empty/root item path.");
    }

    const parts = clean.split("/");
    for (const part of parts) {
      if (!part || part === "." || part === "..") {
        throw new Error(`Archive contains an unsafe path: ${raw}`);
      }
    }

    // Do not guess which item to edit when two raw paths collapse onto one
    // virtual path (for example slash/backslash variants or duplicates).
    if (seen.has(clean)) {
      throw new Error(
        `Archive contains duplicate/colliding item paths: ${raw}`
      );
    }

    seen.set(
      clean,
      entry.isDirectory
        ? vscode.FileType.Directory
        : vscode.FileType.File
    );
  }

  // Reject "file" + "file/child" ambiguity.
  for (const [clean] of seen) {
    const parts = clean.split("/");
    let prefix = "";

    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (seen.get(prefix) === vscode.FileType.File) {
        throw new Error(
          `Archive contains a file/directory path collision at: ${prefix}`
        );
      }
    }
  }
}


const WINDOWS_RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function validateMaterializableEntries(entries) {
  // Materialized mode targets the local Windows filesystem. Archive paths that
  // are valid inside 7z can still be impossible or ambiguous on Windows, so
  // reject them before writing any plaintext working copy.
  validateArchiveEntries(entries);

  const caseFolded = new Map();

  for (const entry of entries) {
    const clean = entry.path
      .replace(/\\/g, "/")
      .replace(/\/+$/g, "");
    const parts = clean.split("/");

    for (const part of parts) {
      if (/[<>:"|?*]/.test(part)) {
        throw new Error(
          `Archive path cannot be materialized on Windows: ${entry.path}`
        );
      }
      if (/[ .]$/.test(part)) {
        throw new Error(
          `Archive path has a Windows-ambiguous trailing dot/space: ${entry.path}`
        );
      }
      if (WINDOWS_RESERVED_BASENAMES.test(part)) {
        throw new Error(
          `Archive path uses a reserved Windows filename: ${entry.path}`
        );
      }
    }

    const folded = clean.toLocaleLowerCase("en-US");
    const previous = caseFolded.get(folded);
    if (previous && previous !== clean) {
      throw new Error(
        `Archive paths collide on the Windows filesystem: ${previous} / ${clean}`
      );
    }
    caseFolded.set(folded, clean);
  }
}

function sameWindowsPath(a, b) {
  return path.resolve(a).toLocaleLowerCase("en-US") ===
    path.resolve(b).toLocaleLowerCase("en-US");
}

function isPathWithinDirectory(rootPath, candidatePath) {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(candidatePath)
  );

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}


function isMaterializedGitLockPath(relPath) {
  const parts = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);

  const gitIndex = parts.findIndex(
    (part) => part.toLowerCase() === ".git"
  );

  if (gitIndex < 0 || gitIndex >= parts.length - 1) {
    return false;
  }

  return parts[parts.length - 1]
    .toLowerCase()
    .endsWith(".lock");
}

class MaterializedGitBusyError extends Error {
  constructor(relPath) {
    super(
      `Git appears to be updating repository metadata (${relPath}). ` +
      "Materialized archive sync will retry after the lock disappears."
    );
    this.name = "MaterializedGitBusyError";
    this.relPath = relPath;
  }
}

async function sha256DiskFile(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
}

async function scanMaterializedWorkingTree(rootPath) {
  const entries = [];

  async function walk(relativeDir) {
    const absoluteDir = relativeDir
      ? path.join(rootPath, ...relativeDir.split("/"))
      : rootPath;
    const children = await fs.promises.readdir(
      absoluteDir,
      { withFileTypes: true }
    );

    for (const child of children) {
      const relPath = relativeDir
        ? `${relativeDir}/${child.name}`
        : child.name;

      const absolutePath = path.join(absoluteDir, child.name);
      const stat = await fs.promises.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        throw new Error(
          `Materialized sync does not follow symbolic links or junctions: ${relPath}`
        );
      }

      if (stat.isDirectory()) {
        entries.push({
          path: relPath,
          isDirectory: true,
          size: 0,
          absolutePath
        });
        await walk(relPath);
        continue;
      }

      if (!stat.isFile()) {
        throw new Error(
          `Materialized sync only supports regular files/directories: ${relPath}`
        );
      }

      entries.push({
        path: relPath,
        isDirectory: false,
        size: stat.size,
        absolutePath
      });
    }
  }

  await walk("");

  validateArchiveEntries(
    entries.map((entry) => ({
      path: entry.path,
      isDirectory: entry.isDirectory
    }))
  );

  return entries;
}

function filterTopmostDeletedPaths(paths) {
  const set = new Set(paths);
  return [...set]
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .filter((candidate) => {
      const parts = candidate.split("/");
      let prefix = "";
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        if (set.has(prefix)) return false;
      }
      return true;
    });
}


module.exports = {
  parentUri,
  normalizeFsPath,
  normalizeArchivePath,
  validateVirtualPath,
  validateArchiveEntries,
  WINDOWS_RESERVED_BASENAMES,
  validateMaterializableEntries,
  sameWindowsPath,
  isPathWithinDirectory,
  isMaterializedGitLockPath,
  MaterializedGitBusyError,
  sha256DiskFile,
  sha256Bytes,
  scanMaterializedWorkingTree,
  filterTopmostDeletedPaths
};
