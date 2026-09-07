# Development Guide

## Compatibility and migration policy

The public extension identity is `Nishitox.7z-secure-workspace`.

Preserve user data and documented release behavior across stable 1.x updates,
but do not add migration branches merely to preserve unpublished development-build
internals.

Legacy internal identifiers such as URI schemes, command ids, and persisted
session keys may remain when changing them would add risk without user-facing
benefit. Any migration that touches password/session/recovery state requires an
explicit security review.

## Contributor / Codex design rules

These rules capture intent that must survive refactoring.

### 1. Do not trade plaintext persistence for convenience silently

The main purpose of the project is safe encrypted-archive editing.

Any feature that writes decrypted contents to disk belongs in an explicitly
Materialized mode, not as an invisible implementation detail of virtual mode.

### 2. Do not pass passwords through argv or environment variables

The native bridge receives secrets over stdin. Keep the helper executable path
fixed under the extension installation directory.

A workspace must never be able to redirect the password-bearing helper.

### 3. Keep file-data encryption and header encryption separate

Do not infer one from the other.

Normal saves preserve existing per-item data encryption. New files default to
encrypted. Header encryption is an explicit archive-level control.

### 4. Keep transactional commits

Do not replace encrypted candidate + integrity test + fingerprint recheck +
`ReplaceFileW` with a direct write to the original archive.

### 5. Preserve separate native-process phases where required

Mixed-encryption header/data rewrites are separated because real bit7z/7-Zip
tests produced handle-lifecycle failures when repeated rewrites occurred in one
process.

Process-count optimization is lower priority than archive correctness.

### 6. Preserve the solid-follower reblock rule

`solid && size > 0 && packSize == 0` is treated specially because in-place
encryption changes can be unsupported for followers sharing a solid block.

### 7. Secure Text Editor is a security boundary, not an editor project

Its reason to exist is avoiding `TextDocument` working-copy backups.

Do not keep adding VS Code editor features indefinitely. If a workflow needs
full editor/tooling integration, route it to Standard Virtual or Materialized
mode instead.

### 8. Never make the `*` Secure Text Editor globally default

Custom Editor selectors are filename based, not URI-scheme based.

A global `priority: default` for `*` would take over unrelated local files.
Automatic Secure Editor routing must be scoped to the dedicated Secure Mode
workspace.

### 9. Do not persist live sessions casually

SecretStorage is a one-shot mount handoff, not "remember my archive password".
Normal restart should require an explicit new secure session.

### 10. Runtime Webviews stay offline

Do not add CDN scripts, remote fonts, telemetry SDKs, or other network runtime
dependencies to Secure Webviews without an explicit security review.

### 11. External archive changes must fail closed

Do not attempt automatic merge/reconciliation inside the encrypted archive.
A fingerprint mismatch invalidates the mounted view.

### 12. Keep routine logging privacy-minimized

Routine release logs should describe operations without source archive paths,
archive member names, Materialized event paths, fingerprint values, passwords,
or plaintext contents. Add more disclosure only for an explicit diagnostic need
and review it as a privacy/security change.

## Current mode model

The three modes are represented by `SESSION_MODE`, selected explicitly when an
archive is opened, and persisted through the one-shot workspace handoff.

1. Secure Virtual — `CustomEditorProvider` automatically used within the mounted
   secure workspace.
2. Standard Virtual — normal `TextDocument` path.
3. Materialized — explicit decrypted real-directory workflow.

Mode selection is a session boundary. Do not reintroduce per-file commands that
switch Secure/Standard editor semantics inside an already-open session.

## Runtime source layout and responsibility boundaries

The v0.0.31 source split was intentionally mechanical: responsibilities moved
into modules, but archive mutation, session routing, native protocol behavior,
and security semantics were not redesigned as part of that refactor. Preserve
that history when reviewing later structural changes.

`extension.js` is the composition root. It registers VS Code providers,
commands, listeners, and shared controllers; archive/security logic belongs in
`src/` rather than being re-inlined into the entry point.

Current runtime layout:

