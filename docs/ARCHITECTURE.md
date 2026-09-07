# Architecture

## Purpose

The project is an encrypted archive workspace, not a replacement general-purpose
text editor.

The core job is:

```text
local encrypted .7z
        ↓
authenticated native bridge
        ↓
encrypted7z:// virtual workspace
        ↓
edit
        ↓
transactional encrypted .7z commit
```

The project should avoid expanding into unrelated editor functionality when a
clear mode boundary can provide that capability instead.

## Components

### Direct archive opener

A Custom Editor registered only for `*.7z` acts as a launcher. It does not
extract archive members. It validates the local archive path, prompts for the
password, and enters the common Secure Mode mount flow.

### Virtual filesystem

`VirtualArchiveProvider` implements the `encrypted7z://` filesystem. It keeps archive
metadata in memory and reads member bytes on demand through the native bridge.

There is intentionally no plaintext content cache in the provider.

### Native bridge

`e7z_bridge.exe` is a short-lived helper using bit7z and `7z.dll`.

Each request runs in a fresh process. Passwords and file bytes are sent through
the private stdin/stdout protocol rather than argv or environment variables.

### Transaction layer

Archive writes are never committed directly to the original file.

```text
verify original fingerprint
copy encrypted original → encrypted candidate
mutate candidate
7z integrity test
verify original fingerprint again
ReplaceFileW commit
delete encrypted backup
```

This protects against both failed updates and concurrent external changes.

## Three-mode session model

The code now defines the three modes explicitly in session metadata and routes
an authenticated archive through a mode boundary. Mode is immutable for the
lifetime of an archive session; changing mode means closing and reopening the
archive.

The open flow presents all three modes explicitly. The selected mode is stored
in the one-shot session handoff and automatic editor routing follows that mode.
These are security/capability choices, not merely different editor skins.

### 1. Secure Virtual

**URI scheme:** `encrypted7z-secure://`

**Storage model:** virtual; no intentional plaintext materialization.

**Editor:** `CustomEditorProvider` + private `CustomDocument`.

**Primary goal:** strongest practical persistence boundary inside VS Code.

Properties:

- no VS Code `TextDocument` for files opened in this editor
- VS Code-requested custom backups are encrypted
- Save As to an ordinary plaintext file is intentionally disabled
- editor features should remain deliberately modest
- do not reimplement the whole VS Code editor ecosystem here

**Intended final UX:** once this mode is selected, opening a file in the
`encrypted7z://` Explorer should automatically use the Secure Text Editor.
The temporary right-click "Open in Secure Text Editor" entry should then be
removed.

Important implementation constraint: do **not** make a `*` Custom Editor
`priority: default` globally. VS Code Custom Editor selectors are filename based,
not URI-scheme based, so that would also take over unrelated local files.

The preferred direction is to apply editor association only inside the dedicated
Secure Mode workspace. This must be validated against VS Code workspace-setting
behavior before being treated as final.

### 2. Standard Virtual

**URI scheme:** `encrypted7z://`

**Storage model:** virtual; no intentional plaintext archive-member TEMP files.

**Editor:** normal VS Code text editor / `TextDocument`.

**Primary goal:** keep native VS Code editing and extension interoperability.

Trade-off:

VS Code controls `TextDocument` working-copy behavior. `files.hotExit=off` is
used as supplemental protection, but this mode does not make the same persistence
claim as Secure Virtual.

This mode is useful when normal VS Code editor behavior matters more than the
strict backup boundary.

### 3. Materialized

**Storage model:** explicit real directory containing decrypted files.

**Editor/tooling:** normal VS Code filesystem workflows, Git, language servers,
formatters, external tools, and extensions.

**Primary goal:** maximum compatibility.

The security trade-off must be explicit: plaintext exists on disk for the
materialized session. Cleanup, crash behavior, working-directory placement, and
session lifecycle are therefore first-class features rather than hidden
implementation details.

The extension creates a fresh random working directory under the OS system TEMP
location, materializes the authenticated archive into it, opens that real
`file://` directory, and autosyncs filesystem changes back into the encrypted
archive.

## Encryption model

7z has two independent encryption concepts in this project:

