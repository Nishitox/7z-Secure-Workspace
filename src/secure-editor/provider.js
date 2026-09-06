"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { normalizeFsPath, validateVirtualPath } = require("../security/paths");
const { isSecureVirtualUri, sameArchiveFingerprint } = require("../archive/core");

const SECURE_EDITOR_VIEW_TYPE =
  "encrypted7zSecure.secureTextEditor";
const SECURE_BACKUP_MAGIC_V2 = Buffer.from("E7SBK02\0", "ascii");
const SECURE_BACKUP_SALT_BYTES = 16;
const SECURE_BACKUP_IV_BYTES = 12;
const SECURE_BACKUP_TAG_BYTES = 16;
const SECURE_BACKUP_PBKDF2_ITERATIONS = 120000;

function pbkdf2Async(passwordBytes, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      passwordBytes,
      salt,
      SECURE_BACKUP_PBKDF2_ITERATIONS,
      32,
      "sha256",
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      }
    );
  });
}

// VS Code requires editable CustomEditorProviders to implement backup.
// Persist only authenticated ciphertext at the destination VS Code gives us;
// never write the document text itself as a working-copy backup.
async function encryptSecureBackupPayload(
  payload,
  password
) {
  const serialized = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  );
  const passwordBytes = Buffer.from(password, "utf8");
  const salt = crypto.randomBytes(SECURE_BACKUP_SALT_BYTES);
  const iv = crypto.randomBytes(SECURE_BACKUP_IV_BYTES);

  let key;
  try {
    key = await pbkdf2Async(passwordBytes, salt);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      key,
      iv
    );
    const ciphertext = Buffer.concat([
      cipher.update(serialized),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([
      SECURE_BACKUP_MAGIC_V2,
      salt,
      iv,
      tag,
      ciphertext
    ]);
  } finally {
    serialized.fill(0);
    passwordBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    if (key) key.fill(0);
  }
}

async function decryptSecureBackupPayload(
  data,
  password
) {
  const raw = Buffer.from(data);
  const magicLength = SECURE_BACKUP_MAGIC_V2.length;
  const minLength =
    magicLength +
    SECURE_BACKUP_SALT_BYTES +
    SECURE_BACKUP_IV_BYTES +
    SECURE_BACKUP_TAG_BYTES;

  if (raw.length < minLength) {
    raw.fill(0);
    throw new Error("Secure Editor backup is truncated.");
  }

  const isV2 = raw.subarray(
    0,
    SECURE_BACKUP_MAGIC_V2.length
  ).equals(SECURE_BACKUP_MAGIC_V2);

  if (!isV2) {
    raw.fill(0);
    throw new Error(
      "Secure Editor backup has an unexpected format."
    );
  }

  let offset = magicLength;
  const salt = Buffer.from(
    raw.subarray(
      offset,
      offset + SECURE_BACKUP_SALT_BYTES
    )
  );
  offset += SECURE_BACKUP_SALT_BYTES;

  const iv = Buffer.from(
    raw.subarray(
      offset,
      offset + SECURE_BACKUP_IV_BYTES
    )
  );
  offset += SECURE_BACKUP_IV_BYTES;

  const tag = Buffer.from(
    raw.subarray(
      offset,
      offset + SECURE_BACKUP_TAG_BYTES
    )
  );
  offset += SECURE_BACKUP_TAG_BYTES;

  const ciphertext = Buffer.from(raw.subarray(offset));
  const passwordBytes = Buffer.from(password, "utf8");

  let key;
  let plaintext;
  try {
    key = await pbkdf2Async(passwordBytes, salt);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      iv
    );
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    const decoded = plaintext.toString("utf8");

    let payload;
    try {
      payload = JSON.parse(decoded);
    } catch {
      throw new Error(
        "Secure Editor backup payload is not valid JSON."
      );
    }

    if (
      payload?.formatVersion !== 2 ||
      typeof payload.text !== "string"
    ) {
      throw new Error(
        "Secure Editor backup payload is invalid."
      );
    }

    return payload;
  } finally {
    passwordBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    if (key) key.fill(0);
    if (plaintext) plaintext.fill(0);
    raw.fill(0);
  }
}