```text
extension.js                 activation / registrations / command wiring
src/constants.js             shared identifiers and session-mode constants
src/direct-open/provider.js  local .7z launcher Custom Editor
src/virtual/                 virtual archive FileSystemProvider + decorations
src/secure-editor/           private CustomDocument Secure Text Editor
src/security/paths.js        untrusted path validation + materialization checks
src/native/backend.js        native stdin/stdout protocol + e7z_bridge wrapper
src/archive/core.js          fingerprints, stable reads, transactions, mode helpers
src/session/lifecycle.js     session routing/recovery + Materialized lifecycle
src/ui/activity-bar.js       Activity Bar state/presentation
```

Keep these responsibility boundaries explicit:

- `VirtualArchiveProvider`: virtual filesystem/tree and archive-session
  operations; transaction/fingerprint/tree-refresh lifecycle stays centralized
  in `runTransactionalMutation()`.
- archive-state reader: stable fingerprint + LIST/header probe + archive-entry
  validation.
- session lifecycle: immutable mode, mount handoff, fail-closed expiry,
  teardown, return-target restoration, and Materialized recovery.
- open pipeline: `prepareAuthenticatedArchive()` owns common authentication and
  stable archive state; `routeAuthenticatedArchiveSession()` is the mode split.
- `Native7zBackend`: binary-protocol transport and typed native operations.
- native structural editor policy: structural mutations preserve required solid
  and header policy through the established helper paths.
- Secure Text Editor: private CustomDocument and encrypted-backup boundary.

Do not split or merge modules merely to reduce line count. For refactors,
preserve behavior first; do not combine module movement with changes to native
protocol ids, transaction phases, session handoff semantics, Materialized
recovery, or Secure Editor persistence.

## Build

### Extension only

No compile step is required for `extension.js`.

Use the Run/Debug configuration and press `F5`.

### Native bridge

When `native/src/main.cpp` changes:

```powershell
cd .\native
.\build-native.ps1
```

The extension expects the release runtime set:

```text
native/bin/win32-x64/e7z_bridge.exe
native/bin/win32-x64/7z.dll
native/bin/win32-x64/runtime-manifest.json
native/bin/win32-x64/licenses/7zip-LICENSE.txt
native/bin/win32-x64/licenses/bit7z-MPL-2.0.txt
```

The native build is pinned to bit7z 4.1.0 commit
`c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742` and 7-Zip 26.03. Git is therefore
a native-build prerequisite. The build rejects a different runtime 7z.dll
major/minor version and verifies the resolved bit7z Git commit before compiling.
For a public release, intentionally select the upstream 7-Zip 26.03 x64 DLL; the
build records its exact hash but does not infer provenance from version metadata
alone.

### Packaging

Use `package-vsix.ps1` when producing a local VSIX. Packaging requires Node.js
22 or newer because the current `@vscode/vsce` toolchain requires it. Node.js is
a developer packaging dependency only; installed extension users do not need a
separate Node.js installation.

The packaging script verifies the generated runtime manifest and the exact
SHA-256 hashes of the bundled native binaries before creating the VSIX. See
`RELEASE.md` for release provenance and `Source repository hygiene` /
`Packaging rule` below for inclusion boundaries.

## Deferred / non-blocking review items

These are deliberate post-1.0 review items rather than missing stable-release
features:

- consider explicit large-file limits or streaming if real-world use requires it
- review sparse native protocol operation ids only if protocol maintenance needs it
- consider code signing for future release artifacts
- refactor module boundaries only when it improves reviewability without changing
  the established security/session invariants


## Mode-session invariants

- Mode is selected once per archive session and persisted with the one-shot
  workspace handoff metadata.
- Do not implement mode switching in place. Close and reopen instead.
- Common archive authentication/validation stays above the mode router.
- Secure Virtual and Standard Virtual share `VirtualArchiveProvider`.
- Materialized must branch before virtual workspace mount and must never reuse a
  fake `encrypted7z://` directory as its working directory.
- Hot Exit guard belongs to Standard Virtual only. Secure Virtual resources
  must keep automatic Secure Text Editor routing rather than falling back to the
  normal `TextDocument` path.


## Virtual scheme routing invariant

