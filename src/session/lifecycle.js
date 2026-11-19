"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  VIRTUAL_SCHEME,
  SESSION_KEY,
  PASSWORD_KEY,
  ARCHIVE_PATH_KEY,
  HOT_EXIT_STATE_KEY,
  MATERIALIZED_CLEANUP_KEY,
  MATERIALIZED_BASELINE_KEY,
  MATERIALIZED_AUTOSYNC_DEBOUNCE_MS,
  MATERIALIZED_GIT_LOCK_RETRY_MS,
  SESSION_MODE
} = require("../constants");
const {
  validateMaterializableEntries,
  sameWindowsPath,
  isPathWithinDirectory,
  isMaterializedGitLockPath,
  MaterializedGitBusyError,
  scanMaterializedWorkingTree,
  filterTopmostDeletedPaths
} = require("../security/paths");
const { getNativeBackend } = require("../native/backend");
const {
  isKnownSessionMode,
  isVirtualSessionMode,
  virtualSchemeForMode,
  isVirtualResourceScheme,
  requireVirtualSessionMode,
  sessionModeLabel,
  modeUsesHotExitGuard,
  ExternalArchiveChangeError,
  assertArchiveUnchanged,
  readStableArchiveState,
  mutateArchiveTransactionally,
  sameArchiveFingerprint
} = require("../archive/core");

function normalizeMaterializedPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
}

function materializedHmacHex(key, value) {
  return crypto
    .createHmac("sha256", key)
    .update(value)
    .digest("hex");
}

function materializedContentHmacBytes(key, bytes) {
  return crypto
    .createHmac("sha256", key)
    .update(bytes)
    .digest("hex");
}

function materializedContentHmacDiskFile(key, filePath) {
  return new Promise((resolve, reject) => {
    const hmac = crypto.createHmac("sha256", key);
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hmac.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hmac.digest("hex")));
  });
}

function serializeMaterializedBaselineForHandoff(
  baselineKey,
  baseline
) {
  const records = [];
  for (const [relPath, value] of baseline) {
    records.push({
      p: materializedHmacHex(baselineKey, relPath),
      h: value.hmac
    });
  }
  return records;
}

function restoreMaterializedBaselineFromHandoff(
  baselineKey,
  records,
  entries
) {
  if (!baselineKey || !Array.isArray(records)) {
    return undefined;
  }

  const byPathHmac = new Map(
    records.map((record) => [record?.p, record])
  );
  const baseline = new Map();

  for (const entry of entries || []) {
    if (entry.isDirectory) continue;

    const relPath = normalizeMaterializedPath(entry.path);
    const record = byPathHmac.get(
      materializedHmacHex(baselineKey, relPath)
    );
    if (
      !record ||
      typeof record.h !== "string"
    ) {
      return undefined;
    }

    baseline.set(relPath, {
      hmac: record.h,
      size: entry.size
    });
  }

  if (baseline.size !== byPathHmac.size) {
    return undefined;
  }

  return baseline;
}

class MaterializedSessionController {
  constructor(output) {
    this.output = output;

    // Watcher autosync, manual sync, close, and shutdown may all request a
    // sync at nearly the same time. Serialize them so two archive transactions
    // never race against the same fingerprint baseline.
    this.syncQueue = Promise.resolve();

    this.vscodeWatcher = undefined;
    this.vscodeWatcherDisposables = [];
    this.nodeWatcher = undefined;
    this.autosyncTimer = undefined;
    this.autosyncContext = undefined;
    this.lastAutosyncError = undefined;
    this.externalFinalizePromise = undefined;

    this.clear();
  }

  get active() {
    return this.mode === SESSION_MODE.MATERIALIZED &&
      Boolean(this.workingDir && this.archivePath);
  }

  clear() {
    this.stopAutosyncWatchers();

    this.mode = undefined;
    this.archivePath = undefined;
    this.password = undefined;
    this.backend = undefined;
    this.workingDir = undefined;
    this.archiveFingerprint = undefined;
    this.headerEncrypted = undefined;
    this.entries = [];
    this.returnTarget = undefined;
    if (Buffer.isBuffer(this.baselineKey)) {
      this.baselineKey.fill(0);
    }
    this.baselineKey = undefined;
    this.contentBaseline = undefined;
  }

  load({
    archivePath,
    password,
    backend,
    workingDir,
    archiveFingerprint,
    headerEncrypted,
    entries,
    returnTarget,
    baselineKey,
    contentBaseline
  }) {
    this.externalFinalizePromise = undefined;
    this.mode = SESSION_MODE.MATERIALIZED;
    this.archivePath = archivePath;
    this.password = password;
    this.backend = backend;
    this.workingDir = workingDir;
    this.archiveFingerprint = archiveFingerprint;
    this.headerEncrypted = headerEncrypted;
    this.entries = entries || [];
    this.returnTarget = returnTarget;
    this.baselineKey = baselineKey;
    this.contentBaseline = contentBaseline;
  }

  startAutosyncWatchers(context) {
    this.stopAutosyncWatchers();

    if (!this.active) return;

    this.autosyncContext = context;
    const baseUri = vscode.Uri.file(this.workingDir);

    this.vscodeWatcher =
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(baseUri, "**/*"),
        false,
        false,
        false
      );

    const scheduleFromUri = (kind, uri) => {
      if (
        uri?.scheme === "file" &&
        isPathWithinDirectory(
          this.workingDir,
          uri.fsPath
        )
      ) {
        this.scheduleAutosync(`${kind}:${uri.fsPath}`);
      }
    };

    this.vscodeWatcherDisposables = [
      this.vscodeWatcher.onDidCreate(
        (uri) => scheduleFromUri("create", uri)
      ),
      this.vscodeWatcher.onDidChange(
        (uri) => scheduleFromUri("change", uri)
      ),
      this.vscodeWatcher.onDidDelete(
        (uri) => scheduleFromUri("delete", uri)
      )
    ];

    // VS Code recursive watchers can be affected by files.watcherExclude,
    // commonly for .git. On this Windows-only native build, also use Node's
    // recursive watcher as a local supplement. Duplicate events are expected
    // and collapse into the same debounce timer.
    try {
      this.nodeWatcher = fs.watch(
        this.workingDir,
        { recursive: true },
        (_eventType, filename) => {
          const rel = filename
            ? String(filename)
            : "<unknown>";
          this.scheduleAutosync(`native:${rel}`);
        }
      );

      this.nodeWatcher.on("error", (error) => {
        this.output.appendLine(
          `[MATERIALIZED WATCHER WARNING] Native watcher error: ${error.message}`
        );
      });
    } catch (error) {
      this.output.appendLine(
        `[MATERIALIZED WATCHER WARNING] Native recursive watcher unavailable: ${error.message}`
      );
    }

