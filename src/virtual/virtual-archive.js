"use strict";

const crypto = require("node:crypto");
const vscode = require("vscode");

const { VIRTUAL_SCHEME } = require("../constants");
const {
  parentUri,
  normalizeFsPath,
  normalizeArchivePath,
  validateVirtualPath,
  validateArchiveEntries
} = require("../security/paths");
const {
  ExternalArchiveChangeError,
  assertArchiveUnchanged,
  isVirtualResourceScheme,
  mutateArchiveTransactionally,
  readStableArchiveState,
  requireVirtualSessionMode,
  sameArchiveFingerprint,
  sessionModeLabel
} = require("../archive/core");


function allocateTemporaryHeaderAnchor(entries) {
  const used = new Set(
    entries.map((entry) =>
      normalizeArchivePath(entry.path)
    )
  );

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate =
      `.__e7z_header_anchor_${crypto.randomBytes(16).toString("hex")}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not allocate a temporary archive member for header encryption."
  );
}

class EntryNode {
  constructor(name, relPath, type) {
    this.name = name;
    this.relPath = relPath;
    this.type = type;
    this.children = new Map();
    this.size = 0;
    this.mtime = Date.now();
    this.ctime = Date.now();
    this.encrypted = undefined;
  }
}

// Virtual filesystem boundary for the non-materialized modes.
//
// Design invariant: archive file contents are read into memory on demand and
// are not intentionally materialized as plaintext files by this provider.
// Mutations are serialized and committed transactionally against the encrypted
// .7z file so a failed edit does not partially replace the original archive.
class VirtualArchiveProvider {
  constructor(output) {
    this.output = output;
    this._onDidChangeFile = new vscode.EventEmitter();
    this.onDidChangeFile = this._onDidChangeFile.event;

    this.archivePath = undefined;
    this.password = undefined;
    this.backend = undefined;
    this.rootUri = undefined;
    this.archiveFingerprint = undefined;
    this.headerEncrypted = undefined;
    this.sessionMode = undefined;

    this._onDidChangeSessionState = new vscode.EventEmitter();
    this.onDidChangeSessionState = this._onDidChangeSessionState.event;

    this.root = new EntryNode("", "", vscode.FileType.Directory);
    this.nodes = new Map([["", this.root]]);
    this.rawEntries = [];

    // No plaintext content cache in Secure Mode.
    this.mutationQueue = Promise.resolve();
  }

  dispose() {
    this._onDidChangeFile.dispose();
    this._onDidChangeSessionState.dispose();
  }

  watch(_uri, _options) {
    return new vscode.Disposable(() => {});
  }

  stat(uri) {
    const node = this.lookup(uri);
    return {
      type: node.type,
      ctime: node.ctime,
      mtime: node.mtime,
      size: node.type === vscode.FileType.File ? node.size : 0
    };
  }

  readDirectory(uri) {
    const node = this.lookup(uri);
    if (node.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    return [...node.children.values()]
      .sort((a, b) => {
        const aDir = a.type === vscode.FileType.Directory;
        const bDir = b.type === vscode.FileType.Directory;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((child) => [child.name, child.type]);
  }

  async readFile(uri) {
    const node = this.lookup(uri);
    if (node.type !== vscode.FileType.File) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    this.ensureSession();

    await assertArchiveUnchanged(
      this.archivePath,
      this.archiveFingerprint,
      this.output,
      "before read"
    );

    const data = await this.backend.read(
      this.archivePath,
      this.password,
      node.relPath
    );

    await assertArchiveUnchanged(
      this.archivePath,
      this.archiveFingerprint,
      this.output,
      "after read"
    );

    return data;
  }

  async writeFile(uri, content, options) {
    this.ensureSession();
    this.ensureUriSession(uri);

    const relPath = validateVirtualPath(normalizeFsPath(uri.path));
    if (!relPath) {
      throw vscode.FileSystemError.NoPermissions("Cannot write the archive root.");
    }

    const existing = this.nodes.get(relPath);

    if (existing && existing.type === vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (existing && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!existing && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const parent = this.getParentNode(relPath);
    if (!parent || parent.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotFound(parentUri(uri));
    }

    const isCreate = !existing;

    // Preserve the existing item's data-encryption policy on normal saves.
    // New data defaults to encrypted.
    //
    // A 0-byte 7z file has no data stream, so the archive cannot persist a
    // per-file DATA-encryption state for it. If content is later added to an
    // empty file, treat that as new data and encrypt it by default instead of
    // inheriting the archive reader's inevitable `encrypted=false`.
    const dataEncrypted =
      isCreate || existing.size === 0
        ? true
        : Boolean(existing.encrypted);

    // Avoid writing content to disk. Keep the supplied bytes in memory and
    // send them to the private native bridge.
    const input = Buffer.from(
      content.buffer,
      content.byteOffset,
      content.byteLength
    );

    return this.enqueueMutation(async () => {
      this.output.appendLine(
        `[${isCreate ? "CREATE FILE" : "SAVE"} START]`
      );

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          await this.backend.write(
            candidateArchive,
            this.password,
            relPath,
            input,
            dataEncrypted
          );
        }
      );

      this.output.appendLine(
        `[${isCreate ? "CREATE FILE" : "SAVE"} OK] (${input.length} bytes, DLL)`
      );

      this._onDidChangeFile.fire([
        {
          type: isCreate
            ? vscode.FileChangeType.Created
            : vscode.FileChangeType.Changed,
          uri
        },
        { type: vscode.FileChangeType.Changed, uri: parentUri(uri) }
      ]);
    });
  }

  async createDirectory(uri) {
    this.ensureSession();
    this.ensureUriSession(uri);

    const relPath = validateVirtualPath(normalizeFsPath(uri.path));
    if (!relPath) return;

    if (this.nodes.has(relPath)) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    const parent = this.getParentNode(relPath);
    if (!parent || parent.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotFound(parentUri(uri));
    }

    return this.enqueueMutation(async () => {
      this.output.appendLine("[CREATE DIR START]");

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          await this.backend.mkdir(
            candidateArchive,
            this.password,
            relPath
          );
        }
      );

      this.output.appendLine("[CREATE DIR OK] (native directory entry)");

      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Created, uri },
        { type: vscode.FileChangeType.Changed, uri: parentUri(uri) }
      ]);
    });
  }

  async delete(uri, options) {
    this.ensureSession();
    this.ensureUriSession(uri);

    const relPath = validateVirtualPath(normalizeFsPath(uri.path));
    if (!relPath) {
      throw vscode.FileSystemError.NoPermissions("Cannot delete the archive root.");
    }

    const node = this.nodes.get(relPath);
    if (!node) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (
      node.type === vscode.FileType.Directory &&
      node.children.size > 0 &&
      !options.recursive
    ) {
      throw vscode.FileSystemError.NoPermissions(
        "Directory is not empty. Recursive delete is required."
      );
    }

    return this.enqueueMutation(async () => {
      this.output.appendLine("[DELETE START]");

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          await this.backend.delete(
            candidateArchive,
            this.password,
            relPath,
            true
          );
        }
      );

      this.output.appendLine("[DELETE OK]");

      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Deleted, uri },
        { type: vscode.FileChangeType.Changed, uri: parentUri(uri) }
      ]);
    });
  }

  async rename(oldUri, newUri, options) {
    this.ensureSession();
    this.ensureUriSession(oldUri);
    this.ensureUriSession(newUri);

    const oldPath = validateVirtualPath(normalizeFsPath(oldUri.path));
    const newPath = validateVirtualPath(normalizeFsPath(newUri.path));

    if (!oldPath || !newPath) {
      throw vscode.FileSystemError.NoPermissions("Cannot rename the archive root.");
    }
    if (oldPath === newPath) return;

    const source = this.nodes.get(oldPath);
    if (!source) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }

    if (
      source.type === vscode.FileType.Directory &&
      newPath.startsWith(oldPath + "/")
    ) {
      throw vscode.FileSystemError.NoPermissions(
        "A directory cannot be moved inside itself."
      );
    }

    const destination = this.nodes.get(newPath);
    if (destination && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }

    const destinationParent = this.getParentNode(newPath);
    if (!destinationParent || destinationParent.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotFound(parentUri(newUri));
    }

    return this.enqueueMutation(async () => {
      this.output.appendLine("[RENAME/MOVE START]");

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          // Re-list the candidate so rename pairs reflect the exact archive
          // state that is about to be renamed.
          const candidateEntries = await this.backend.list(
            candidateArchive,
            this.password
          );
          const renamePairs = this.buildRenamePairs(
            oldPath,
            newPath,
            source.type,
            candidateEntries
          );

          if (renamePairs.length === 0) {
            throw vscode.FileSystemError.Unavailable(
              `No archive entries were found for ${oldPath}.`
            );
          }

          if (destination) {
            await this.backend.delete(
              candidateArchive,
              this.password,
              newPath,
              true
            );
          }

          // Rename exact archive entries deepest-first. Explicit directory
          // entries are included, so native empty folders move cleanly.
          for (const [from, to] of renamePairs) {
            await this.backend.rename(
              candidateArchive,
              this.password,
              from,
              to
            );
          }
        }
      );

      this.output.appendLine("[RENAME/MOVE OK]");

      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
        { type: vscode.FileChangeType.Changed, uri: parentUri(oldUri) },
        { type: vscode.FileChangeType.Changed, uri: parentUri(newUri) }
      ]);
    });
  }

  async toggleDataEncryption(uri) {
    this.ensureSession();
    this.ensureUriSession(uri);

    const relPath = validateVirtualPath(normalizeFsPath(uri.path));
    const node = this.nodes.get(relPath);

    if (!node) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (node.type !== vscode.FileType.File) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    if (node.size === 0) {
      // 7z represents zero-byte files as EmptyStream/EmptyFile entries. There
      // is no file-data stream to encrypt, so "encrypted vs unencrypted data"
      // is not a meaningful persisted state for this item.
      return {
        applicable: false,
        encrypted: undefined
      };
    }

    const desiredEncrypted = !Boolean(node.encrypted);

    return this.enqueueMutation(async () => {
      this.output.appendLine(
        `[DATA ENCRYPTION] ${desiredEncrypted ? "encrypt" : "decrypt"}`
      );

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          // Keep header/data rewrite phases in separate native helper
          // processes. We previously observed 7-Zip/bit7z update failures when
          // multiple archive rewrites reused one process/handle lifetime.
          // Do not collapse these phases without re-running mixed-encryption
          // regression tests on real solid archives.
          let data;
          let reblockState;

          try {
            const updateMode = await this.backend.getItemUpdateMode(
              candidateArchive,
              this.password,
              relPath
            );

            this.output.appendLine(
              `[DATA ENCRYPTION MODE] ${updateMode}`
            );

            this.output.appendLine(
              "[DATA ENCRYPTION PHASE] read target"
            );
            if (updateMode === "reblock") {
              // Keep the archived item's metadata together with its plaintext
              // bytes while it is detached from the shared solid block. The
              // payload is opaque to JS and exists in memory only.
              reblockState = await this.backend.readReblockItem(
                candidateArchive,
                this.password,
                relPath
              );
            } else {
              data = await this.backend.read(
                candidateArchive,
                this.password,
                relPath
              );
            }

            const originalHeaderEncrypted =
              await this.backend.getHeaderEncryption(
                candidateArchive,
                this.password
              );

            if (!desiredEncrypted && originalHeaderEncrypted) {
              this.output.appendLine(
                "[DATA ENCRYPTION PHASE] temporary header OFF"
              );
              await this.backend.setHeaderEncryption(
                candidateArchive,
                this.password,
                false
              );

            }

            if (updateMode === "reblock") {
              this.output.appendLine(
                "[DATA ENCRYPTION PHASE] detach target from shared solid block"
              );
              await this.backend.delete(
                candidateArchive,
                this.password,
                relPath,
                false
              );

              this.output.appendLine(
                `[DATA ENCRYPTION PHASE] add target as new ${
                  desiredEncrypted ? "encrypted" : "unencrypted"
                } block`
              );
              await this.backend.writeReblockItem(
                candidateArchive,
                this.password,
                relPath,
                reblockState,
                desiredEncrypted
              );
            } else {
              this.output.appendLine(
                `[DATA ENCRYPTION PHASE] rewrite target as ${
                  desiredEncrypted ? "encrypted" : "unencrypted"
                } data`
              );
              await this.backend.write(
                candidateArchive,
                this.password,
                relPath,
                data,
                desiredEncrypted
              );
            }

            if (!desiredEncrypted && originalHeaderEncrypted) {
              this.output.appendLine(
                "[DATA ENCRYPTION PHASE] restore header ON"
              );
              await this.backend.setHeaderEncryption(
                candidateArchive,
                this.password,
                true
              );
            }
          } finally {
            if (data?.fill) {
              data.fill(0);
            }
            if (reblockState?.fill) {
              reblockState.fill(0);
            }
          }
        }
      );

      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Changed, uri }
      ]);

      return {
        applicable: true,
        encrypted: desiredEncrypted
      };
    });
  }

  get headerEncryptionApplicable() {
    return this.rawEntries.length > 0;
  }

  async setHeaderEncryption(desiredEncrypted) {
    this.ensureSession();

    if (!this.headerEncryptionApplicable) {
      throw new Error(
        "Header encryption is not applicable to an empty 7z archive because there are no member names to encrypt."
      );
    }

    if (Boolean(this.headerEncrypted) === Boolean(desiredEncrypted)) {
      return Boolean(this.headerEncrypted);
    }

    return this.enqueueMutation(async () => {
      this.output.appendLine(
        `[HEADER ENCRYPTION] ${desiredEncrypted ? "enable" : "disable"}`
      );

      await this.runTransactionalMutation(
        async ({ candidateArchive }) => {
          const hasFileItem =
            this.rawEntries.some(
              (entry) => !entry.isDirectory
            );

          if (hasFileItem) {
            await this.backend.setHeaderEncryption(
              candidateArchive,
              this.password,
              desiredEncrypted
            );
            return;
          }

          // 7-Zip/bit7z needs a file item to persist the archive-level header
          // policy through the native rename-based toggle. A directory-only
          // archive still has member names worth encrypting, so create a
          // collision-safe zero-byte file only inside the transaction
          // candidate, use it as the native anchor, then delete it again.
          //
          // If any phase fails, mutateArchiveTransactionally discards the
          // candidate; the temporary item can never be committed accidentally.
          const temporaryAnchor =
            allocateTemporaryHeaderAnchor(
              this.rawEntries
            );

          await this.backend.write(
            candidateArchive,
            this.password,
            temporaryAnchor,
            Buffer.alloc(0),
            true
          );

          await this.backend.setHeaderEncryption(
            candidateArchive,
            this.password,
            desiredEncrypted
          );

          await this.backend.delete(
            candidateArchive,
            this.password,
            temporaryAnchor,
            false
          );
        }
      );

      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Changed, uri: this.rootUri }
      ]);

      return Boolean(this.headerEncrypted);
    });
  }

  buildRenamePairs(
    oldPath,
    newPath,
    sourceType,
    entries = this.rawEntries
  ) {
    if (sourceType === vscode.FileType.File) {
      return [[oldPath, newPath]];
    }

    const pairs = [];
    for (const entry of entries) {
      const raw = normalizeArchivePath(entry.path);
      if (raw === oldPath || raw.startsWith(oldPath + "/")) {
        const suffix = raw.slice(oldPath.length);
        pairs.push([raw, newPath + suffix]);
      }
    }

    // Deepest paths first to avoid parent-name side effects.
    pairs.sort((a, b) => b[0].split("/").length - a[0].split("/").length);
    return pairs;
  }


  enqueueMutation(task) {
    const run = this.mutationQueue.then(task, task);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  async runTransactionalMutation(mutate) {
    // This is the single state-transition boundary for successful archive
    // mutations. Every committed mutation must update the in-memory baseline
    // and rebuild the Explorer tree from the committed archive before the
    // caller emits VS Code file events.
    const transaction = await mutateArchiveTransactionally({
      archivePath: this.archivePath,
      backend: this.backend,
      password: this.password,
      expectedFingerprint: this.archiveFingerprint,
      output: this.output,
      mutate
    });

    this.archiveFingerprint = transaction.fingerprint;
    await this.refreshArchive();
    return transaction;
  }

  getParentNode(relPath) {
    const i = relPath.lastIndexOf("/");
    const parentPath = i >= 0 ? relPath.slice(0, i) : "";
    return this.nodes.get(parentPath);
  }

  ensureSession() {
    if (
      !this.archivePath ||
      this.password === undefined ||
      !this.backend ||
      !this.archiveFingerprint
    ) {
      throw vscode.FileSystemError.Unavailable(
        "Encrypted archive session is not loaded."
      );
    }
  }

  async refreshArchive() {
    const stableState = await readStableArchiveState(
      this.backend,
      this.archivePath,
      this.password
    );

    if (!sameArchiveFingerprint(
      stableState.fingerprint,
      this.archiveFingerprint
    )) {
      throw new ExternalArchiveChangeError(
        "The .7z archive changed outside Secure Mode while its Explorer tree " +
        "was being refreshed. Close and reopen the archive."
      );
    }

    this.headerEncrypted = stableState.headerEncrypted;
    this.buildTree(stableState.entries);
    this._onDidChangeSessionState.fire();
  }

  loadArchive({
    archivePath,
    password,
    backend,
    entries,
    rootUri,
    archiveFingerprint,
    headerEncrypted,
    sessionMode,
    restored = false
  }) {
    validateArchiveEntries(entries);

    this.archivePath = archivePath;
    this.password = password;
    this.backend = backend;
    this.rootUri = rootUri;
    this.archiveFingerprint = archiveFingerprint;
    this.headerEncrypted = headerEncrypted;
    this.sessionMode = requireVirtualSessionMode(sessionMode);
    this.buildTree(entries);

    this.output.clear();
    this.output.appendLine(restored ? "[RESTORED]" : "[OPENED]");
    this.output.appendLine("Archive path: omitted from routine logs");
    this.output.appendLine(`Entries: ${entries.length}`);
    this.output.appendLine(`Root children: ${this.root.children.size}`);
    this.output.appendLine("");
    this.output.appendLine("Secure Mode session:");
    this.output.appendLine("- read: 7z.dll -> native memory -> VS Code");
    this.output.appendLine("- write/create: VS Code -> helper stdin -> 7z.dll");
    this.output.appendLine("- password is NOT placed in process argv; no plaintext temp file is written");
    this.output.appendLine("- empty folders are stored as native 7z directory entries");
    this.output.appendLine("- external-change fingerprint baseline: active");
    this.output.appendLine(
      `- session mode: ${sessionModeLabel(this.sessionMode)}`
    );
    this.output.appendLine(
      `- header encryption: ${this.headerEncrypted ? "encrypted" : "unencrypted"}`
    );

    this._onDidChangeSessionState.fire();
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri: this.rootUri }
    ]);
  }

  buildTree(entries) {
    this.rawEntries = entries.slice();
    this.root = new EntryNode("", "", vscode.FileType.Directory);
    this.nodes = new Map([["", this.root]]);

    for (const entry of entries) {
      const clean = normalizeArchivePath(entry.path);
      if (!clean) continue;


      const parts = clean.split("/");
      let current = this.root;
      let accumulated = "";

      parts.forEach((part, index) => {
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        const last = index === parts.length - 1;
        const desiredType = last
          ? (entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File)
          : vscode.FileType.Directory;

        let child = current.children.get(part);
        if (!child) {
          child = new EntryNode(part, accumulated, desiredType);
          current.children.set(part, child);
          this.nodes.set(accumulated, child);
        }

        if (last) {
          child.type = desiredType;
          child.size = entry.size || 0;
          child.encrypted = entry.isDirectory
            ? undefined
            : Boolean(entry.encrypted);
          if (entry.mtime) {
            const timestamp = entry.mtime.getTime();
            child.mtime = timestamp;
            child.ctime = timestamp;
          }
        }

        current = child;
      });
    }
  }

  clearArchive() {
    const previousRootUri = this.rootUri;

    this.archivePath = undefined;
    this.password = undefined;
    this.backend = undefined;
    this.rootUri = undefined;
    this.archiveFingerprint = undefined;
    this.headerEncrypted = undefined;
    this.sessionMode = undefined;
    this.rawEntries = [];
    this.root = new EntryNode("", "", vscode.FileType.Directory);
    this.nodes = new Map([["", this.root]]);

    this._onDidChangeSessionState.fire();

    if (previousRootUri) {
      this._onDidChangeFile.fire([
        { type: vscode.FileChangeType.Changed, uri: previousRootUri }
      ]);
    }
  }

  ensureUriSession(uri) {
    if (
      !this.rootUri ||
      uri.scheme !== this.rootUri.scheme ||
      uri.authority !== this.rootUri.authority
    ) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  lookup(uri) {
    this.ensureUriSession(uri);

    const relPath = normalizeFsPath(uri.path);
    const node = this.nodes.get(relPath);
    if (!node) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return node;
  }
}

class EncryptionDecorationProvider {
  constructor(provider) {
    this.provider = provider;
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations =
      this._onDidChangeFileDecorations.event;
  }

  dispose() {
    this._onDidChangeFileDecorations.dispose();
  }

  refresh(uri) {
    if (uri) {
      this._onDidChangeFileDecorations.fire(uri);
    }
  }

  provideFileDecoration(uri) {
    if (!isVirtualResourceScheme(uri.scheme)) {
      return undefined;
    }

    try {
      const node = this.provider.lookup(uri);
      if (
        node.type === vscode.FileType.File &&
        node.size > 0 &&
        node.encrypted === false
      ) {
        // This badge describes FILE DATA encryption only. Header encryption
        // is an independent archive-wide property, so an unlocked badge does
        // not imply that the filename is visible without the password.
        return new vscode.FileDecoration(
          "🔓",
          "Unencrypted data"
        );
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}

function updateHeaderStatusBar(statusBar, provider) {
  if (
    !provider.rootUri ||
    provider.headerEncrypted === undefined
  ) {
    statusBar.hide();
    return;
  }

  if (!provider.headerEncryptionApplicable) {
    statusBar.text = "$(circle-slash) 7z Header: N/A";
    statusBar.tooltip =
      "Header encryption is not applicable to an empty archive because there are no member names to encrypt.";
    statusBar.show();
    return;
  }

  if (provider.headerEncrypted) {
    statusBar.text = "$(lock) 7z Header: Encrypted";
    statusBar.tooltip =
      "7z file-name/header encryption is enabled. Click to toggle.";
  } else {
    statusBar.text = "$(unlock) 7z Header: Unencrypted";
    statusBar.tooltip =
      "7z file-name/header encryption is disabled. Click to toggle.";
  }

  statusBar.show();
}

module.exports = {
  EntryNode,
  VirtualArchiveProvider,
  EncryptionDecorationProvider,
  updateHeaderStatusBar
};