- **file data encryption** — can differ per file
- **header encryption** — archive-wide; controls whether member names/metadata
  are visible without the password

Explorer's `🔓` decoration means **unencrypted file data only**. It does not mean
the filename is necessarily visible without a password.

Existing file saves preserve their current data-encryption state. New files are
encrypted by default.

## Solid archives

A solid 7z block can contain several files in one compressed stream. Later files
in the block may report `packSize == 0`.

Changing the encryption coder for such a follower item can fail as an in-place
update. The native bridge therefore classifies these cases as `reblock` and the
JS layer removes/re-adds the target as new archive data. The narrow reblock state
carries the target item's original Win32 attributes and modified time when those
properties exist, so the compatibility fallback does not silently turn the
re-added target into a newly timestamped `FILE_ATTRIBUTE_NORMAL` item.

Do not simplify this fallback without testing real solid archives.

## Session model

Virtual modes mount a random session URI using the mode-specific scheme:

```text
Secure Virtual   encrypted7z-secure://<random-session-id>/
Standard Virtual encrypted7z://<random-session-id>/
```

A normal VS Code restart must not silently resurrect a live password-bearing
session.

`SecretStorage` is used only as a one-shot bridge when mounting the dedicated
workspace may restart the Extension Host. The secret is removed as soon as the
handoff is consumed.

## Mode routing

Virtual modes deliberately use different URI schemes.

```text
Secure Virtual   encrypted7z-secure://<session-id>/
Standard Virtual encrypted7z://<session-id>/
```

The Secure Text Editor contribution uses the scheme-qualified glob:

```text
encrypted7z-secure:/**
```

with `priority: default`.

VS Code's editor resolver matches glob patterns that contain `/` against
`scheme:path`, so this selects the Custom Editor for Secure Virtual resources
without taking over ordinary local files or Standard Virtual resources.

This behavior is a critical routing dependency and belongs in the regression
suite.

The extension no longer provides Explorer commands for switching between Secure
and Standard editors. Mode is a session boundary; changing mode means closing
and reopening the archive.

Materialized mode branches before virtual-workspace mounting. It writes a
plaintext working tree to a fresh extension-owned random system-TEMP directory
of the form `%TEMP%\7z-secure-workspace-<random>\` and later reconciles that
tree back into an encrypted transactional candidate archive. The source archive
basename is intentionally not part of the working-directory name.


## Materialized session pipeline

```text
authenticated archive
        ↓
validate Windows-materializable paths
        ↓
decrypt to extension-owned random system-TEMP directory
        ↓
open file:// working directory
        ↓
normal VS Code / Git / LSP tooling
        ↓
scan working tree
        ↓
compare against unchanged source archive
        ↓
transactional delete/mkdir/write candidate
        ↓