    this.output.appendLine(
      `[MATERIALIZED] Autosync watchers active (debounce ${MATERIALIZED_AUTOSYNC_DEBOUNCE_MS} ms).`
    );
  }

  stopAutosyncWatchers() {
    if (this.autosyncTimer) {
      clearTimeout(this.autosyncTimer);
      this.autosyncTimer = undefined;
    }

    for (const disposable of this.vscodeWatcherDisposables || []) {
      try {
        disposable.dispose();
      } catch {}
    }
    this.vscodeWatcherDisposables = [];

    if (this.vscodeWatcher) {
      try {
        this.vscodeWatcher.dispose();
      } catch {}
      this.vscodeWatcher = undefined;
    }

    if (this.nodeWatcher) {
      try {
        this.nodeWatcher.close();
      } catch {}
      this.nodeWatcher = undefined;
    }

    this.autosyncContext = undefined;
  }

  scheduleAutosync(
    reason,
    delayMs = MATERIALIZED_AUTOSYNC_DEBOUNCE_MS
  ) {
    if (!this.active || !this.autosyncContext) {
      return;
    }

    if (this.autosyncTimer) {
      clearTimeout(this.autosyncTimer);
    }

    this.autosyncTimer = setTimeout(
      () => {
        this.autosyncTimer = undefined;
        void this.runScheduledAutosync(reason);
      },
      delayMs
    );
  }

  async runScheduledAutosync(reason) {
    if (!this.active || !this.autosyncContext) {
      return;
    }

    try {
      const result = await syncMaterializedSession(
        this.autosyncContext,
        this,
        {
          saveAll: false,
          showProgress: false
        }
      );

      this.lastAutosyncError = undefined;
      this.output.appendLine(
        result.changed
          ? "[MATERIALIZED AUTOSYNC] Working-tree change synced."
          : "[MATERIALIZED AUTOSYNC] Change burst coalesced; archive already in sync."
      );
    } catch (error) {
      if (error instanceof MaterializedGitBusyError) {
        this.output.appendLine(
          `[MATERIALIZED AUTOSYNC] Git lock detected; retrying after ${MATERIALIZED_GIT_LOCK_RETRY_MS} ms.`
        );
        this.scheduleAutosync(
          "git-lock-retry",
          MATERIALIZED_GIT_LOCK_RETRY_MS
        );
        return;
      }

      const message = error?.message || String(error);
      this.output.appendLine(
        `[MATERIALIZED AUTOSYNC ERROR] ${message}`
      );

      if (this.lastAutosyncError !== message) {
        this.lastAutosyncError = message;
        vscode.window.showErrorMessage(
          `Materialized autosync failed: ${message}`
        );
      }
    }
  }

  async ensureAuthenticated(context) {
    if (this.password && this.backend) {
      return;
    }

    const backend = getNativeBackend(context);
    backend.ensureAvailable();

    const password = await vscode.window.showInputBox({
      title: "Resume Materialized 7z session",
      prompt: `Password for ${path.basename(this.archivePath)}`,
      password: true,
      ignoreFocusOut: true
    });

    if (password === undefined) {
      throw new Error(
        "Materialized sync requires the archive password."
      );
    }

    const stable = await readStableArchiveState(
      backend,
      this.archivePath,
      password
    );

    if (!sameArchiveFingerprint(
      stable.fingerprint,
      this.archiveFingerprint
    )) {
      throw new ExternalArchiveChangeError(
        "The source .7z archive changed outside this Materialized session. " +
        "Automatic sync is refused to avoid overwriting external changes."
      );
    }

    this.password = password;
    this.backend = backend;
    this.headerEncrypted = stable.headerEncrypted;
    this.entries = stable.entries;
  }

  async ensureContentBaseline() {
    if (
      Buffer.isBuffer(this.baselineKey) &&
      this.contentBaseline instanceof Map
    ) {
      return;
    }

    const baselineKey = crypto.randomBytes(32);
    const baseline = new Map();

    try {
      for (const entry of this.entries) {
        if (entry.isDirectory) continue;

        const relPath = normalizeMaterializedPath(entry.path);
        const bytes = await this.backend.read(
          this.archivePath,
          this.password,
          relPath
        );

        try {
          baseline.set(relPath, {
            hmac: materializedContentHmacBytes(
              baselineKey,
              bytes
            ),
            size: bytes.length
          });
        } finally {
          bytes.fill(0);
        }
      }
    } catch (error) {
      baselineKey.fill(0);
      throw error;
    }

    if (Buffer.isBuffer(this.baselineKey)) {
      this.baselineKey.fill(0);
    }
    this.baselineKey = baselineKey;
    this.contentBaseline = baseline;
  }

  syncToArchive(context) {
    const run = this.syncQueue.then(
      () => this.syncToArchiveExclusive(context)
    );
    this.syncQueue = run.catch(() => {});
    return run;
  }

  async waitForPendingSync() {
    await this.syncQueue;
  }

  async syncToArchiveExclusive(context) {
    if (!this.active) {
      throw new Error("No Materialized archive session is active.");
    }

    await this.ensureAuthenticated(context);

    await assertArchiveUnchanged(
      this.archivePath,
      this.archiveFingerprint,
      this.output,
      "before materialized sync"
    );

    const currentEntries = await scanMaterializedWorkingTree(
      this.workingDir
    );

    const gitLock = currentEntries.find(
      (entry) =>
        !entry.isDirectory &&
        isMaterializedGitLockPath(entry.path)
    );
    if (gitLock) {
      throw new MaterializedGitBusyError(gitLock.path);
    }

    // The content baseline is built during normal materialization. Recovery or
    // an interrupted handoff may lose the in-memory state, in which case it is
    // rebuilt once from the actual archive before change detection continues.
    await this.ensureContentBaseline();

    const originalMap = new Map(
      this.entries.map((entry) => [
        normalizeMaterializedPath(entry.path),
        entry
      ])
    );

    // Keep explicit directory items distinct from directories that only
    // exist implicitly because a child path uses them. If an implicit source
    // directory becomes empty in the working tree, sync must create a real 7z
    // directory item or the empty directory would disappear.
    const originalExplicitDirectories = new Set(
      [...originalMap]
        .filter(([, entry]) => entry.isDirectory)
        .map(([relPath]) => relPath)
    );

    const currentMap = new Map(
      currentEntries.map((entry) => [entry.path, entry])
    );

    const deleteCandidates = [];
    for (const [relPath, original] of originalMap) {
      const current = currentMap.get(relPath);
      if (
        !current ||
        Boolean(current.isDirectory) !== Boolean(original.isDirectory)
      ) {
        deleteCandidates.push(relPath);
      }
    }
    const deletions = filterTopmostDeletedPaths(deleteCandidates);

    const currentPaths = new Set(currentMap.keys());
    const directoriesToCreate = currentEntries
      .filter((entry) => entry.isDirectory)
      .filter((entry) => {
        const original = originalMap.get(entry.path);
        if (original && !original.isDirectory) {
          return true;
        }
        if (originalExplicitDirectories.has(entry.path)) {
          return false;
        }

        const prefix = `${entry.path}/`;
        const hasCurrentDescendant = [...currentPaths].some(
          (candidate) => candidate.startsWith(prefix)
        );
        return !hasCurrentDescendant;
      })
      .sort(
        (a, b) =>
          a.path.split("/").length - b.path.split("/").length
      );

    const filesToWrite = [];
    for (const current of currentEntries) {
      if (current.isDirectory) continue;

      const original = originalMap.get(current.path);
      let changed = !original || original.isDirectory;

      if (!changed && original.size !== current.size) {
        changed = true;
      }

      if (!changed) {
        const baseline = this.contentBaseline.get(current.path);
        if (!baseline || baseline.size !== current.size) {
          changed = true;
        } else {
          const diskHmac = await materializedContentHmacDiskFile(
            this.baselineKey,
            current.absolutePath
          );
          changed = baseline.hmac !== diskHmac;
        }
      }

      if (!changed) continue;

      const dataEncrypted =
        !original || original.isDirectory || original.size === 0
          ? true
          : Boolean(original.encrypted);

      filesToWrite.push({
        ...current,
        dataEncrypted
      });
    }

    if (
      deletions.length === 0 &&
      directoriesToCreate.length === 0 &&
      filesToWrite.length === 0
    ) {
      this.output.appendLine(
        "[MATERIALIZED SYNC] No working-tree changes detected."
      );
      return { changed: false };
    }

    const transaction = await mutateArchiveTransactionally({
      archivePath: this.archivePath,
      backend: this.backend,
      password: this.password,
      expectedFingerprint: this.archiveFingerprint,
      output: this.output,
      mutate: async ({ candidateArchive }) => {
        for (const relPath of deletions) {
          await this.backend.delete(
            candidateArchive,
            this.password,
            relPath,
            true
          );
        }

        for (const directory of directoriesToCreate) {
          await this.backend.mkdir(
            candidateArchive,
            this.password,
            directory.path
          );
        }

        for (const file of filesToWrite) {
          const bytes = await fs.promises.readFile(file.absolutePath);
          try {
            // Recompute from the exact bytes being committed. The working
            // file may have changed again after change detection.
            file.contentHmac = materializedContentHmacBytes(
              this.baselineKey,
              bytes
            );
            file.committedSize = bytes.length;

            await this.backend.write(
              candidateArchive,
              this.password,
              file.path,
              bytes,
              file.dataEncrypted
            );
          } finally {
            bytes.fill(0);
          }
        }
      }
    });

    this.archiveFingerprint = transaction.fingerprint;

    // Verify every file written by this sync against the actual committed
    // archive. Verification cost intentionally scales with the current write
    // set, not with unrelated members already present in the archive.
    const verifiedWrittenHmacs = new Map();
    let readBackError;

    for (const file of filesToWrite) {
      let bytes;
      try {
        bytes = await this.backend.read(
          this.archivePath,
          this.password,
          file.path
        );

        const actualHmac = materializedContentHmacBytes(
          this.baselineKey,
          bytes
        );
        if (
          bytes.length !== file.committedSize ||
          actualHmac !== file.contentHmac
        ) {
          readBackError = new Error(
            "Materialized post-commit read-back verification failed. " +
            "The archive was committed, but at least one written file did not read back as the bytes that were submitted. " +
            "The in-memory content baseline was discarded; run Sync again or close and reopen the archive before relying on the session state."
          );
          break;
        }

        verifiedWrittenHmacs.set(file.path, {
          hmac: actualHmac,
          size: bytes.length
        });
      } catch (error) {
        readBackError = new Error(
          "Materialized post-commit read-back verification could not be completed. " +
          "The archive was committed, but the written content could not be verified: " +
          error.message
        );
        break;
      } finally {
        if (bytes) bytes.fill(0);
      }
    }

    if (!readBackError && filesToWrite.length > 0) {
      this.output.appendLine(
        `[MATERIALIZED VERIFY] Read-back verified ${filesToWrite.length} written file(s).`
      );
    }

    const refreshed = await readStableArchiveState(
      this.backend,
      this.archivePath,
      this.password
    );
    this.archiveFingerprint = refreshed.fingerprint;
    this.headerEncrypted = refreshed.headerEncrypted;
    this.entries = refreshed.entries;

    if (readBackError) {
      // The archive has already been transactionally committed. Do not claim
      // rollback here. Discard the derived baseline so the next sync rebuilds
      // it from the actual archive instead of trusting unverified state.
      this.contentBaseline = undefined;
      this.output.appendLine(
        `[MATERIALIZED VERIFY ERROR] ${readBackError.message}`
      );
      throw readBackError;
    }

    const nextBaseline = new Map();
    for (const current of currentEntries) {
      if (current.isDirectory) continue;

      const written = verifiedWrittenHmacs.get(current.path);
      if (written) {
        nextBaseline.set(current.path, written);
        continue;
      }

      const previous = this.contentBaseline.get(current.path);
      if (previous && previous.size === current.size) {
        nextBaseline.set(current.path, previous);
      }
    }
    this.contentBaseline = nextBaseline;

    this.output.appendLine(
      `[MATERIALIZED SYNC] ${filesToWrite.length} file(s) written, ` +
      `${directoriesToCreate.length} directorie(s) created, ` +
      `${deletions.length} path(s) deleted.`
    );

    return { changed: true };
  }
}