function computeTextDelta(before, after) {
  if (before === after) {
    return undefined;
  }

  let start = 0;
  const maxPrefix = Math.min(
    before.length,
    after.length
  );

  while (
    start < maxPrefix &&
    before.charCodeAt(start) === after.charCodeAt(start)
  ) {
    start++;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;

  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) ===
      after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd--;
    afterEnd--;
  }

  return {
    start,
    deletedText: before.slice(start, beforeEnd),
    insertedText: after.slice(start, afterEnd)
  };
}

function applyTextDelta(text, delta, undo = false) {
  const removeText = undo
    ? delta.insertedText
    : delta.deletedText;
  const insertText = undo
    ? delta.deletedText
    : delta.insertedText;

  const actual = text.slice(
    delta.start,
    delta.start + removeText.length
  );

  if (actual !== removeText) {
    throw new Error(
      "Secure Editor edit history no longer matches the document."
    );
  }

  return (
    text.slice(0, delta.start) +
    insertText +
    text.slice(delta.start + removeText.length)
  );
}

function decodeSecureUtf8(bytes) {
  const input = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  const text = input.toString("utf8");
  const roundTrip = Buffer.from(text, "utf8");
  const valid =
    roundTrip.length === input.length &&
    roundTrip.equals(input);

  roundTrip.fill(0);
  input.fill(0);

  if (!valid || text.includes("\u0000")) {
    throw new Error(
      "Secure Text Editor supports UTF-8 text files only."
    );
  }

  return text;
}

function languageHintForUri(uri) {
  const extension = path.extname(uri.path).toLowerCase();
  const hints = new Map([
    [".md", "markdown"],
    [".markdown", "markdown"],
    [".json", "json"],
    [".jsonc", "json"],
    [".js", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".ts", "typescript"],
    [".tsx", "typescript"],
    [".jsx", "javascript"],
    [".py", "python"],
    [".java", "java"],
    [".c", "c"],
    [".h", "c"],
    [".cpp", "cpp"],
    [".cc", "cpp"],
    [".hpp", "cpp"],
    [".cs", "csharp"],
    [".html", "html"],
    [".htm", "html"],
    [".xml", "xml"],
    [".css", "css"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".toml", "toml"],
    [".ini", "ini"],
    [".txt", "plaintext"],
    [".log", "plaintext"]
  ]);
  return hints.get(extension) || "plaintext";
}

class SecureTextDocument {
  constructor(
    uri,
    text,
    {
      restoredFromBackup = false,
      recoveryConflict = false,
      onDispose = undefined
    } = {}
  ) {
    this.uri = uri;
    this.text = text;
    this.savedText = restoredFromBackup ? undefined : text;
    this.restoredFromBackup = restoredFromBackup;
    this.recoveryConflict = recoveryConflict;
    this.webviews = new Set();
    this.disposed = false;
    this.onDispose = onDispose;
  }

  get dirty() {
    if (this.restoredFromBackup) return true;
    if (this.savedText === undefined) return true;
    return this.text !== this.savedText;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.text = "";
    this.savedText = undefined;
    this.webviews.clear();

    try {
      this.onDispose?.();
    } finally {
      this.onDispose = undefined;
    }
  }
}

// High-security editing path for virtual mode.
//
// This intentionally uses CustomEditorProvider + a private CustomDocument
// instead of VS Code TextDocument. The purpose is to keep VS Code's normal
// plaintext working-copy backup path out of this mode. This component is NOT
// intended to become a full reimplementation of the VS Code text editor;
// advanced editor/tooling features belong in Standard Virtual or Materialized
// mode when their security trade-offs are acceptable.
class SecureTextEditorProvider {
  constructor(secureFsProvider, output) {
    this.secureFsProvider = secureFsProvider;
    this.output = output;
    this.documents = new Map();
    this.lastBackupInfo = undefined;

    this._onDidChangeCustomDocument =
      new vscode.EventEmitter();
    this.onDidChangeCustomDocument =
      this._onDidChangeCustomDocument.event;
  }

  dispose() {
    this._onDidChangeCustomDocument.dispose();
    this.documents.clear();
  }

  get openDocuments() {
    return [...this.documents.values()];
  }

  hasDirtyDocument(uri) {
    const document = this.documents.get(uri.toString());
    return Boolean(document?.dirty);
  }

  get dirtyCount() {
    return this.openDocuments.filter(
      (document) => document.dirty
    ).length;
  }