Do not merge the two virtual URI schemes back into one merely to reduce code.

```text
encrypted7z-secure://  → Secure Virtual / automatic Custom Editor
encrypted7z://         → Standard Virtual / normal TextDocument editor
```

The separate schemes make editor routing a session-level property without
globally changing VS Code editor associations.

The Secure Custom Editor selector intentionally uses
`encrypted7z-secure:/**` with `priority: default`. VS Code currently evaluates
path-containing editor globs against `scheme:path`. Keep a regression test for
this behavior because it is fundamental to the mode boundary.

## Empty-file encryption invariant

A zero-byte 7z item has no data stream. Do not use `item.isEncrypted()==false`
as a persisted "unencrypted policy" for empty files.

If content is added after an item was empty, default the new data to encrypted.

## CustomDocument dirty-state invariant

`SecureTextDocument.dirty` is a derived getter based on `text !== savedText` (or
a restored backup without a saved baseline). Never assign to `document.dirty`.

On save:

1. commit bytes through the encrypted archive provider,
2. set `document.savedText = document.text`,
3. let `saveCustomDocument()` resolve successfully.

VS Code clears its Custom Editor dirty marker when the save callback resolves.
Directly assigning a legacy boolean `dirty` field will throw because the current
document model intentionally has no setter.


## Materialized-mode invariants

Materialized mode is the only mode allowed to intentionally persist plaintext
archive contents to a real directory.

Do not reuse its disk materialization path as an optimization for either virtual
mode.

The working tree is user data while the session is active. On sync failure,
external archive conflict, crash, or restart, prefer retaining plaintext over
silently deleting unsynced edits.

`.git` is ordinary project data in Materialized mode and must sync with the
rest of the working tree. Git lock files are transient coordination state: wait
for them to disappear before autosync rather than permanently excluding `.git`.

Materialized reconciliation is intentionally filesystem/path based. Do not
silently promote it to an archive-identity reconstruction layer merely to retain
7z metadata across every possible filesystem operation. Same-path non-empty
content edits preserve the existing per-file data-encryption policy, while a
new/recreated/new-path item follows the new-data default (encrypted). Modified
time, Windows attributes, and other archive-item metadata are best-effort when
an operation becomes delete + add. Any stronger guarantee should be designed and
regression-tested as a separate feature rather than inferred from filenames,
content hashes, or other ambiguous heuristics.


## Activation ordering and F5 handoff invariant

Register filesystem providers and Custom Editor providers before the first
awaited startup/recovery operation.

Recovery may call `vscode.openFolder` and terminate the current Extension Host.
Do not move provider registration below that boundary.

The default F5 launch configuration must **not** pin `${workspaceFolder}` as a
positional folder argument. The extension intentionally switches the Extension
Development Host workspace with `vscode.openFolder`; pinning the source folder
can conflict with that reload and make the test window terminate instead of
continuing the handoff.

Use the standard extensionHost launch shape:

```json
"args": [
  "--extensionDevelopmentPath=${workspaceFolder}"
]
```

Stale-session handling belongs in the extension's recovery code, not in a debug
configuration that prevents workspace switching.

## Materialized autosync invariant

Materialized mode is filesystem-event driven:

- create/change/delete/rename events inside the working directory queue a
  debounced archive sync
- VS Code `FileSystemWatcher` and the supplemental local recursive watcher feed
  the same serialized sync queue
- manual Sync remains an explicit checkpoint/force-sync path
- normal close/shutdown deletes plaintext only after successful final sync
- failed final sync preserves plaintext for recovery

Do not change shutdown cleanup to unconditional deletion.

Detached-session recovery is intentionally user-visible because leftover
plaintext can contain edits from a crash or older build and must not be silently
discarded.


## Materialized TEMP/watcher invariants