// One request == one short-lived helper process.
//
// Passwords and file bytes travel through the private stdin/stdout protocol,
// never argv or environment variables. Keep this boundary even if the native
// implementation is refactored: command-line passwords are observable by
// unrelated system tooling.

async function saveDirtyStandardVirtualDocuments(actionLabel) {
  const dirty = vscode.workspace.textDocuments.filter(
    (document) =>
      document.uri.scheme === VIRTUAL_SCHEME.STANDARD &&
      document.isDirty
  );

  if (dirty.length === 0) return true;

  const choice = await vscode.window.showWarningMessage(
    `${dirty.length} Secure Mode file(s) have unsaved changes. ` +
      `Save them before ${actionLabel}?`,
    { modal: true },
    "Save and Continue",
    "Cancel"
  );

  if (choice !== "Save and Continue") return false;

  for (const document of dirty) {
    if (!await document.save()) {
      vscode.window.showErrorMessage(
        `Could not save ${document.uri.path}.`
      );
      return false;
    }
  }

  return true;
}

function createSessionRootUri(mode) {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const scheme = virtualSchemeForMode(mode);
  return vscode.Uri.parse(`${scheme}://${sessionId}/`);
}

function getMountedVirtualRootUri() {
  const folder = (vscode.workspace.workspaceFolders || []).find(
    (candidate) => isVirtualResourceScheme(candidate.uri.scheme)
  );
  return folder?.uri;
}


function hasMountedMaterializedWorkspace(saved) {
  if (
    saved?.mode !== SESSION_MODE.MATERIALIZED ||
    typeof saved?.workingDir !== "string"
  ) {
    return false;
  }

  return (vscode.workspace.workspaceFolders || []).some(
    (folder) =>
      folder.uri.scheme === "file" &&
      sameWindowsPath(folder.uri.fsPath, saved.workingDir)
  );
}

function hasActiveArchiveSessionWorkspace(context) {
  const saved = context.globalState.get(SESSION_KEY);
  return (
    hasMountedVirtualWorkspace() ||
    hasMountedMaterializedWorkspace(saved)
  );
}


function captureReturnTarget() {
  if (vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme !== "untitled") {
    return { kind: "workspace", uri: vscode.workspace.workspaceFile.toString() };
  }
  const folders = vscode.workspace.workspaceFolders || [];
  if (
    folders.length === 1 &&
    !isVirtualResourceScheme(folders[0].uri.scheme)
  ) {
    return { kind: "folder", uri: folders[0].uri.toString() };
  }
  return { kind: "empty" };
}

async function restoreReturnTarget(
  saved,
  output
) {
  const target = saved?.returnTarget;
  if (target && (target.kind === "folder" || target.kind === "workspace") && target.uri) {
    output?.appendLine(`[SESSION] Returning to previous ${target.kind}.`);
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.parse(target.uri),
      { forceReuseWindow: true, noRecentEntry: true }
    );
    return;
  }
  output?.appendLine("[SESSION] Returning to an empty VS Code window.");
  await vscode.commands.executeCommand("vscode.newWindow", { reuseWindow: true });
}

function tabUris(tab) {
  const input = tab.input;
  if (!input || typeof input !== "object") return [];
  const candidates = [input.uri, input.original, input.modified, input.base, input.input1, input.input2, input.result, input.notebook, input.inputBoxUri];
  return candidates.filter((value) => vscode.Uri.isUri(value));
}

function getEncryptedTabs() {
  const result = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tabUris(tab).some((uri) => isVirtualResourceScheme(uri.scheme))) result.push(tab);
    }
  }
  return result;
}

