"use strict";

const vscode = require("vscode");

const {
  VIRTUAL_SCHEME,
  SESSION_KEY,
  PASSWORD_KEY,
  ARCHIVE_PATH_KEY,
  HOT_EXIT_STATE_KEY,
  ARCHIVE_OPENER_VIEW_TYPE,
  SESSION_MODE
} = require("./src/constants");
const { DirectArchiveOpenerProvider } = require("./src/direct-open/provider");
const {
  VirtualArchiveProvider,
  EncryptionDecorationProvider,
  updateHeaderStatusBar
} = require("./src/virtual/virtual-archive");
const {
  SECURE_EDITOR_VIEW_TYPE,
  SecureTextEditorProvider
} = require("./src/secure-editor/provider");
const { isVirtualResourceScheme, isVirtualSessionMode, sessionModeLabel } = require("./src/archive/core");
const {
  MaterializedSessionController,
  hasMountedMaterializedWorkspace,
  hasMountedVirtualWorkspace,
  activateSessionModeRuntime,
  closeAllEncryptedTabs,
  closeCleanEncryptedTabs,
  closeMaterializedSession,
  finalizeMaterializedExternalExit,
  markVirtualSessionEndedExternally,
  openArchiveSession,
  prepareFileForMetadataMutation,
  prepareSessionForArchiveMetadataMutation,
  prepareSessionForClose,
  processPendingMaterializedCleanup,
  resetSessionRuntime,
  restoreHotExitGuard,
  restoreMaterializedSession,
  restoreReturnTarget,
  restoreVirtualSession,
  syncMaterializedSession
} = require("./src/session/lifecycle");
const { Secure7zUiController } = require("./src/ui/activity-bar");