- default Materialized working directories use
  `%TEMP%\7z-secure-workspace-<random>\`; do not include the source archive
  basename in the plaintext path or silently create plaintext beside the source
  archive
- `.git` is ordinary archive content; do not reintroduce `.git` exclusion
- autosync is filesystem-event driven, not tied to text-save events
- VS Code watcher and supplemental local recursive watcher feed one debounce
  queue; duplicate events are normal
- Git lock files defer autosync
- explicit Close asks for final-sync confirmation
- shutdown remains best-effort and must never delete plaintext after an
  unsuccessful final sync


## External workspace exit invariant

Do not assume `onDidChangeWorkspaceFolders` async cleanup will finish when the
first workspace folder is removed. VS Code may restart the Extension Host as part
of that transition.

Virtual session teardown therefore has two layers:

- live workspace listener cleanup when it gets time to finish
- `deactivate()` lifecycle marking as the shutdown fallback

Do not clear the Virtual return target before a possibly restored virtual
workspace has had the opportunity to fail closed. Secrets are deleted
immediately; only non-secret routing metadata may survive as
`endedExternally`.

Materialized shutdown must not require
`hasMountedMaterializedWorkspace(saved)`: by deactivation time VS Code may
already have removed the folder. Use the controller's active session as the
shutdown authority and preserve plaintext whenever final sync is not known to
have succeeded.



## No Development-only mount behavior

Keep archive mount/session behavior identical between Development and installed
builds.

Do not reintroduce the temporary multi-root `anchor-a / anchor-b / anchor-c`
harness or branch behavior on `ExtensionMode.Development`.

Reason: it makes F5 easier to keep alive but stops F5 from exercising the same
workspace/session path as the installed extension. The verified production path
uses `vscode.openFolder` plus one-shot SecretStorage handoff.

Current VS Code may close an Extension Development Host window when this
workspace transition ends its debug session. Treat that as a limitation of the
F5 host. Use VSIX installation for final lifecycle regression instead of adding
product-code exceptions.


## Activity Bar UI rule

Use native VS Code View Container / Tree View / `viewsWelcome` / `view/title`
contributions for the 7z command surface. Do not replace the command menu with a
custom Webview.

The Tree View stays intentionally empty: command links belong in welcome
content/title actions rather than fake command TreeItems. Per-file data
encryption remains an Explorer-context operation because it requires the
selected member URI.

## Source repository hygiene

The GitHub source tree should remain reproducible source, not a snapshot of one
developer machine. `.gitignore` therefore excludes:

- `native/build/` including CMake and fetched dependency build state
- generated `native/bin/win32-x64/e7z_bridge.exe`, `7z.dll`, runtime manifest,
  and copied third-party license directory
- generated `.vsix` / `.zip` release artifacts
- local Node/VS Code test caches and logs

Do not commit machine-specific absolute paths, passwords, archive contents,
TEMP working trees, or local diagnostic captures. Keep
`native/bin/win32-x64/BUILD_REQUIRED.txt` tracked so a clean checkout explains
how the runtime binaries are produced.

## Packaging rule

`.vscodeignore` must never exclude:

- `extension.js`
- `package.json`
- `media/7z-secure.svg`
- `native/bin/win32-x64/e7z_bridge.exe`
- `native/bin/win32-x64/7z.dll`
- `native/bin/win32-x64/runtime-manifest.json`
- `native/bin/win32-x64/licenses/7zip-LICENSE.txt`
- `native/bin/win32-x64/licenses/bit7z-MPL-2.0.txt`

Native source/build files, `native/build/**`,
`native/bin/win32-x64/BUILD_REQUIRED.txt`, repository-only ignore files, and
`.vscode` debug configuration are development inputs and should not be shipped
in the VSIX. The generated runtime manifest and copied third-party license texts
are release inputs and must be shipped beside the native runtime binaries.


## Header Encryption edge-case invariant

Do not treat `headerEncrypted === false` as sufficient to decide whether header
encryption is meaningful. A truly empty archive has no member names, so the UI
must use `provider.headerEncryptionApplicable`.

For directory-only archives, keep the temporary file-anchor workaround at the
JS transaction layer. It deliberately reuses the already-tested native
file-anchor implementation and avoids adding a second directory-specific native
rename path.

The temporary anchor must:

- use a collision-safe random root member name
- exist only in the transaction candidate
- contain zero bytes
- be deleted before candidate testing/commit