async function closeCleanEncryptedTabs(output) {
  const tabs = getEncryptedTabs();
  const cleanTabs = tabs.filter((tab) => !tab.isDirty);
  const dirtyTabs = tabs.filter((tab) => tab.isDirty);
  if (cleanTabs.length) {
    const closed = await vscode.window.tabGroups.close(cleanTabs, true);
    output?.appendLine(`[SESSION] Closed ${cleanTabs.length} stale encrypted editor tab(s): ${closed}.`);
  }
  if (dirtyTabs.length) {
    output?.appendLine(`[SECURITY] ${dirtyTabs.length} stale encrypted editor tab(s) are still dirty; not auto-closing them.`);
  }
  return dirtyTabs.length === 0;
}

async function closeAllEncryptedTabs(output) {
  const tabs = getEncryptedTabs();
  if (!tabs.length) return true;
  const closed = await vscode.window.tabGroups.close(tabs, true);
  output?.appendLine(`[SESSION] Closed ${tabs.length} encrypted editor tab(s): ${closed}.`);
  return closed;
}

function hasMountedVirtualWorkspace() {
  return (vscode.workspace.workspaceFolders || []).some(
    (folder) => isVirtualResourceScheme(folder.uri.scheme)
  );
}


// Supplemental protection only.
//
// files.hotExit=off reduces persistence risk for Standard Virtual mode, but it
// does NOT replace the Secure Text Editor boundary: ordinary TextDocuments may
// still participate in VS Code working-copy backup behavior. The strict path is
// CustomDocument + encrypted backup.
async function enableHotExitGuard(context, output) {
  const config = vscode.workspace.getConfiguration("files");
  let state = context.globalState.get(HOT_EXIT_STATE_KEY);

  if (!state) {
    const inspected = config.inspect("hotExit");
    state = {
      hadGlobalValue: inspected?.globalValue !== undefined,
      previousGlobalValue: inspected?.globalValue
    };
    await context.globalState.update(HOT_EXIT_STATE_KEY, state);
  }

  const currentGlobal = config.inspect("hotExit")?.globalValue;
  if (currentGlobal !== "off") {
    await config.update(
      "hotExit",
      "off",
      vscode.ConfigurationTarget.Global
    );
  }

  output.appendLine("[SECURITY] files.hotExit is forced to off for Standard Virtual mode.");

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    output.appendLine(
      "[DEBUG LIMIT] Extension Development Host always performs hot-exit backups on shutdown/reload."
    );
    output.appendLine(
      "[DEBUG LIMIT] Install the extension normally before judging the Hot Exit protection."
    );
  }
}

async function restoreHotExitGuard(context, output) {
  const state = context.globalState.get(HOT_EXIT_STATE_KEY);
  if (!state) return;

  const config = vscode.workspace.getConfiguration("files");
  const currentGlobal = config.inspect("hotExit")?.globalValue;

  // Do not overwrite a value that the user deliberately changed while
  // Secure Mode was open. We only restore the setting if our own "off"
  // value is still present.
  if (currentGlobal === "off") {
    if (state.hadGlobalValue) {
      await config.update(
        "hotExit",
        state.previousGlobalValue,
        vscode.ConfigurationTarget.Global
      );
    } else {
      await config.update(
        "hotExit",
        undefined,
        vscode.ConfigurationTarget.Global
      );
    }
    output?.appendLine("[SECURITY] Restored previous files.hotExit setting.");
  } else {
    output?.appendLine(
      "[SECURITY] files.hotExit changed externally; leaving the user's newer value untouched."
    );
  }

  await context.globalState.update(HOT_EXIT_STATE_KEY, undefined);
}

async function activateSessionModeRuntime(
  context,
  mode,
  output
) {
  if (!isKnownSessionMode(mode)) {
    throw new Error(`Unknown archive session mode: ${String(mode)}`);
  }

  if (modeUsesHotExitGuard(mode)) {
    await enableHotExitGuard(context, output);
  }
}

async function deactivateSessionModeRuntime(context, output) {
  // restoreHotExitGuard is idempotent when this session never enabled it. Keep
  // teardown generic so a partially failed Standard Virtual mount cannot leave
  // an application-wide setting behind.
  await restoreHotExitGuard(context, output);
}

// vscode.openFolder may restart the Extension Host. Store
// password + archive path in SecretStorage only as a one-shot bridge across
// that mount handoff, then delete them immediately. Persistent session metadata
// must not become a long-lived password store.
async function prepareMountHandoff(
  context,
  archivePath,
  password,
  rootUri,
  returnTarget,
  mode
) {
  await context.globalState.update(SESSION_KEY, {
    mode: requireVirtualSessionMode(mode),
    rootUri: rootUri.toString(),
    returnTarget,
    handoffPending: true,
    endedExternally: false
  });

  await context.secrets.store(PASSWORD_KEY, password);
  await context.secrets.store(ARCHIVE_PATH_KEY, archivePath);
}

async function completeMountHandoff(context, saved) {
  await context.secrets.delete(PASSWORD_KEY);
  await context.secrets.delete(ARCHIVE_PATH_KEY);
  await context.secrets.delete(MATERIALIZED_BASELINE_KEY);

  const {
    materializedBaselineHandoff: _materializedBaselineHandoff,
    ...persistentState
  } = saved || {};

  await context.globalState.update(SESSION_KEY, {
    ...persistentState,
    handoffPending: false,
    endedExternally: false
  });
}

async function clearSession(context) {
  await context.secrets.delete(PASSWORD_KEY);
  await context.secrets.delete(ARCHIVE_PATH_KEY);
  await context.secrets.delete(MATERIALIZED_BASELINE_KEY);
  await context.globalState.update(SESSION_KEY, undefined);
}

async function markVirtualSessionEndedExternally(
  context,
  saved,
  output
) {
  if (
    !saved ||
    !isVirtualSessionMode(saved.mode) ||
    saved.handoffPending
  ) {
    return;
  }

  await context.secrets.delete(PASSWORD_KEY);
  await context.secrets.delete(ARCHIVE_PATH_KEY);

  await context.globalState.update(SESSION_KEY, {
    ...saved,
    handoffPending: false,
    endedExternally: true
  });

  await deactivateSessionModeRuntime(context, output);

  output?.appendLine(
    "[SESSION] Virtual archive session ended through VS Code workspace/window lifecycle."
  );
}

async function getHandoffForMountedSession(context, saved, output) {
  if (!saved?.handoffPending) {
    return undefined;
  }

  const [password, archivePath] = await Promise.all([
    context.secrets.get(PASSWORD_KEY),
    context.secrets.get(ARCHIVE_PATH_KEY)
  ]);

  if (password === undefined || archivePath === undefined) {
    return undefined;
  }

  output.appendLine("[SESSION] Consuming one-shot SecretStorage handoff.");
  return { password, archivePath };
}

