"use strict";

const vscode = require("vscode");

const { SESSION_KEY, SECURE_UI_VIEW_ID, SESSION_MODE } = require("../constants");
const { isVirtualSessionMode } = require("../archive/core");
const { hasMountedVirtualWorkspace, hasMountedMaterializedWorkspace } = require("../session/lifecycle");

class EmptyCommandViewProvider {
  getChildren() {
    return [];
  }

  getTreeItem(element) {
    return element;
  }
}

class Secure7zUiController {
  constructor(
    context,
    provider,
    materializedController
  ) {
    this.context = context;
    this.provider = provider;
    this.materializedController =
      materializedController;

    this.treeProvider =
      new EmptyCommandViewProvider();

    this.view = vscode.window.createTreeView(
      SECURE_UI_VIEW_ID,
      {
        treeDataProvider: this.treeProvider,
        showCollapseAll: false
      }
    );
  }

  async refresh() {
    const saved =
      this.context.globalState.get(SESSION_KEY);

    const virtualSession =
      isVirtualSessionMode(saved?.mode) &&
      hasMountedVirtualWorkspace();

    const materializedSession =
      saved?.mode === SESSION_MODE.MATERIALIZED &&
      hasMountedMaterializedWorkspace(saved);

    const sessionOpen =
      virtualSession || materializedSession;

    const secureVirtualSession =
      virtualSession &&
      saved?.mode === SESSION_MODE.SECURE_VIRTUAL;

    const standardVirtualSession =
      virtualSession &&
      saved?.mode === SESSION_MODE.STANDARD_VIRTUAL;

    const headerEncryptionApplicable =
      virtualSession &&
      this.provider.headerEncryptionApplicable;

    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.sessionOpen",
        sessionOpen
      ),
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.virtualSession",
        virtualSession
      ),
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.secureVirtualSession",
        secureVirtualSession
      ),
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.standardVirtualSession",
        standardVirtualSession
      ),
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.materializedSession",
        materializedSession
      ),
      vscode.commands.executeCommand(
        "setContext",
        "encrypted7zSecure.headerEncryptionApplicable",
        headerEncryptionApplicable
      )
    ]);

    if (secureVirtualSession) {
      this.view.description =
        !headerEncryptionApplicable
          ? "Secure Virtual · Header N/A"
          : this.provider.headerEncrypted === false
            ? "Secure Virtual · Header visible"
            : "Secure Virtual · Header encrypted";
      return;
    }

    if (standardVirtualSession) {
      this.view.description =
        !headerEncryptionApplicable
          ? "Standard Virtual · Header N/A"
          : this.provider.headerEncrypted === false
            ? "Standard Virtual · Header visible"
            : "Standard Virtual · Header encrypted";
      return;
    }

    if (materializedSession) {
      this.view.description =
        "Materialized · Autosync";
      return;
    }

    if (
      saved?.mode === SESSION_MODE.MATERIALIZED &&
      saved?.workingDir
    ) {
      this.view.description =
        "Materialized recovery pending";
      return;
    }

    this.view.description = "No archive open";
  }

  dispose() {
    this.view.dispose();
  }
}


module.exports = {
  EmptyCommandViewProvider,
  Secure7zUiController
};
