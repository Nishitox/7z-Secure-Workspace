"use strict";

const vscode = require("vscode");
const path = require("node:path");
const crypto = require("node:crypto");

class DirectArchiveDocument {
  constructor(uri) {
    this.uri = uri;
    this.opening = false;
    this.attempted = false;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }
}

// The .7z custom editor is intentionally only a launcher. It must never
// extract archive contents into this Webview. Its sole job is to route a local
// .7z file into the hardened encrypted7z:// workspace after authentication.
class DirectArchiveOpenerProvider {
  constructor(openArchive, output) {
    this.openArchive = openArchive;
    this.output = output;
  }

  async openCustomDocument(uri, _openContext, _token) {
    return new DirectArchiveDocument(uri);
  }

  async resolveCustomEditor(
    document,
    webviewPanel,
    _token
  ) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };

    webviewPanel.webview.html =
      this.getWebviewHtml(
        path.basename(document.uri.path || document.uri.fsPath)
      );

    const disposable =
      webviewPanel.webview.onDidReceiveMessage(
        async (message) => {
          if (
            message?.type === "ready" &&
            !document.attempted
          ) {
            document.attempted = true;
            await this.tryOpen(document, webviewPanel.webview);
            return;
          }

          if (message?.type === "retry") {
            await this.tryOpen(document, webviewPanel.webview);
          }
        }
      );

    webviewPanel.onDidDispose(() => {
      disposable.dispose();
    });
  }

  async tryOpen(document, webview) {
    if (document.disposed || document.opening) return;

    if (document.uri.scheme !== "file") {
      await webview.postMessage({
        type: "state",
        state: "unsupported",
        message:
          "Direct archive opening currently supports local .7z files only."
      });
      return;
    }

    if (
      path.extname(document.uri.fsPath).toLowerCase() !== ".7z"
    ) {
      await webview.postMessage({
        type: "state",
        state: "unsupported",
        message: "This resource is not a .7z archive."
      });
      return;
    }

    document.opening = true;

    try {
      await webview.postMessage({
        type: "state",
        state: "opening",
        message: "Choose an open mode and authenticate…"
      });

      const result = await this.openArchive(
        document.uri.fsPath,
        { source: "direct" }
      );

      if (result?.status === "cancelled") {
        await webview.postMessage({
          type: "state",
          state: "cancelled",
          message: "Opening was cancelled."
        });
      }
    } catch (error) {
      this.output.appendLine(
        `[DIRECT OPEN ERROR] ${error.message}`
      );
      this.output.show(true);

      await webview.postMessage({
        type: "state",
        state: "error",
        message: error.message
      });
    } finally {
      document.opening = false;
    }
  }

  getWebviewHtml(filename) {
    const nonce = crypto.randomBytes(18).toString("base64");
    const safeFilename = String(filename || "archive.7z")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';"
>
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>
<style nonce="${nonce}">
:root {
  color-scheme: light dark;
}
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
}
body {
  display: grid;
  place-items: center;
}
#card {
  width: min(560px, calc(100vw - 48px));
  padding: 28px;
  border: 1px solid var(--vscode-editorGroup-border);
  border-radius: 6px;
  background: var(--vscode-sideBar-background);
}
h1 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
}
#filename {
  margin-bottom: 20px;
  color: var(--vscode-descriptionForeground);
  overflow-wrap: anywhere;
}
#message {
  min-height: 24px;
  line-height: 1.5;
}
#retry {
  display: none;
  margin-top: 16px;
  padding: 6px 12px;
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
#retry:hover {
  background: var(--vscode-button-hoverBackground);
}
#note {
  margin-top: 20px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
</head>
<body>
  <main id="card">
    <h1>7z Secure Workspace</h1>
    <div id="filename">${safeFilename}</div>
    <div id="message">Preparing Secure Mode…</div>
    <button id="retry">Retry</button>
    <div id="note">
      The archive is opened through the hardened encrypted7z virtual workspace.
    </div>
  </main>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");

  retry.addEventListener("click", () => {
    retry.style.display = "none";
    message.textContent = "Retrying…";
    vscode.postMessage({ type: "retry" });
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type !== "state") return;

    message.textContent = data.message || "";

    if (
      data.state === "cancelled" ||
      data.state === "error"
    ) {
      retry.style.display = "inline-block";
    } else {
      retry.style.display = "none";
    }
  });

  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
  }
}



module.exports = {
  DirectArchiveDocument,
  DirectArchiveOpenerProvider
};