  async openCustomDocument(
    uri,
    openContext,
    _token
  ) {
    if (!isSecureVirtualUri(uri)) {
      throw new Error(
        "Secure Text Editor can only open Secure Virtual resources."
      );
    }

    this.secureFsProvider.ensureSession();
    this.secureFsProvider.ensureUriSession(uri);

    let text;
    let restoredFromBackup = false;
    let recoveryConflict = false;

    if (openContext.backupId) {
      const backupUri = vscode.Uri.parse(
        openContext.backupId
      );
      const encryptedBackup =
        await vscode.workspace.fs.readFile(backupUri);

      const payload = await decryptSecureBackupPayload(
        encryptedBackup,
        this.secureFsProvider.password
      );

      text = payload.text;
      restoredFromBackup = true;

      const currentMemberPath = validateVirtualPath(
        normalizeFsPath(uri.path)
      );

      if (
        payload.memberPath &&
        payload.memberPath !== currentMemberPath
      ) {
        throw new Error(
          "Encrypted backup belongs to a different archive member."
        );
      }

      if (
        payload.archivePath &&
        path.resolve(payload.archivePath) !==
          path.resolve(this.secureFsProvider.archivePath)
      ) {
        throw new Error(
          "Encrypted backup belongs to a different .7z archive."
        );
      }

      if (
        payload.archiveFingerprint &&
        !sameArchiveFingerprint(
          payload.archiveFingerprint,
          this.secureFsProvider.archiveFingerprint
        )
      ) {
        recoveryConflict = true;
      }

      this.output.appendLine(
        `[SECURE EDITOR RESTORE] Encrypted backup restored (${encryptedBackup.byteLength} bytes).`
      );

      if (recoveryConflict) {
        this.output.appendLine(
          "[SECURE EDITOR RECOVERY CONFLICT] The archive changed after this backup was created."
        );
      }
    } else {
      const bytes = await this.secureFsProvider.readFile(uri);
      text = decodeSecureUtf8(bytes);
    }

    const documentKey = uri.toString();
    const document = new SecureTextDocument(
      uri,
      text,
      {
        restoredFromBackup,
        recoveryConflict,
        onDispose: () => {
          if (
            this.documents.get(documentKey) === document
          ) {
            this.documents.delete(documentKey);
          }
        }
      }
    );

    this.documents.set(documentKey, document);

    this.output.appendLine(
      "[SECURE EDITOR OPEN] CustomDocument opened without a VS Code TextDocument."
    );

    return document;
  }

  async applyEditorText(
    document,
    newText,
    sourceWebview,
    label = "Edit"
  ) {
    if (
      typeof newText !== "string" ||
      newText === document.text
    ) {
      return;
    }

    const delta = computeTextDelta(
      document.text,
      newText
    );
    if (!delta) return;

    const applyDeltaState = async (undo) => {
      document.text = applyTextDelta(
        document.text,
        delta,
        undo
      );
      document.restoredFromBackup = false;
      document.recoveryConflict = false;

      await this.postDocumentState(
        document,
        {
          type: "replace",
          text: document.text,
          reason: undo ? "undo" : "redo"
        }
      );
    };

    document.text = newText;
    document.restoredFromBackup = false;
    document.recoveryConflict = false;

    await this.postDocumentState(
      document,
      {
        type: "replace",
        text: document.text,
        reason: "peer-edit"
      },
      sourceWebview
    );

    this._onDidChangeCustomDocument.fire({
      document,
      label,
      undo: async () => {
        await applyDeltaState(true);
      },
      redo: async () => {
        await applyDeltaState(false);
      }
    });
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
        webviewPanel.webview,
        languageHintForUri(document.uri)
      );

    document.webviews.add(webviewPanel.webview);