async function restoreVirtualSession(context, provider, output) {
  if (!hasMountedVirtualWorkspace()) {
    const detached = context.globalState.get(SESSION_KEY);

    if (isVirtualSessionMode(detached?.mode)) {
      await clearSession(context);
      provider.clearArchive();
      output.appendLine(
        "[SESSION] Cleared detached virtual-session metadata because no virtual workspace is mounted."
      );
    }

    await closeCleanEncryptedTabs(output);
    return false;
  }

  const saved = context.globalState.get(SESSION_KEY);
  const mountedRootUri = getMountedVirtualRootUri();

  if (!saved?.rootUri || !isVirtualSessionMode(saved?.mode)) {
    return failClosedVirtualSession(
      context,
      provider,
      output,
      saved,
      "[SESSION] Stale virtual workspace has no valid mode/session metadata; resetting it."
    );
  }

  const expectedRootUri = vscode.Uri.parse(saved.rootUri);
  const expectedScheme = virtualSchemeForMode(saved.mode);
  if (
    !mountedRootUri ||
    expectedRootUri.scheme !== expectedScheme ||
    mountedRootUri.scheme !== expectedScheme ||
    mountedRootUri.authority !== expectedRootUri.authority
  ) {
    return failClosedVirtualSession(
      context,
      provider,
      output,
      saved,
      "[SESSION] Encrypted workspace/session ID mismatch; resetting fail-closed."
    );
  }

  if (saved.endedExternally) {
    return failClosedVirtualSession(
      context,
      provider,
      output,
      saved,
      "[SESSION] Virtual archive workspace was restored after an external VS Code close/reload; returning to the previous workspace fail-closed."
    );
  }

  const handoff = await getHandoffForMountedSession(
    context,
    saved,
    output
  );

  if (!handoff) {
    const message =
      context.extensionMode === vscode.ExtensionMode.Development
        ? "[SESSION] Extension Development Host restored a previous virtual " +
          "workspace without the one-shot password handoff; returning to the " +
          "previous workspace fail-closed."
        : "[SESSION] Previous virtual archive session expired; treating restart as Close.";

    return failClosedVirtualSession(
      context,
      provider,
      output,
      saved,
      message
    );
  }

  const { password, archivePath } = handoff;

  const backend = getNativeBackend(context);
  backend.ensureAvailable();

  if (!fs.existsSync(archivePath)) {
    throw new Error("Archive was not found during Secure Mode handoff.");
  }

  const stableState = await readStableArchiveState(
    backend,
    archivePath,
    password
  );

  provider.loadArchive({
    archivePath,
    password,
    backend,
    entries: stableState.entries,
    rootUri: expectedRootUri,
    archiveFingerprint: stableState.fingerprint,
    headerEncrypted: stableState.headerEncrypted,
    sessionMode: saved.mode,
    restored: true
  });

  await completeMountHandoff(context, saved);
  return true;
}

async function mountVirtualWorkspace(rootUri) {
  // Archive modes use one dedicated workspace path in both development and
  // installed builds. vscode.openFolder restarts the Extension Host in a normal
  // VS Code window; the one-shot SecretStorage handoff bridges that reload.
  //
  // An Extension Development Host launched with F5 has a debug-session
  // lifecycle of its own and may close its test window during this workspace
  // transition. Do not add a development-only mount path to hide that behavior;
  // validate the real lifecycle with an installed VSIX.
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    rootUri,
    {
      forceReuseWindow: true,
      noRecentEntry: true
    }
  );
}


async function resetSessionRuntime(context, provider, output) {
  // Keep session teardown in one place so stale secrets, provider state, and
  // the temporary Hot Exit override cannot drift apart across close/recovery
  // paths.
  await clearSession(context);
  provider.clearArchive();
  await deactivateSessionModeRuntime(context, output);
}

async function failClosedVirtualSession(
  context,
  provider,
  output,
  saved,
  message
) {
  output.appendLine(message);
  await closeCleanEncryptedTabs(output);
  await resetSessionRuntime(context, provider, output);
  await restoreReturnTarget(saved, output);
  return false;
}

async function scheduleHandoffCleanup(context, provider, archivePath, output) {
  // If vscode.openFolder did not restart the Extension Host, the
  // one-shot SecretStorage value is no longer needed. Clear it shortly after
  // the mount. If a restart does happen, this timer disappears and the next
  // activation consumes the secret instead.
  setTimeout(async () => {
    try {
      const saved = context.globalState.get(SESSION_KEY);
      if (
        saved?.handoffPending &&
        provider.archivePath === archivePath &&
        hasMountedVirtualWorkspace()
      ) {
        await completeMountHandoff(context, saved);
        output.appendLine("[SESSION] Cleared unused one-shot password handoff.");
      }
    } catch (error) {
      output.appendLine(`[SESSION CLEANUP ERROR] ${error.message}`);
    }
  }, 2500);
}



async function createMaterializedWorkingDirectory() {
  const warning = await vscode.window.showWarningMessage(
    "Materialized mode writes decrypted archive contents to a temporary " +
    "directory on disk. VS Code, Git, language servers, formatters, backup/" +
    "indexing software, and other local tools may read those plaintext files. " +
    "The directory is removed after a successful normal close/final sync.",
    { modal: true },
    "Open Materialized",
    "Cancel"
  );

  if (warning !== "Open Materialized") {
    return undefined;
  }

  const prefix = path.join(
    os.tmpdir(),
    "7z-secure-workspace-"
  );

  const workingDir = await fs.promises.mkdtemp(prefix);

  // Avoid archive names in TEMP paths. Materialized inherently exposes file
  // contents locally, but the working-directory name need not leak archive
  // naming as an additional breadcrumb.
  return path.resolve(workingDir);
}

async function materializeArchiveToDirectory(
  authenticated,
  workingDir,
  output,
  baselineKey
) {
  validateMaterializableEntries(
    authenticated.stableState.entries
  );

  const entries = authenticated.stableState.entries;
  const directories = entries
    .filter((entry) => entry.isDirectory)
    .sort(
      (a, b) =>
        a.path.split(/[\\/]/).length -
        b.path.split(/[\\/]/).length
    );
  const files = entries.filter((entry) => !entry.isDirectory);
  const contentBaseline = new Map();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Materializing decrypted 7z working directory…",
      cancellable: false
    },
    async (progress) => {
      const total = Math.max(1, directories.length + files.length);
      let completed = 0;
      const tick = (message) => {
        completed += 1;
        progress.report({
          increment: 100 / total,
          message
        });
      };

      for (const entry of directories) {
        const rel = entry.path
          .replace(/\\/g, "/")
          .replace(/\/+$/g, "");
        const target = path.join(workingDir, ...rel.split("/"));
        await fs.promises.mkdir(target, { recursive: true });
        tick("Creating directories…");
      }

      for (const entry of files) {
        const rel = entry.path
          .replace(/\\/g, "/")
          .replace(/\/+$/g, "");
        const target = path.join(workingDir, ...rel.split("/"));
        await fs.promises.mkdir(path.dirname(target), { recursive: true });

        const bytes = await authenticated.backend.read(
          authenticated.archivePath,
          authenticated.password,
          rel
        );
        try {
          await fs.promises.writeFile(target, bytes, { flag: "wx" });
          contentBaseline.set(rel, {
            hmac: materializedContentHmacBytes(
              baselineKey,
              bytes
            ),
            size: bytes.length
          });
        } finally {
          bytes.fill(0);
        }
        tick("Writing decrypted files…");
      }
    }
  );

  output.appendLine(
    `[MATERIALIZED] Decrypted ${files.length} file(s) into the working directory.`
  );

  return contentBaseline;
}

async function prepareMaterializedHandoff(
  context,
  authenticated,
  workingDir,
  returnTarget,
  baselineKey,
  contentBaseline
) {
  await context.globalState.update(SESSION_KEY, {
    mode: SESSION_MODE.MATERIALIZED,
    workingDir,
    archivePath: authenticated.archivePath,
    archiveFingerprint: authenticated.stableState.fingerprint,
    headerEncrypted: authenticated.stableState.headerEncrypted,
    returnTarget,
    handoffPending: true,
    autosyncEnabled: true,
    materializedBaselineHandoff:
      serializeMaterializedBaselineForHandoff(
        baselineKey,
        contentBaseline
      )
  });

  await context.secrets.store(PASSWORD_KEY, authenticated.password);
  await context.secrets.store(
    ARCHIVE_PATH_KEY,
    authenticated.archivePath
  );
  await context.secrets.store(
    MATERIALIZED_BASELINE_KEY,
    baselineKey.toString("hex")
  );
}