let runtimeContext;
let runtimeOutput;
let runtimeMaterializedController;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  runtimeContext = context;

  const output = vscode.window.createOutputChannel(
    "7z Secure Workspace"
  );
  runtimeOutput = output;

  const provider = new VirtualArchiveProvider(output);
  const materializedController =
    new MaterializedSessionController(output);
  runtimeMaterializedController = materializedController;

  const uiController =
    new Secure7zUiController(
      context,
      provider,
      materializedController
    );

  const directArchiveOpener =
    new DirectArchiveOpenerProvider(
      (archivePath, options) =>
        openArchiveSession(
          context,
          provider,
          materializedController,
          output,
          archivePath,
          options
        ),
      output
    );

  const secureEditorProvider =
    new SecureTextEditorProvider(provider, output);
  const decorationProvider =
    new EncryptionDecorationProvider(provider);

  const headerStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  headerStatus.name = "7z Secure Header Encryption";
  headerStatus.command =
    "encrypted7zSecure.toggleHeaderEncryption";

  const materializedStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101
  );
  materializedStatus.name = "7z Materialized Mode";
  materializedStatus.text = "$(warning) 7z Materialized: Plaintext";
  materializedStatus.tooltip =
    "Plaintext working directory. Saving a file auto-syncs to the encrypted archive; click to force a full sync.";
  materializedStatus.command =
    "encrypted7zSecure.syncMaterialized";

  const sessionStateListener =
    provider.onDidChangeSessionState(() => {
      updateHeaderStatusBar(headerStatus, provider);
      void uiController.refresh();
    });

  const decorationRegistration =
    vscode.window.registerFileDecorationProvider(
      decorationProvider
    );

  updateHeaderStatusBar(headerStatus, provider);

  // Register providers synchronously before any awaited startup recovery.
  // VS Code may activate us because it needs one of these schemes/custom
  // editors, while recovery itself can redirect and tear down this host.
  const standardFsRegistration =
    vscode.workspace.registerFileSystemProvider(
      VIRTUAL_SCHEME.STANDARD,
      provider,
      {
        isReadonly: false,
        isCaseSensitive: true
      }
    );

  const secureFsRegistration =
    vscode.workspace.registerFileSystemProvider(
      VIRTUAL_SCHEME.SECURE,
      provider,
      {
        isReadonly: false,
        isCaseSensitive: true
      }
    );

  const directArchiveRegistration =
    vscode.window.registerCustomEditorProvider(
      ARCHIVE_OPENER_VIEW_TYPE,
      directArchiveOpener,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: false
        }
      }
    );

  const secureEditorRegistration =
    vscode.window.registerCustomEditorProvider(
      SECURE_EDITOR_VIEW_TYPE,
      secureEditorProvider,
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: {
          retainContextWhenHidden: false
        }
      }
    );

  context.subscriptions.push(
    output,
    provider,
    uiController,
    directArchiveRegistration,
    secureEditorProvider,
    secureEditorRegistration,
    decorationProvider,
    decorationRegistration,
    headerStatus,
    materializedStatus,
    sessionStateListener,
    standardFsRegistration,
    secureFsRegistration
  );

  await processPendingMaterializedCleanup(context, output);

  // Recover/activate mode-specific runtime protection before restoring any
  // virtual editors. The persisted mode is authoritative for this mounted
  // session; a missing/unknown mode is handled fail-closed by restoreVirtualSession().
  const startedInVirtualWorkspace =
    hasMountedVirtualWorkspace();
  const startupSaved = context.globalState.get(SESSION_KEY);
  const startupMode = startupSaved?.mode;

  if (!hasMountedVirtualWorkspace() && context.globalState.get(HOT_EXIT_STATE_KEY)) {
    try {
      await restoreHotExitGuard(context, output);
    } catch (error) {
      output.appendLine(`[HOT EXIT RESTORE ERROR] ${error.message}`);
    }
  }

  if (
    hasMountedVirtualWorkspace() &&
    isVirtualSessionMode(startupMode)
  ) {
    try {
      await activateSessionModeRuntime(
        context,
        startupMode,
        output
      );
    } catch (error) {
      output.appendLine(`[MODE RUNTIME ERROR] ${error.message}`);
      vscode.window.showErrorMessage(
        `${sessionModeLabel(startupMode)} runtime setup failed: ${error.message}`
      );
    }
  }

  try {
    const restored = await restoreVirtualSession(
      context,
      provider,
      output
    );
    if (restored) {
      output.show(true);
    } else if (startedInVirtualWorkspace) {
      output.appendLine(
        "[SESSION] Stale virtual workspace redirected; stopping this activation."
      );
      return;
    }
  } catch (error) {
    output.appendLine(`[RESTORE ERROR] ${error.message}`);
    output.show(true);
    vscode.window.showWarningMessage(error.message);
  }

  try {
    const restoredMaterialized = await restoreMaterializedSession(
      context,
      materializedController,
      output
    );
    if (restoredMaterialized) {
      materializedController.startAutosyncWatchers(context);
      output.show(true);
    }
  } catch (error) {
    output.appendLine(`[MATERIALIZED RESTORE ERROR] ${error.message}`);
    output.show(true);
    vscode.window.showWarningMessage(
      `Materialized session restore warning: ${error.message}`
    );
  }

  if (hasMountedMaterializedWorkspace(
    context.globalState.get(SESSION_KEY)
  )) {
    materializedStatus.show();
    headerStatus.hide();
  } else {
    materializedStatus.hide();
  }

  await uiController.refresh();

  const openCommand = vscode.commands.registerCommand(
    "encrypted7zSecure.openArchive",
    async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        filters: { "7z archives": ["7z"] },
        openLabel: "Open encrypted 7z securely"
      });
      if (!selected?.length) return;

      try {
        await openArchiveSession(
          context,
          provider,
          materializedController,
          output,
          selected[0].fsPath,
          { source: "command" }
        );
        await uiController.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Could not open archive: ${error.message}`
        );
      }
    }
  );

  const closeCommand = vscode.commands.registerCommand(
    "encrypted7zSecure.closeArchive",
    async () => {
      const savedState = context.globalState.get(SESSION_KEY);

      if (savedState?.mode === SESSION_MODE.MATERIALIZED) {
        await closeMaterializedSession(
          context,
          materializedController,
          output,
          savedState
        );
        await uiController.refresh();
        return;
      }

      if (!await prepareSessionForClose(
        provider,
        secureEditorProvider
      )) {
        return;
      }

      if (!await closeAllEncryptedTabs(output)) {
        vscode.window.showErrorMessage(
          "Virtual archive mode was not closed because an editor tab could not be closed."
        );
        return;
      }

      await resetSessionRuntime(
        context,
        provider,
        output
      );
      await uiController.refresh();
      await restoreReturnTarget(savedState, output);
    }
  );


  const syncMaterializedCommand =
    vscode.commands.registerCommand(
      "encrypted7zSecure.syncMaterialized",
      async () => {
        const saved = context.globalState.get(SESSION_KEY);
        if (
          saved?.mode !== SESSION_MODE.MATERIALIZED ||
          !hasMountedMaterializedWorkspace(saved)
        ) {
          vscode.window.showErrorMessage(
            "No Materialized archive session is currently open."
          );
          return;
        }

        try {
          const result = await syncMaterializedSession(
            context,
            materializedController
          );
          vscode.window.showInformationMessage(
            result.changed
              ? "Materialized changes synced to the encrypted archive."
              : "Materialized working directory is already in sync."
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Materialized sync failed: ${error.message}`
          );
        }
      }
    );

  const secureEditorSecurityStatusCommand =
    vscode.commands.registerCommand(
      "encrypted7zSecure.secureEditorSecurityStatus",
      async () => {
        const secureDocuments =
          secureEditorProvider.openDocuments;

        let matchingTextDocuments = 0;
        for (const secureDocument of secureDocuments) {
          matchingTextDocuments +=
            vscode.workspace.textDocuments.filter(
              (textDocument) =>
                textDocument.uri.toString() ===
                secureDocument.uri.toString()
            ).length;
        }

        const backup = secureEditorProvider.lastBackupInfo;
        const backupText = backup
          ? `Last custom backup: AES-256-GCM, ${backup.encryptedBytes} encrypted bytes for ${backup.plaintextBytes} UTF-8 bytes.`
          : "No encrypted custom backup has been observed yet.";

        const summary =
          `Secure CustomDocuments: ${secureDocuments.length}. ` +
          `Matching VS Code TextDocuments: ${matchingTextDocuments}. ` +
          `Dirty Secure documents: ${secureEditorProvider.dirtyCount}. ` +
          backupText;

        output.appendLine(`[SECURE EDITOR SECURITY] ${summary}`);
        output.show(true);

        vscode.window.showInformationMessage(summary);
      }
    );

  const toggleDataEncryptionCommand =
    vscode.commands.registerCommand(
      "encrypted7zSecure.toggleDataEncryption",
      async (uri) => {
        if (!uri || !isVirtualResourceScheme(uri.scheme)) {
          vscode.window.showErrorMessage(
            "Select a virtual archive file in Explorer first."
          );
          return;
        }

        try {
          const node = provider.lookup(uri);
          if (node.type !== vscode.FileType.File) {
            vscode.window.showErrorMessage(
              "Data encryption can only be toggled for files."
            );
            return;
          }

          if (!await prepareFileForMetadataMutation(
            uri,
            provider,
            secureEditorProvider
          )) {
            return;
          }

          const result =
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Updating 7z data encryption...",
                cancellable: false
              },
              () => provider.toggleDataEncryption(uri)
            );

          decorationProvider.refresh(uri);

          if (!result.applicable) {
            vscode.window.showInformationMessage(
              "This file is empty, so it has no data stream to encrypt. " +
              "When content is added, new data will be encrypted by default."
            );
            return;
          }

          vscode.window.showInformationMessage(
            result.encrypted
              ? "Data encryption enabled."
              : "Data encryption disabled."
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not change data encryption: ${error.message} ` +
              `(See "7z Secure Workspace" Output for the failed phase.)`
          );
        }
      }
    );

  const toggleHeaderEncryptionCommand =
    vscode.commands.registerCommand(
      "encrypted7zSecure.toggleHeaderEncryption",
      async () => {
        if (
          !provider.rootUri ||
          provider.headerEncrypted === undefined
        ) {
          vscode.window.showErrorMessage(
            "No Secure Mode archive is currently open."
          );
          return;
        }

        if (!provider.headerEncryptionApplicable) {
          vscode.window.showInformationMessage(
            "7z header encryption is not applicable to an empty archive because there are no member names to encrypt."
          );
          return;
        }

        const desired = !provider.headerEncrypted;

        if (!desired) {
          const choice = await vscode.window.showWarningMessage(
            "Turning off 7z header encryption makes file and directory names " +
              "visible without the archive password. Continue?",
            { modal: true },
            "Turn Off Header Encryption",
            "Cancel"
          );

          if (choice !== "Turn Off Header Encryption") return;
        }

        if (!await prepareSessionForArchiveMetadataMutation(
          "changing header encryption",
          provider,
          secureEditorProvider
        )) {
          return;
        }

        try {
          const encrypted =
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Updating 7z header encryption...",
                cancellable: false
              },
              () => provider.setHeaderEncryption(desired)
            );

          vscode.window.showInformationMessage(
            encrypted
              ? "7z header encryption enabled."
              : "7z header encryption disabled."
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not change header encryption: ${error.message}`
          );
        }
      }
    );

  const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(
    async () => {
      try {
        const saved = context.globalState.get(SESSION_KEY);

        if (
          isVirtualSessionMode(saved?.mode) &&
          !hasMountedVirtualWorkspace() &&
          !saved?.handoffPending
        ) {
          await resetSessionRuntime(
            context,
            provider,
            output
          );
          await uiController.refresh();
          return;
        }

        if (
          saved?.mode === SESSION_MODE.MATERIALIZED &&
          !hasMountedMaterializedWorkspace(saved) &&
          !saved?.handoffPending
        ) {
          await finalizeMaterializedExternalExit(
            context,
            materializedController,
            output
          );
          await uiController.refresh();
        }
      } catch (error) {
        output.appendLine(`[WORKSPACE CLEANUP ERROR] ${error.message}`);
      }
    }
  );

  context.subscriptions.push(
    openCommand,
    closeCommand,
    syncMaterializedCommand,
    secureEditorSecurityStatusCommand,
    toggleDataEncryptionCommand,
    toggleHeaderEncryptionCommand,
    workspaceListener
  );
}

async function deactivate() {
  if (!runtimeContext) return;

  try {
    const saved =
      runtimeContext.globalState.get(SESSION_KEY);

    if (
      isVirtualSessionMode(saved?.mode) &&
      !saved?.handoffPending
    ) {
      await markVirtualSessionEndedExternally(
        runtimeContext,
        saved,
        runtimeOutput
      );
    }

    if (
      saved?.mode === SESSION_MODE.MATERIALIZED &&
      !saved?.handoffPending &&
      runtimeMaterializedController?.active
    ) {
      // Do not require the Materialized folder to still appear in
      // workspaceFolders here. "Close Folder" can remove the first workspace
      // folder before extension deactivation runs.
      await finalizeMaterializedExternalExit(
        runtimeContext,
        runtimeMaterializedController,
        runtimeOutput
      );
    }

    await closeCleanEncryptedTabs(runtimeOutput);

    const latest =
      runtimeContext.globalState.get(SESSION_KEY);

    if (!latest?.handoffPending) {
      await runtimeContext.secrets.delete(PASSWORD_KEY);
      await runtimeContext.secrets.delete(ARCHIVE_PATH_KEY);
    }
  } catch {}
}

module.exports = { activate, deactivate };