7z test + ReplaceFileW commit
```

Materialized reconciliation is path-based and can interpret filesystem
renames as delete + add. A content edit at the same existing non-empty path
preserves that item's previous per-file data-encryption policy. A new,
recreated, or new-path non-empty item is treated as new data and defaults to
encrypted; a zero-byte item has no data-encryption state until data exists.

Archive-item metadata is not a Materialized-mode preservation invariant.
Operations that reconstruct an item may replace the original 7z modified time,
Windows attributes, or other archive metadata with values from the new item.
This is an accepted compatibility trade-off of Materialized mode rather than a
promise to reconstruct archive-native item identity from arbitrary filesystem
activity.

`.git` is ordinary project/archive content. Existing repositories and `.git`
trees created during Materialized mode both round-trip into the encrypted
archive. Temporary Git lock files postpone autosync until Git finishes updating
metadata.


## Materialized autosync lifecycle

Materialized mode treats the real directory as a temporary plaintext working
copy.

- filesystem create/change/delete/rename events queue a debounced full
  working-tree → encrypted archive sync
- sync requests are serialized
- explicit close performs `saveAll`, final sync, then plaintext cleanup
- normal extension shutdown performs a final on-disk sync when authentication is
  still available, then removes plaintext
- failed final sync retains plaintext for recovery
- manual Sync remains an explicit checkpoint/force-sync path even though
  ordinary filesystem and external-tool changes are watcher-driven


## Materialized watcher model

Materialized uses an extension-owned random system-TEMP working directory.

Two watcher sources feed one debounce queue:

- VS Code `FileSystemWatcher` for workspace create/change/delete events
- supplemental recursive Node `fs.watch` for local/external-tool activity,
  including `.git` changes that may be affected by VS Code watcher exclusions

Duplicate events are expected and harmless. After 250 ms without a newer event,
one serialized full working-tree transaction is scheduled.

`.git` is ordinary project/archive content. If Git lock files are present,
autosync postpones itself and retries after the lock disappears.


## Workspace handoff

Virtual and Materialized modes intentionally replace the current workspace using
`vscode.openFolder(..., { forceReuseWindow: true })`.

VS Code restarts the Extension Host when opening a folder/workspace in the same
window. This is expected behavior. The session handoff stores password/archive
information only long enough for the new Extension Host activation to consume
it.

Development launch configuration must not pin a positional workspace folder,
because that can interfere with this intentional reload.


## External workspace/session exit

Extension-managed Close and VS Code-managed workspace exit converge on the same
session lifecycle.

Virtual sessions keep a non-secret `endedExternally` marker long enough to
distinguish a legitimate one-shot mount handoff from a later workspace/window
shutdown. The marker preserves only routing/return-target metadata; archive
password/path handoff secrets are deleted.

On the next activation:

- no virtual workspace mounted → stale virtual metadata is cleared
- matching virtual workspace restored after external end → fail closed and
  restore the pre-archive workspace/empty target
- one-shot handoff pending with secrets present → complete the intended mount

Materialized external exit does not require the working folder to remain in
`workspace.workspaceFolders`: VS Code can remove the first folder before
extension deactivation. The controller's active session state is authoritative
for final sync/recovery.



## Single mount strategy

Archive session mounting intentionally has one implementation path in
development and installed builds:

```text
Secure Virtual   ┐
Standard Virtual ├─ dedicated workspace via vscode.openFolder
Materialized     ┘
```

No Development-only multi-root/anchor path is used.

The one-shot SecretStorage handoff therefore exercises the same code path in all
build modes. F5 can still be an imperfect host for this particular lifecycle
because VS Code ties an Extension Development Host to a debug session; final
workspace-reload verification belongs to an installed VSIX.


## Activity Bar command surface

The 7z Secure Activity Bar contribution uses a native VS Code View Container and
an empty Tree View with `viewsWelcome` command links. It deliberately does not
use a custom Webview for command navigation.

UI state is derived from the persisted session plus the currently mounted
workspace and exposed through extension-owned context keys:

- `encrypted7zSecure.sessionOpen`
- `encrypted7zSecure.virtualSession`
- `encrypted7zSecure.secureVirtualSession`
- `encrypted7zSecure.standardVirtualSession`
- `encrypted7zSecure.materializedSession`

These keys control only presentation. Command handlers remain responsible for
validating the real session/resource state.


## Runtime module boundaries

`extension.js` is the composition root only. Module dependencies flow toward
shared primitives rather than back into the entry point:

```text
constants
  ↓
security/paths     native/backend
  ↓                  ↓
archive/core
  ↓
virtual / secure-editor / session-lifecycle
                          ↓
                       activity-bar
                          ↓
                     extension.js
```

`session/lifecycle.js` deliberately keeps `MaterializedSessionController` with
Materialized sync/finalization in the first split. Autosync calls the shared
Materialized sync function, so separating those further would introduce a new
callback/circular-dependency design and would no longer be a mechanical refactor.


## Header encryption applicability

The native Header toggle implementation persists a policy change by renaming a
file item and renaming it back.

For a directory-only archive, the virtual provider supplies a temporary
zero-byte file **inside the transaction candidate only**:

```text
candidate archive
→ add collision-safe zero-byte anchor
→ native SET_HEADER_ENCRYPTION
→ delete temporary anchor
→ TEST
→ transactional commit
```

The committed archive remains directory-only.

A truly empty archive has no member names, so Header Encryption has no
persistent semantic target. The UI reports the property as N/A rather than
pretending that `false` means a meaningful unencrypted-header state.