async function mountMaterializedWorkspace(
  workingDir
) {
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(workingDir),
    {
      forceReuseWindow: true,
      noRecentEntry: true
    }
  );
}

async function scheduleMaterializedHandoffCleanup(
  context,
  controller,
  output
) {
  // Same one-shot principle as virtual mount handoff. If openFolder happens
  // without restarting the Extension Host, clear the temporary secret here.
  setTimeout(async () => {
    try {
      const saved = context.globalState.get(SESSION_KEY);
      if (
        saved?.mode === SESSION_MODE.MATERIALIZED &&
        saved?.handoffPending &&
        controller.active &&
        hasMountedMaterializedWorkspace(saved)
      ) {
        await completeMountHandoff(context, saved);
        output.appendLine(
          "[MATERIALIZED] Cleared unused one-shot password handoff."
        );
      }
    } catch (error) {
      output.appendLine(
        `[MATERIALIZED HANDOFF CLEANUP ERROR] ${error.message}`
      );
    }
  }, 2500);
}

async function restoreMaterializedSession(
  context,
  controller,
  output
) {
  const saved = context.globalState.get(SESSION_KEY);
  if (!hasMountedMaterializedWorkspace(saved)) {
    return false;
  }

  const backend = getNativeBackend(context);
  backend.ensureAvailable();

  let password;
  let baselineKey;
  if (saved.handoffPending) {
    password = await context.secrets.get(PASSWORD_KEY);
    const baselineKeyHex = await context.secrets.get(
      MATERIALIZED_BASELINE_KEY
    );
    if (
      typeof baselineKeyHex === "string" &&
      /^[0-9a-f]{64}$/i.test(baselineKeyHex)
    ) {
      baselineKey = Buffer.from(baselineKeyHex, "hex");
    }
  }

  controller.load({
    archivePath: saved.archivePath,
    password,
    backend,
    workingDir: saved.workingDir,
    archiveFingerprint: saved.archiveFingerprint,
    headerEncrypted: saved.headerEncrypted,
    entries: [],
    returnTarget: saved.returnTarget,
    baselineKey,
    contentBaseline: undefined
  });

  if (password) {
    const stable = await readStableArchiveState(
      backend,
      saved.archivePath,
      password
    );
    if (!sameArchiveFingerprint(
      stable.fingerprint,
      saved.archiveFingerprint
    )) {
      controller.password = undefined;
      output.appendLine(
        "[MATERIALIZED] Source archive changed during workspace handoff; sync disabled until resolved."
      );
    } else {
      controller.entries = stable.entries;
      controller.headerEncrypted = stable.headerEncrypted;
      controller.contentBaseline =
        restoreMaterializedBaselineFromHandoff(
          baselineKey,
          saved.materializedBaselineHandoff,
          stable.entries
        );

      if (!controller.contentBaseline) {
        if (Buffer.isBuffer(controller.baselineKey)) {
          controller.baselineKey.fill(0);
        }
        controller.baselineKey = undefined;
        output.appendLine(
          "[MATERIALIZED] Content baseline handoff unavailable; the next sync will rebuild it once from the archive."
        );
      } else {
        output.appendLine(
          `[MATERIALIZED] Restored in-memory content baseline for ${controller.contentBaseline.size} file(s).`
        );
      }

      await completeMountHandoff(context, saved);
    }
  } else {
    output.appendLine(
      "[MATERIALIZED] Session resumed after restart; the archive password will be requested on the next save/sync."
    );
  }

  return true;
}

async function scheduleMaterializedCleanup(context, workingDir, output) {
  await context.globalState.update(
    MATERIALIZED_CLEANUP_KEY,
    workingDir
  );
  output.appendLine(
    "[MATERIALIZED] Plaintext working directory scheduled for cleanup after workspace switch."
  );
}

async function processPendingMaterializedCleanup(context, output) {
  const pending = context.globalState.get(
    MATERIALIZED_CLEANUP_KEY
  );
  if (!pending) return;

  const currentFolders = vscode.workspace.workspaceFolders || [];
  if (
    currentFolders.some(
      (folder) =>
        folder.uri.scheme === "file" &&
        sameWindowsPath(folder.uri.fsPath, pending)
    )
  ) {
    return;
  }

  try {
    await fs.promises.rm(pending, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150
    });
    await context.globalState.update(
      MATERIALIZED_CLEANUP_KEY,
      undefined
    );
    output.appendLine(
      "[MATERIALIZED] Plaintext working directory cleanup completed."
    );
  } catch (error) {
    output.appendLine(
      `[MATERIALIZED CLEANUP ERROR] ${error.message}`
    );
  }
}

// Common authentication/preparation path shared by every future mode.
//
// Password validation, native-backend selection, path checks, and the stable
// archive snapshot belong above the mode split. Materialized mode must reuse
// this path rather than inventing a weaker alternate opener.
async function prepareAuthenticatedArchive(
  context,
  output,
  archivePath,
  { source = "command" } = {}
) {
  if (
    typeof archivePath !== "string" ||
    path.extname(archivePath).toLowerCase() !== ".7z"
  ) {
    throw new Error("Select a local .7z archive.");
  }

  const resolvedArchivePath = path.resolve(archivePath);

  let archiveStat;
  try {
    archiveStat = fs.statSync(resolvedArchivePath);
  } catch {
    throw new Error("The selected .7z archive does not exist.");
  }

  if (!archiveStat.isFile()) {
    throw new Error("The selected .7z path is not a file.");
  }

  const backend = getNativeBackend(context);
  backend.ensureAvailable();

  const password = await vscode.window.showInputBox({
    title: "7z Secure Workspace",
    prompt: `Password for ${path.basename(resolvedArchivePath)}`,
    password: true,
    ignoreFocusOut: true
  });

  if (password === undefined) {
    return { status: "cancelled" };
  }

  const stableState = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title:
        source === "direct"
          ? "Opening .7z archive…"
          : "Opening encrypted 7z archive…",
      cancellable: false
    },
    () =>
      readStableArchiveState(
        backend,
        resolvedArchivePath,
        password
      )
  );

  return {
    status: "authenticated",
    archivePath: resolvedArchivePath,
    password,
    backend,
    stableState
  };
}

async function openVirtualArchiveSession({
  context,
  provider,
  output,
  authenticated,
  mode,
  source
}) {
  requireVirtualSessionMode(mode);

  let modeRuntimeActivated = false;
  let handoffPrepared = false;

  try {
    await activateSessionModeRuntime(context, mode, output);
    modeRuntimeActivated = true;

    const returnTarget = captureReturnTarget();
    const rootUri = createSessionRootUri(mode);

    await prepareMountHandoff(
      context,
      authenticated.archivePath,
      authenticated.password,
      rootUri,
      returnTarget,
      mode
    );
    handoffPrepared = true;

    provider.loadArchive({
      archivePath: authenticated.archivePath,
      password: authenticated.password,
      backend: authenticated.backend,
      entries: authenticated.stableState.entries,
      rootUri,
      archiveFingerprint: authenticated.stableState.fingerprint,
      headerEncrypted: authenticated.stableState.headerEncrypted,
      sessionMode: mode
    });

    await mountVirtualWorkspace(rootUri);

    await scheduleHandoffCleanup(
      context,
      provider,
      authenticated.archivePath,
      output
    );

    output.appendLine(
      `[OPEN] ${source === "direct" ? "Direct .7z open" : "Command open"} ` +
      `entered ${sessionModeLabel(mode)} mode.`
    );
    output.show(true);

    vscode.window.showInformationMessage(
      `Mounted ${path.basename(authenticated.archivePath)} in ` +
      `${sessionModeLabel(mode)} mode.`
    );

    return { status: "mounted", mode };
  } catch (error) {
    // If mounting did not trigger the expected Extension Host handoff, clean
    // up one-shot state in this host. A successful openFolder restart makes
    // this code disappear before cleanup, which is the intended handoff path.
    if (!hasMountedVirtualWorkspace()) {
      if (handoffPrepared) {
        await clearSession(context);
      }
      provider.clearArchive();

      if (modeRuntimeActivated) {
        try {
          await deactivateSessionModeRuntime(context, output);
        } catch (restoreError) {
          output.appendLine(
            `[MODE RUNTIME RESTORE ERROR] ${restoreError.message}`
          );
        }
      }
    }

    throw error;
  }
}