    const messageDisposable =
      webviewPanel.webview.onDidReceiveMessage(
        async (message) => {
          try {
            if (message?.type === "ready") {
              await webviewPanel.webview.postMessage({
                type: "load",
                text: document.text,
                language: languageHintForUri(document.uri),
                restoredFromBackup:
                  document.restoredFromBackup,
                recoveryConflict:
                  document.recoveryConflict
              });
              return;
            }

            if (message?.type === "edit") {
              await this.applyEditorText(
                document,
                message.text,
                webviewPanel.webview,
                message.label || "Edit"
              );
              return;
            }

            if (message?.type === "save") {
              if (typeof message.text === "string") {
                await this.applyEditorText(
                  document,
                  message.text,
                  webviewPanel.webview,
                  "Edit"
                );
              }
              await vscode.commands.executeCommand(
                "workbench.action.files.save"
              );
              return;
            }

            if (message?.type === "undo") {
              await vscode.commands.executeCommand("undo");
              return;
            }

            if (message?.type === "redo") {
              await vscode.commands.executeCommand("redo");
              return;
            }

            if (message?.type === "securityStatus") {
              await vscode.commands.executeCommand(
                "encrypted7zSecure.secureEditorSecurityStatus"
              );
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Secure Editor error: ${error.message}`
            );
          }
        }
      );

    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      document.webviews.delete(webviewPanel.webview);
    });
  }

  async saveCustomDocument(document, _cancellation) {
    if (document.recoveryConflict) {
      throw vscode.FileSystemError.Unavailable(
        "The archive changed after this encrypted backup was created. Revert the recovered document to reload the current archive before editing again."
      );
    }

    const bytes = Buffer.from(document.text, "utf8");
    try {
      await this.secureFsProvider.writeFile(
        document.uri,
        bytes,
        {
          create: false,
          overwrite: true
        }
      );
      // `dirty` is derived from text vs savedText. Do not assign to it: the
      // CustomDocument intentionally exposes `dirty` as a getter only. VS Code
      // marks the custom editor clean when this save callback resolves.
      document.savedText = document.text;

      await this.postDocumentState(document, {
        type: "saved"
      });

      this.output.appendLine(
        `[SECURE EDITOR SAVE] Saved through encrypted archive provider (${bytes.length} bytes).`
      );
    } finally {
      bytes.fill(0);
    }
  }

  async saveCustomDocumentAs(
    _document,
    _destination,
    _cancellation
  ) {
    throw vscode.FileSystemError.NoPermissions(
      "Secure Text Editor disables Save As to prevent accidental plaintext export."
    );
  }

  async revertCustomDocument(document, _cancellation) {
    const bytes = await this.secureFsProvider.readFile(
      document.uri
    );
    const text = decodeSecureUtf8(bytes);

    document.text = text;
    document.savedText = text;
    document.restoredFromBackup = false;
    document.recoveryConflict = false;

    await this.postDocumentState(document, {
      type: "replace",
      text,
      reason: "revert"
    });

    this.output.appendLine(
      "[SECURE EDITOR REVERT] Reloaded from encrypted archive."
    );
  }

  async backupCustomDocument(
    document,
    backupContext,
    _cancellation
  ) {
    this.secureFsProvider.ensureSession();

    const memberPath = validateVirtualPath(
      normalizeFsPath(document.uri.path)
    );

    const payload = {
      formatVersion: 2,
      text: document.text,
      archivePath: this.secureFsProvider.archivePath,
      memberPath,
      archiveFingerprint:
        this.secureFsProvider.archiveFingerprint,
      createdAt: new Date().toISOString()
    };

    const encrypted =
      await encryptSecureBackupPayload(
        payload,
        this.secureFsProvider.password
      );

    try {
      await vscode.workspace.fs.writeFile(
        backupContext.destination,
        encrypted
      );

      this.lastBackupInfo = {
        encryptedBytes: encrypted.length,
        plaintextBytes: Buffer.byteLength(
          document.text,
          "utf8"
        ),
        magic: "E7SBK02",
        timestamp: Date.now()
      };

      this.output.appendLine(
        `[SECURE EDITOR BACKUP] AES-256-GCM encrypted backup written (${encrypted.length} bytes).`
      );
    } finally {
      encrypted.fill(0);
      payload.text = "";
      payload.archivePath = "";
      payload.memberPath = "";
    }

    const backupUri = backupContext.destination;

    return {
      id: backupUri.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(backupUri);
        } catch {
          // VS Code may already have removed the backup.
        }
      }
    };
  }

  async postDocumentState(
    document,
    message,
    excludeWebview = undefined
  ) {
    await Promise.all(
      [...document.webviews]
        .filter(
          (webview) => webview !== excludeWebview
        )
        .map((webview) =>
          webview.postMessage(message)
        )
    );
  }

  getWebviewHtml(webview, language) {
    const nonce = crypto.randomBytes(18).toString("base64");
    const escapedLanguage = String(language).replace(
      /[^a-z0-9_-]/gi,
      ""
    );

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
* {
  box-sizing: border-box;
}
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
}
#root {
  height: 100%;
  display: grid;
  grid-template-rows: 28px 1fr 24px;
}
#topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 9px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-editorGroup-border);
  font-family: var(--vscode-font-family);
  font-size: 11px;
  user-select: none;
}
#secureBadge {
  padding: 2px 6px;
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
}
#languageBadge {
  color: var(--vscode-descriptionForeground);
}
#findbar {
  margin-left: auto;
  display: none;
  align-items: center;
  gap: 4px;
  font-family: var(--vscode-font-family);
}
#findbar.visible {
  display: flex;
}
#findInput, #replaceInput {
  width: 180px;
  height: 22px;
  border: 1px solid var(--vscode-input-border, transparent);
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  padding: 2px 6px;
}
.findButton {
  height: 22px;
  border: 0;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
#matchCount {
  min-width: 58px;
  color: var(--vscode-descriptionForeground);
  text-align: right;
}
#editorFrame {
  min-height: 0;
  display: grid;
  grid-template-columns: 58px 1fr;
  background: var(--vscode-editor-background);
}
#gutter {
  overflow: hidden;
  padding: 8px 10px 50vh 0;
  text-align: right;
  white-space: pre;
  color: var(--vscode-editorLineNumber-foreground);
  background: var(--vscode-editorGutter-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 14px);
  line-height: 1.5;
  user-select: none;
}
#editorPane {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
#highlight, #editor {
  position: absolute;
  inset: 0;
  margin: 0;
  border: 0;
  padding: 8px 14px 50vh 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 14px);
  font-weight: var(--vscode-editor-font-weight, normal);
  line-height: 1.5;
  tab-size: 4;
  white-space: pre;
  overflow: auto;
}
#highlight {
  pointer-events: none;
  color: var(--vscode-editor-foreground);
}
#editor {
  resize: none;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: var(--vscode-editorCursor-foreground);
  -webkit-text-fill-color: transparent;
  overflow: auto;
}
#editor::selection {
  background: var(--vscode-editor-selectionBackground);
}
.tok-comment {
  color: var(--vscode-editorLineNumber-foreground);
  font-style: italic;
}
.tok-string {
  color: var(--vscode-symbolIcon-stringForeground, #ce9178);
}
.tok-number {
  color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
}
.tok-keyword {
  color: var(--vscode-symbolIcon-keywordForeground, #c586c0);
}
.tok-heading {
  color: var(--vscode-textLink-foreground);
  font-weight: 700;
}
.tok-code {
  color: var(--vscode-symbolIcon-stringForeground, #ce9178);
}
#status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 9px;
  background: var(--vscode-statusBar-background);
  color: var(--vscode-statusBar-foreground);
  font-family: var(--vscode-font-family);
  font-size: 11px;
  user-select: none;
}
#state {
  font-weight: 600;
}
#securityNote {
  opacity: 0.8;
}
#securityButton {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-decoration: underline;
}
</style>
</head>
<body>
<div id="root">
  <div id="topbar">
    <span id="secureBadge">SECURE EDITOR</span>
    <span>Encrypted 7z memory editor</span>
    <span id="languageBadge">${escapedLanguage}</span>
    <div id="findbar">
      <input id="findInput" type="text" placeholder="Find">
      <input id="replaceInput" type="text" placeholder="Replace">
      <span id="matchCount">No results</span>
      <button class="findButton" id="prevButton" title="Previous">↑</button>
      <button class="findButton" id="nextButton" title="Next">↓</button>
      <button class="findButton" id="replaceButton" title="Replace">Replace</button>
      <button class="findButton" id="replaceAllButton" title="Replace All">All</button>
      <button class="findButton" id="closeFind" title="Close">×</button>
    </div>
  </div>
  <div id="editorFrame">
    <div id="gutter"></div>
    <div id="editorPane">
      <pre id="highlight" aria-hidden="true"></pre>
      <textarea
        id="editor"
        spellcheck="false"
        wrap="off"
        aria-label="Secure Text Editor"
      ></textarea>
    </div>
  </div>
  <div id="status">
    <span id="state">Loading…</span>
    <span id="position">Ln 1, Col 1</span>
    <span id="securityNote">Encrypted backup • no TextDocument</span>
    <button id="securityButton">Security status</button>
  </div>
</div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const editor = document.getElementById("editor");
  const highlight = document.getElementById("highlight");
  const gutter = document.getElementById("gutter");
  const state = document.getElementById("state");
  const position = document.getElementById("position");
  const findbar = document.getElementById("findbar");
  const findInput = document.getElementById("findInput");
  const replaceInput = document.getElementById("replaceInput");
  const matchCount = document.getElementById("matchCount");
  const prevButton = document.getElementById("prevButton");
  const nextButton = document.getElementById("nextButton");
  const replaceButton = document.getElementById("replaceButton");
  const replaceAllButton = document.getElementById("replaceAllButton");
  const closeFind = document.getElementById("closeFind");
  const securityButton = document.getElementById("securityButton");
  const languageBadge = document.getElementById("languageBadge");

  let language = "${escapedLanguage}";
  let sendTimer;
  let matches = [];
  let matchIndex = -1;
  let suppressInput = false;
  const restoredUiState = vscode.getState() || {};

  function saveUiState() {
    vscode.setState({
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      scrollTop: editor.scrollTop,
      scrollLeft: editor.scrollLeft,
      find: findInput.value,
      replace: replaceInput.value,
      findVisible: findbar.classList.contains("visible")
    });
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function genericHighlight(text) {
    const keywordPattern =
      /\\b(?:const|let|var|function|class|return|if|else|for|while|switch|case|break|continue|new|try|catch|finally|throw|async|await|import|export|from|def|lambda|yield|with|as|pass|True|False|None|public|private|protected|static|final|void|int|long|double|float|boolean|char|string|struct|enum|namespace|using|include|package|interface|extends|implements|true|false|null)\\b/;
    const tokenPattern =
      /(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\x60(?:\\\\.|[^\\x60\\\\])*\\x60|\\b\\d+(?:\\.\\d+)?\\b|\\b(?:const|let|var|function|class|return|if|else|for|while|switch|case|break|continue|new|try|catch|finally|throw|async|await|import|export|from|def|lambda|yield|with|as|pass|True|False|None|public|private|protected|static|final|void|int|long|double|float|boolean|char|string|struct|enum|namespace|using|include|package|interface|extends|implements|true|false|null)\\b)/g;

    let output = "";
    let last = 0;
    let match;
    while ((match = tokenPattern.exec(text)) !== null) {
      output += escapeHtml(text.slice(last, match.index));
      const token = match[0];
      let cssClass = "tok-keyword";
      if (
        token.startsWith("//") ||
        token.startsWith("/*") ||
        token.startsWith("#")
      ) {
        cssClass = "tok-comment";
      } else if (
        token.startsWith('"') ||
        token.startsWith("'") ||
        token.startsWith("\`")
      ) {
        cssClass = "tok-string";
      } else if (/^\\d/.test(token)) {
        cssClass = "tok-number";
      } else if (!keywordPattern.test(token)) {
        cssClass = "";
      }

      output += cssClass
        ? '<span class="' + cssClass + '">' +
            escapeHtml(token) +
          "</span>"
        : escapeHtml(token);
      last = match.index + token.length;
    }
    output += escapeHtml(text.slice(last));
    return output;
  }

  function markdownHighlight(text) {
    return text.split("\\n").map((line) => {
      const escaped = escapeHtml(line);
      if (/^\\s{0,3}#{1,6}\\s/.test(line)) {
        return '<span class="tok-heading">' + escaped + "</span>";
      }
      return escaped.replace(
        /(\\x60[^\\x60]*\\x60)/g,
        '<span class="tok-code">$1</span>'
      );
    }).join("\\n");
  }

  function renderHighlight() {
    const text = editor.value;
    highlight.innerHTML =
      language === "markdown"
        ? markdownHighlight(text)
        : genericHighlight(text);

    const lines = Math.max(1, text.split("\\n").length);
    let gutterText = "";
    for (let i = 1; i <= lines; i++) {
      gutterText += i + (i === lines ? "" : "\\n");
    }
    gutter.textContent = gutterText;
    syncScroll();
  }

  function syncScroll() {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
    gutter.scrollTop = editor.scrollTop;
  }

  function updatePosition() {
    const before = editor.value.slice(
      0,
      editor.selectionStart
    );
    const parts = before.split("\\n");
    const line = parts.length;
    const column = parts[parts.length - 1].length + 1;
    position.textContent = "Ln " + line + ", Col " + column;
  }

  function scheduleEdit() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      vscode.postMessage({
        type: "edit",
        text: editor.value,
        label: "Edit text"
      });
    }, 120);
  }

  function flushEdit() {
    clearTimeout(sendTimer);
    vscode.postMessage({
      type: "edit",
      text: editor.value,
      label: "Edit text"
    });
  }

  function refreshFind(resetIndex = false) {
    const needle = findInput.value;
    matches = [];

    if (!needle) {
      matchIndex = -1;
      matchCount.textContent = "No results";
      return;
    }

    const haystack = editor.value.toLocaleLowerCase();
    const query = needle.toLocaleLowerCase();
    let start = 0;

    while (start <= haystack.length) {
      const index = haystack.indexOf(query, start);
      if (index < 0) break;
      matches.push(index);
      start = index + Math.max(1, query.length);
    }

    if (matches.length === 0) {
      matchIndex = -1;
      matchCount.textContent = "No results";
      return;
    }

    if (
      resetIndex ||
      matchIndex < 0 ||
      matchIndex >= matches.length
    ) {
      matchIndex = 0;
    }

    matchCount.textContent =
      (matchIndex + 1) + " of " + matches.length;
  }

  function selectCurrentMatch() {
    if (matchIndex < 0 || matches.length === 0) return;
    const needle = findInput.value;
    const start = matches[matchIndex];
    editor.focus();
    editor.setSelectionRange(
      start,
      start + needle.length
    );
    updatePosition();
  }

  function moveMatch(delta) {
    refreshFind(false);
    if (matches.length === 0) return;
    matchIndex =
      (matchIndex + delta + matches.length) %
      matches.length;
    matchCount.textContent =
      (matchIndex + 1) + " of " + matches.length;
    selectCurrentMatch();
  }


  function commitLocalEdit(label) {
    state.textContent = "Modified";
    renderHighlight();
    updatePosition();
    clearTimeout(sendTimer);
    vscode.postMessage({
      type: "edit",
      text: editor.value,
      label
    });
    refreshFind(false);
    saveUiState();
  }

  function replaceCurrent() {
    refreshFind(false);
    if (matchIndex < 0 || matches.length === 0) return;

    const needle = findInput.value;
    const start = matches[matchIndex];
    editor.setRangeText(
      replaceInput.value,
      start,
      start + needle.length,
      "end"
    );
    commitLocalEdit("Replace");
  }

  function replaceAll() {
    const needle = findInput.value;
    if (!needle) return;

    const source = editor.value;
    const lowerSource = source.toLocaleLowerCase();
    const lowerNeedle = needle.toLocaleLowerCase();
    const replacement = replaceInput.value;

    let cursor = 0;
    let output = "";
    let count = 0;

    while (cursor <= source.length) {
      const found = lowerSource.indexOf(
        lowerNeedle,
        cursor
      );
      if (found < 0) {
        output += source.slice(cursor);
        break;
      }

      output += source.slice(cursor, found);
      output += replacement;
      cursor = found + needle.length;
      count++;
    }

    if (count === 0) return;
    editor.value = output;
    commitLocalEdit("Replace all");
  }

  function showFind(focusReplace = false) {
    findbar.classList.add("visible");
    const target = focusReplace
      ? replaceInput
      : findInput;
    target.focus();
    target.select();
    refreshFind(true);
    saveUiState();
  }

  function hideFind() {
    findbar.classList.remove("visible");
    editor.focus();
    saveUiState();
  }

  editor.addEventListener("input", () => {
    if (suppressInput) return;
    state.textContent = "Modified";
    renderHighlight();
    updatePosition();
    scheduleEdit();
    if (findbar.classList.contains("visible")) {
      refreshFind(false);
    }
    saveUiState();
  });

  editor.addEventListener("scroll", () => {
    syncScroll();
    saveUiState();
  });
  editor.addEventListener("click", () => {
    updatePosition();
    saveUiState();
  });
  editor.addEventListener("keyup", () => {
    updatePosition();
    saveUiState();
  });
  editor.addEventListener("select", () => {
    updatePosition();
    saveUiState();
  });

  editor.addEventListener("keydown", (event) => {
    const primary = event.ctrlKey || event.metaKey;

    if (primary && event.key.toLowerCase() === "s") {
      event.preventDefault();
      clearTimeout(sendTimer);
      vscode.postMessage({
        type: "save",
        text: editor.value
      });
      return;
    }

    if (primary && event.key.toLowerCase() === "z") {
      event.preventDefault();
      vscode.postMessage({ type: "undo" });
      return;
    }

    if (
      primary &&
      (
        event.key.toLowerCase() === "y" ||
        (event.shiftKey && event.key.toLowerCase() === "z")
      )
    ) {
      event.preventDefault();
      vscode.postMessage({ type: "redo" });
      return;
    }

    if (primary && event.key.toLowerCase() === "f") {
      event.preventDefault();
      showFind(false);
      return;
    }

    if (primary && event.key.toLowerCase() === "h") {
      event.preventDefault();
      showFind(true);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();

      if (
        event.shiftKey &&
        editor.selectionStart === editor.selectionEnd
      ) {
        const start = editor.selectionStart;
        const lineStart =
          editor.value.lastIndexOf("\\n", start - 1) + 1;
        const prefix = editor.value.slice(
          lineStart,
          Math.min(lineStart + 4, editor.value.length)
        );
        const removable = /^ {1,4}/.exec(prefix)?.[0] || "";

        if (removable) {
          editor.setRangeText(
            "",
            lineStart,
            lineStart + removable.length,
            "preserve"
          );
          editor.selectionStart =
            Math.max(lineStart, start - removable.length);
          editor.selectionEnd = editor.selectionStart;
        }
      } else {
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText(
          "    ",
          start,
          end,
          "end"
        );
      }

      editor.dispatchEvent(
        new Event("input", { bubbles: true })
      );
    }
  });

  findInput.addEventListener("input", () => {
    refreshFind(true);
    saveUiState();
  });
  replaceInput.addEventListener("input", saveUiState);
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideFind();
    }
  });

  prevButton.addEventListener("click", () => moveMatch(-1));
  nextButton.addEventListener("click", () => moveMatch(1));
  replaceButton.addEventListener("click", replaceCurrent);
  replaceAllButton.addEventListener("click", replaceAll);
  closeFind.addEventListener("click", hideFind);
  securityButton.addEventListener("click", () => {
    vscode.postMessage({ type: "securityStatus" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (message?.type === "load") {
      language = message.language || language;
      languageBadge.textContent = language;

      suppressInput = true;
      editor.value = message.text || "";
      suppressInput = false;

      if (message.recoveryConflict) {
        state.textContent = "Recovery conflict";
      } else {
        state.textContent = message.restoredFromBackup
          ? "Recovered encrypted backup"
          : "Saved";
      }

      if (typeof restoredUiState.find === "string") {
        findInput.value = restoredUiState.find;
      }
      if (typeof restoredUiState.replace === "string") {
        replaceInput.value = restoredUiState.replace;
      }
      if (restoredUiState.findVisible) {
        findbar.classList.add("visible");
      }

      renderHighlight();

      const max = editor.value.length;
      const start = Math.min(
        Number(restoredUiState.selectionStart) || 0,
        max
      );
      const end = Math.min(
        Number(restoredUiState.selectionEnd) || start,
        max
      );
      editor.setSelectionRange(start, end);
      editor.scrollTop =
        Number(restoredUiState.scrollTop) || 0;
      editor.scrollLeft =
        Number(restoredUiState.scrollLeft) || 0;

      updatePosition();
      refreshFind(false);
      editor.focus();
      return;
    }

    if (message?.type === "replace") {
      const selectionStart = editor.selectionStart;
      const selectionEnd = editor.selectionEnd;
      const scrollTop = editor.scrollTop;
      const scrollLeft = editor.scrollLeft;

      suppressInput = true;
      editor.value = message.text || "";
      suppressInput = false;

      state.textContent =
        message.reason === "peer-edit"
          ? "Modified"
          : "Modified";

      renderHighlight();

      const max = editor.value.length;
      editor.setSelectionRange(
        Math.min(selectionStart, max),
        Math.min(selectionEnd, max)
      );
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;

      updatePosition();
      refreshFind(false);
      saveUiState();
      return;
    }

    if (message?.type === "saved") {
      state.textContent = "Saved";
      saveUiState();
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
  SECURE_EDITOR_VIEW_TYPE,
  SECURE_BACKUP_MAGIC_V2,
  SECURE_BACKUP_SALT_BYTES,
  SECURE_BACKUP_IV_BYTES,
  SECURE_BACKUP_TAG_BYTES,
  SECURE_BACKUP_PBKDF2_ITERATIONS,
  pbkdf2Async,
  encryptSecureBackupPayload,
  decryptSecureBackupPayload,
  computeTextDelta,
  applyTextDelta,
  decodeSecureUtf8,
  languageHintForUri,
  SecureTextDocument,
  SecureTextEditorProvider
};