async function openMaterializedArchiveSession({
  context,
  materializedController,
  output,
  authenticated,
  source
}) {
  const workingDir = await createMaterializedWorkingDirectory();
  if (!workingDir) {
    return { status: "cancelled" };
  }

  const returnTarget = captureReturnTarget();

  const baselineKey = crypto.randomBytes(32);

  try {
    const contentBaseline = await materializeArchiveToDirectory(
      authenticated,
      workingDir,
      output,
      baselineKey
    );

    await prepareMaterializedHandoff(
      context,
      authenticated,
      workingDir,
      returnTarget,
      baselineKey,
      contentBaseline
    );

    materializedController.load({
      archivePath: authenticated.archivePath,
      password: authenticated.password,
      backend: authenticated.backend,
      workingDir,
      archiveFingerprint: authenticated.stableState.fingerprint,
      headerEncrypted: authenticated.stableState.headerEncrypted,
      entries: authenticated.stableState.entries,
      returnTarget,
      baselineKey,
      contentBaseline
    });

    await mountMaterializedWorkspace(workingDir);

    await scheduleMaterializedHandoffCleanup(
      context,
      materializedController,
      output
    );

    if (hasMountedMaterializedWorkspace(
      context.globalState.get(SESSION_KEY)
    )) {
      materializedController.startAutosyncWatchers(context);
    }

    output.appendLine(
      `[OPEN] ${source === "direct" ? "Direct .7z open" : "Command open"} ` +
      "entered Materialized mode."
    );
    output.show(true);

    return {
      status: "mounted",
      mode: SESSION_MODE.MATERIALIZED
    };
  } catch (error) {
    // Before the workspace switch completes, a failed materialization must not
    // leave a half-populated plaintext directory behind.
    if (!hasMountedMaterializedWorkspace(
      context.globalState.get(SESSION_KEY)
    )) {
      try {
        await fs.promises.rm(workingDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 150
        });
      } catch {}
      await clearSession(context);
      materializedController.clear();
    }
    throw error;
  }
}

async function routeAuthenticatedArchiveSession({
  context,
  provider,
  materializedController,
  output,
  authenticated,
  mode,
  source
}) {
  switch (mode) {
    case SESSION_MODE.SECURE_VIRTUAL:
    case SESSION_MODE.STANDARD_VIRTUAL:
      return openVirtualArchiveSession({
        context,
        provider,
        output,
        authenticated,
        mode,
        source
      });

    case SESSION_MODE.MATERIALIZED:
      return openMaterializedArchiveSession({
        context,
        materializedController,
        output,
        authenticated,
        source
      });

    default:
      throw new Error(`Unknown archive session mode: ${String(mode)}`);
  }
}


async function chooseSessionMode() {
  while (true) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(shield) Secure Virtual",
          description: "CustomDocument editor",
          detail:
            "No intentional plaintext file materialization. " +
            "Encrypted custom backups. Limited editor integration.",
          mode: SESSION_MODE.SECURE_VIRTUAL
        },
        {
          label: "$(edit) Standard Virtual",
          description: "VS Code TextDocument editor",
          detail:
            "Virtual archive storage with normal VS Code editor integration. " +
            "Weaker persistence boundary than Secure Virtual.",
          mode: SESSION_MODE.STANDARD_VIRTUAL
        },
        {
          label: "$(folder-opened) Materialized",
          description: "Plaintext working directory",
          detail:
            "Explicitly decrypt to disk for Git, LSP, formatters, and " +
            "filesystem-dependent tooling. Saves auto-sync; normal close removes plaintext.",
          mode: SESSION_MODE.MATERIALIZED
        }
      ],
      {
        title: "Open encrypted 7z",
        placeHolder: "Choose how this archive session should be opened",
        ignoreFocusOut: true
      }
    );

    if (!picked) {
      return undefined;
    }

    return picked.mode;
  }
}


async function resolveDetachedMaterializedSession(
  context,
  output
) {
  const saved = context.globalState.get(SESSION_KEY);

  if (
    saved?.mode !== SESSION_MODE.MATERIALIZED ||
    hasMountedMaterializedWorkspace(saved)
  ) {
    return true;
  }

  const workingDir =
    typeof saved.workingDir === "string"
      ? saved.workingDir
      : undefined;

  if (!workingDir || !fs.existsSync(workingDir)) {
    output.appendLine(
      "[MATERIALIZED] Detached session had no remaining working directory; clearing stale metadata."
    );
    await clearSession(context);
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    "A previous Materialized working directory still exists. " +
    "This can happen after an older build, crash, or forced Extension Host restart.",
    { modal: true },
    "Delete Plaintext and Forget",
    "Reopen Working Directory",
    "Cancel"
  );

  if (choice === "Delete Plaintext and Forget") {
    try {
      await fs.promises.rm(workingDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150
      });
      await context.globalState.update(
        MATERIALIZED_CLEANUP_KEY,
        undefined
      );
      await clearSession(context);
      output.appendLine(
        "[MATERIALIZED] Detached plaintext working directory deleted and session metadata cleared."
      );
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not delete the detached Materialized directory: ${error.message}`
      );
      return false;
    }
  }

  if (choice === "Reopen Working Directory") {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(workingDir),
      {
        forceReuseWindow: true,
        noRecentEntry: true
      }
    );
    return false;
  }

  return false;
}

async function openArchiveSession(
  context,
  provider,
  materializedController,
  output,
  archivePath,
  {
    source = "command",
    mode = undefined
  } = {}
) {
  if (hasActiveArchiveSessionWorkspace(context)) {
    throw new Error(
      "Another archive session is already open. Close it before opening a different .7z archive."
    );
  }

  if (!await resolveDetachedMaterializedSession(
    context,
    output
  )) {
    return { status: "cancelled" };
  }

  if (mode === undefined) {
    mode = await chooseSessionMode();
    if (mode === undefined) {
      return { status: "cancelled" };
    }
  }

  if (!isKnownSessionMode(mode)) {
    throw new Error(`Unknown archive session mode: ${String(mode)}`);
  }

  const authenticated = await prepareAuthenticatedArchive(
    context,
    output,
    archivePath,
    { source }
  );

  if (authenticated.status === "cancelled") {
    return authenticated;
  }

  return routeAuthenticatedArchiveSession({
    context,
    provider,
    materializedController,
    output,
    authenticated,
    mode,
    source
  });
}


async function prepareFileForMetadataMutation(
  uri,
  provider,
  secureEditorProvider
) {
  switch (provider.sessionMode) {
    case SESSION_MODE.SECURE_VIRTUAL: {
      if (secureEditorProvider.hasDirtyDocument(uri)) {
        vscode.window.showWarningMessage(
          "This file has unsaved changes in Secure Text Editor. " +
          "Save it before changing archive metadata."
        );
        return false;
      }
      return true;
    }

    case SESSION_MODE.STANDARD_VIRTUAL: {
      const dirtyDocument =
        vscode.workspace.textDocuments.find(
          (document) =>
            document.uri.toString() === uri.toString() &&
            document.isDirty
        );

      if (!dirtyDocument) return true;

      const choice = await vscode.window.showWarningMessage(
        "This file has unsaved changes. Save before changing archive metadata?",
        { modal: true },
        "Save and Continue",
        "Cancel"
      );

      if (choice !== "Save and Continue") return false;

      if (!await dirtyDocument.save()) {
        vscode.window.showErrorMessage(
          "The file could not be saved, so archive metadata was not changed."
        );
        return false;
      }

      return true;
    }

    default:
      throw new Error(
        `Editor lifecycle is not implemented for session mode ${
          String(provider.sessionMode)
        }.`
      );
  }
}

async function prepareSessionForArchiveMetadataMutation(
  actionLabel,
  provider,
  secureEditorProvider
) {
  switch (provider.sessionMode) {
    case SESSION_MODE.SECURE_VIRTUAL:
      if (secureEditorProvider.dirtyCount > 0) {
        vscode.window.showWarningMessage(
          "One or more Secure Text Editor files are dirty. " +
          `Save them before ${actionLabel}.`
        );
        return false;
      }
      return true;

    case SESSION_MODE.STANDARD_VIRTUAL:
      return saveDirtyStandardVirtualDocuments(actionLabel);

    default:
      throw new Error(
        `Editor lifecycle is not implemented for session mode ${
          String(provider.sessionMode)
        }.`
      );
  }
}

async function prepareSessionForClose(
  provider,
  secureEditorProvider
) {
  switch (provider.sessionMode) {
    case SESSION_MODE.SECURE_VIRTUAL: {
      const dirtyCount = secureEditorProvider.dirtyCount;
      if (dirtyCount === 0) return true;

      const choice = await vscode.window.showWarningMessage(
        `${dirtyCount} Secure Text Editor file(s) have unsaved changes.`,
        { modal: true },
        "Save and Close",
        "Cancel"
      );
      if (choice !== "Save and Close") return false;

      await vscode.commands.executeCommand(
        "workbench.action.files.saveAll"
      );

      if (secureEditorProvider.dirtyCount > 0) {
        vscode.window.showErrorMessage(
          "The archive session was not closed because a Secure Text Editor " +
          "file could not be saved."
        );
        return false;
      }

      return true;
    }

    case SESSION_MODE.STANDARD_VIRTUAL:
      return saveDirtyStandardVirtualDocuments("closing the archive");

    default:
      throw new Error(
        `Close lifecycle is not implemented for session mode ${
          String(provider.sessionMode)
        }.`
      );
  }
}


async function syncMaterializedSession(
  context,
  controller,
  {
    saveAll = true,
    showProgress = true
  } = {}
) {
  if (saveAll) {
    await vscode.commands.executeCommand(
      "workbench.action.files.saveAll"
    );
  }

  const performSync = () =>
    controller.syncToArchive(context);

  const result = showProgress
    ? await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing Materialized working directory to encrypted 7z…",
          cancellable: false
        },
        performSync
      )
    : await performSync();

  const saved = context.globalState.get(SESSION_KEY);
  if (saved?.mode === SESSION_MODE.MATERIALIZED) {
    await context.globalState.update(SESSION_KEY, {
      ...saved,
      archiveFingerprint: controller.archiveFingerprint,
      headerEncrypted: controller.headerEncrypted,
      handoffPending: false,
      autosyncEnabled: true
    });
  }

  return result;
}

async function finalizeMaterializedExternalExit(
  context,
  controller,
  output
) {
  if (!controller.active) {
    return true;
  }

  if (controller.externalFinalizePromise) {
    return controller.externalFinalizePromise;
  }

  controller.externalFinalizePromise = (async () => {
    try {
      controller.stopAutosyncWatchers();
      await controller.waitForPendingSync();

      // External workspace/window shutdown must not open a password prompt.
      // A normally mounted session has the one-shot password in controller RAM.
      if (!controller.password) {
        throw new Error(
          "Archive password is not available in memory for final Materialized sync."
        );
      }

      await syncMaterializedSession(
        context,
        controller,
        {
          saveAll: false,
          showProgress: false
        }
      );

      const workingDir = controller.workingDir;

      await fs.promises.rm(workingDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150
      });

      await context.globalState.update(
        MATERIALIZED_CLEANUP_KEY,
        undefined
      );
      await clearSession(context);
      controller.clear();

      output?.appendLine(
        "[MATERIALIZED] External VS Code workspace/window exit completed final sync and removed plaintext."
      );
      return true;
    } catch (error) {
      output?.appendLine(
        `[MATERIALIZED EXTERNAL EXIT RECOVERY] ${error.message}`
      );
      output?.appendLine(
        "[MATERIALIZED] Plaintext/session metadata retained for recovery."
      );
      return false;
    }
  })();

  return controller.externalFinalizePromise;
}

async function closeMaterializedSession(
  context,
  controller,
  output,
  savedState
) {
  const choice = await vscode.window.showWarningMessage(
    "Sync the current Materialized working directory to the encrypted 7z, " +
    "close the session, and remove the plaintext TEMP directory?",
    { modal: true },
    "Sync and Close",
    "Cancel"
  );

  if (choice !== "Sync and Close") {
    return false;
  }

  try {
    await syncMaterializedSession(
      context,
      controller,
      {
        saveAll: true,
        showProgress: true
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      "Materialized mode was not closed because final sync failed. " +
      "The plaintext working directory has been kept. " +
      `Reason: ${error.message}`
    );
    return false;
  }

  const workingDir = controller.workingDir;
  controller.stopAutosyncWatchers();

  await scheduleMaterializedCleanup(
    context,
    workingDir,
    output
  );

  await clearSession(context);
  controller.clear();
  await restoreReturnTarget(savedState, output);
  return true;
}



module.exports = {
  MaterializedSessionController,
  saveDirtyStandardVirtualDocuments,
  createSessionRootUri,
  getMountedVirtualRootUri,
  hasMountedMaterializedWorkspace,
  hasActiveArchiveSessionWorkspace,
  captureReturnTarget,
  restoreReturnTarget,
  tabUris,
  getEncryptedTabs,
  closeCleanEncryptedTabs,
  closeAllEncryptedTabs,
  hasMountedVirtualWorkspace,
  enableHotExitGuard,
  restoreHotExitGuard,
  activateSessionModeRuntime,
  deactivateSessionModeRuntime,
  prepareMountHandoff,
  completeMountHandoff,
  clearSession,
  markVirtualSessionEndedExternally,
  getHandoffForMountedSession,
  restoreVirtualSession,
  mountVirtualWorkspace,
  resetSessionRuntime,
  failClosedVirtualSession,
  scheduleHandoffCleanup,
  createMaterializedWorkingDirectory,
  materializeArchiveToDirectory,
  prepareMaterializedHandoff,
  mountMaterializedWorkspace,
  scheduleMaterializedHandoffCleanup,
  restoreMaterializedSession,
  scheduleMaterializedCleanup,
  processPendingMaterializedCleanup,
  prepareAuthenticatedArchive,
  openVirtualArchiveSession,
  openMaterializedArchiveSession,
  routeAuthenticatedArchiveSession,
  chooseSessionMode,
  resolveDetachedMaterializedSession,
  openArchiveSession,
  prepareFileForMetadataMutation,
  prepareSessionForArchiveMetadataMutation,
  prepareSessionForClose,
  syncMaterializedSession,
  finalizeMaterializedExternalExit,
  closeMaterializedSession
};
