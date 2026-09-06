# 7z Secure Workspace

A Windows VS Code extension for opening and editing encrypted `.7z` archives
without intentionally materializing archive file contents as plaintext files in
the normal virtual modes.

> **Development:** Developed by Nishitox with development assistance from OpenAI GPT-5.6 Sol.

> Pre-release project. Backward compatibility with earlier development builds is
> intentionally not preserved.

## Current capabilities

- Open a local `.7z` directly from VS Code.
- Mount the archive as an `encrypted7z://` virtual workspace.
- Read and write archive members through a native `7z.dll` bridge.
- Preserve existing per-file data encryption on normal saves.
- Create new files encrypted by default.
- Mix encrypted and unencrypted file data in one archive.
- Toggle archive header encryption independently.
- Mark files whose **data** is unencrypted with `🔓` in Explorer.
- Detect external archive modification before reads and commits.
- Commit mutations transactionally through an encrypted candidate archive.
- Use a `CustomEditorProvider` path whose VS Code backup is encrypted.
- Keep the standard VS Code text editor available as a less-strict virtual path.
- Open `.7z` files directly through a small launcher Custom Editor.

## Opening an archive

Open a local `.7z` using any normal VS Code file-open path, including
double-clicking it in a VS Code Explorer or using `Ctrl+O`.

The extension prompts for the archive password and mounts a dedicated
`encrypted7z://` workspace.

The command palette entry `7z Secure: Open Encrypted Archive` uses the same
mount path.

## Session modes

Opening an archive presents three immutable per-session modes:

- **Secure Virtual** — virtual archive filesystem + private
  `CustomDocument` Secure Text Editor. No normal VS Code `TextDocument` is
  intentionally created for Secure Text Editor resources.
- **Standard Virtual** — virtual archive filesystem + normal VS Code text
  editor for broader editor/extension compatibility.
- **Materialized** — explicit plaintext TEMP working directory with normal
  filesystem/Git/tooling behavior and encrypted-archive autosync.

Changing mode requires closing and reopening the archive.


## Build

Native bridge changes require Windows x64, CMake, Visual Studio C++ Build
Tools, Git, and 7-Zip 26.03 x64:

```powershell
cd .\native
.\build-native.ps1
```

For JavaScript-only changes, launch the Extension Development Host with `F5`.

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for contributor rules and
design invariants.

## Documentation

- [Architecture and mode model](docs/ARCHITECTURE.md)
- [Security model and invariants](docs/SECURITY.md)
- [Regression testing](docs/TESTING.md)
- [Development / contributor guidance](docs/DEVELOPMENT.md)
- [Native bridge protocol](docs/NATIVE_PROTOCOL.md)
- [Release provenance and packaging](docs/RELEASE.md)

Third-party notices remain in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).


## Zero-byte files and data encryption

A zero-byte file in the 7z format has no file-data stream. Therefore per-file
**data** encryption is not applicable while the file is empty.

- empty files do not show the `🔓` data-encryption badge
- Toggle Data Encryption on an empty file is a no-op with an explanation
- when content is later added, that new data is encrypted by default
- header encryption remains independent and can still protect the filename


## Materialized mode

Materialized mode intentionally writes plaintext files to disk.

Current workflow:

1. choose `Materialized` when opening the archive
2. acknowledge the plaintext-on-disk warning
3. the extension creates a random system-TEMP working directory automatically
4. VS Code opens that real directory as the workspace
5. use normal filesystem tools, including Git
6. create/change/delete/rename events are debounced and autosynced
7. `7z Secure: Sync Materialized Working Directory` remains available as a
   manual checkpoint
8. `Close Encrypted Archive` asks for `Sync and Close`; successful final sync
   removes the plaintext TEMP directory

`.git` is ordinary project content and is synced into the encrypted archive.
Temporary Git lock files defer autosync until Git finishes updating metadata.

The implementation rejects symlinks/junctions and Windows-invalid or
case-colliding archive paths rather than following/flattening them.

### Materialized fidelity boundary

Materialized mode treats the real working directory as the source of truth and
reconciles that filesystem state back into the archive. Some filesystem
operations, including rename, can therefore be represented as an archive
`delete + add` rather than as an archive-native rename.

As a result:

- file contents and paths are synchronized
- a content edit to the same existing non-empty path preserves that item's
  current data-encryption state
- a new/recreated/new-path non-empty item is treated as new data and defaults to
  encrypted
- original 7z item metadata such as modified time and Windows attributes is
  best-effort in Materialized mode and is not guaranteed to survive operations
  that reconstruct an item

Use Secure Virtual or Standard Virtual when archive-native item identity and
metadata fidelity matter more than normal filesystem/tooling compatibility.


## Materialized `.git` behavior

Materialized mode treats `.git` exactly like other project content. A repository
that already exists in the source archive is restored normally, and `git init`
during a Materialized session creates metadata that is synced into the encrypted
archive.

Autosync waits while `.git/**/*.lock` files exist so the extension does not
intentionally snapshot a Git metadata transaction in progress.


## Materialized autosync lifecycle

Materialized mode now uses an autosync lifecycle:

```text
save a file
→ scan working tree
→ transactional sync to encrypted .7z

normal Materialized close / normal extension shutdown
→ final sync
→ delete plaintext working directory
```

The manual `7z Secure: Sync Materialized Working Directory` command remains as a
force-sync/checkpoint action.

Plaintext is deleted only after successful final sync. If final sync cannot be
authenticated or fails, the working directory and session metadata are kept for
recovery rather than risking data loss.

Abnormal process termination, OS crash, or force-kill cannot guarantee cleanup.
On the next archive open, a detached Materialized directory is detected and the
user can either reopen it or explicitly delete/forget it.


## Materialized working directory and filesystem autosync

Materialized mode no longer asks for an empty destination folder. After the
plaintext warning is accepted, the extension creates a random directory under
the OS system TEMP location:

```text
%TEMP%\encrypted-7z-secure-<random>\
```

The archive name is intentionally not included in the TEMP directory name.

All normal project paths, including newly created `.git` directories, are
Materialized content and sync back to the encrypted archive.

Autosync is filesystem-driven rather than Ctrl+S-specific:

```text
create / change / delete / rename / Git metadata change
→ watcher event burst
→ 250 ms debounce
→ transactional working-tree sync
```

VS Code `FileSystemWatcher` is the primary watcher. A local recursive Node
watcher supplements it on Windows because VS Code recursive watchers can be
affected by `files.watcherExclude`, commonly for `.git`.

While a `.git/**/*.lock` file exists, autosync waits and retries instead of
intentionally snapshotting Git metadata mid-transaction.

`7z Secure: Close Encrypted Archive` asks for `Sync and Close` confirmation.
Successful final sync removes the plaintext TEMP directory.

Normal VS Code/Extension Host shutdown is still best-effort because extensions
do not receive a vetoable public pre-window-close event. If cleanup cannot
complete, the recovery flow preserves the TEMP directory rather than deleting
possibly unsynced work.


## Extension Development Host note

Secure Virtual, Standard Virtual, and Materialized mode switch the VS Code
workspace in-place. During F5 development this restarts/reloads the Extension
Host by design. The included `Run Extension` launch configuration therefore
uses only `--extensionDevelopmentPath` and does not pin the source workspace.


## VS Code-native session exit

`7z Secure: Close Encrypted Archive` remains the most explicit close path, but
it is no longer the only lifecycle path the extension understands.

For Virtual modes, VS Code-native actions such as `Close Folder`, window close,
reload, or opening another folder mark the archive session as externally ended.
If VS Code later restores the old virtual workspace, the extension fails closed
and returns to the saved pre-archive target instead of trying to resume without
a password. If the next activation is already outside the virtual workspace,
stale virtual-session metadata is simply cleared.

For Materialized mode, external workspace/window exit now attempts the same
serialized final archive sync and TEMP cleanup even if VS Code has already
removed the working folder from `workspaceFolders`. If final sync cannot be
completed, plaintext remains recoverable.



## Development vs installed lifecycle

Development and installed builds use the same archive mount implementation:
`vscode.openFolder` opens the dedicated Secure Virtual, Standard Virtual, or
Materialized workspace.

The Extension Development Host started by F5 has its own debug-session
lifecycle. During an intentional workspace reload, current VS Code can close the
Development Host window. This was verified not to occur in the installed VSIX
lifecycle.

For that reason:

- do not add a Development-only archive mount strategy
- use F5 for ordinary implementation/debugging where practical
- use an installed VSIX for final open/close/workspace-lifecycle regression


## Activity Bar UI

The extension contributes a **7z Secure** item to the VS Code Activity Bar.

The Archive view exposes the same main operations that are available from the
Command Palette:

- Open Encrypted Archive
- Close Encrypted Archive
- Toggle Header Encryption for Virtual sessions
- Secure Editor Security Status for Secure Virtual sessions
- Sync Materialized Now for Materialized sessions

Per-file **Toggle Data Encryption** remains in the Explorer file context menu,
because that operation needs the selected archive member URI.

The view title shows compact command icons and the view description reports the
current session mode.

## Source and VSIX packaging

`.gitignore` keeps local native/CMake build output, generated `e7z_bridge.exe` /
`7z.dll`, packaged VSIX/ZIP artifacts, and local tooling caches out of source
commits. `native/bin/win32-x64/BUILD_REQUIRED.txt` remains tracked as the source
tree placeholder/instruction.

`.vscodeignore` separately controls the installed VSIX. It excludes `.vscode`,
repository/build-only files, the native build tree and placeholder instruction,
while retaining runtime JavaScript, documentation referenced by README, the
Activity Bar icon, the two bundled native runtime binaries, the generated runtime
integrity manifest, and the third-party license texts copied by the native build.

On a development machine with Node.js 22+ and existing native binaries:

```powershell
.\package-vsix.ps1
```

The packaging script verifies that the bundled native files still match the
`runtime-manifest.json` produced by `build-native.ps1` before creating the VSIX.
The generated VSIX does **not** require Node.js on the end user's machine.
Desktop VS Code runs this extension inside its own local Node.js Extension Host.

### Native dependency pinning

The release build currently targets:

- bit7z 4.1.0, exact release commit
  `c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742`
- 7-Zip 26.03 headers and runtime `7z.dll`

`build-native.ps1` rejects a runtime DLL with a different 7-Zip major/minor
version, records SHA-256 hashes for the exact native binaries being packaged,
and copies the corresponding upstream license texts into the runtime directory.
The script does not independently prove the provenance of an arbitrary
caller-supplied DLL path, so public release builds must intentionally use the
upstream 7-Zip 26.03 x64 distribution. See `docs/RELEASE.md` and
`THIRD_PARTY_NOTICES.md` for the release boundary.


## Project and license

- Repository: https://github.com/Nishitox/7z-Secure-Workspace
- Publisher: `Nishitox`
- Extension source: MIT License, `Copyright (c) 2026 Nishitox`
- Third-party components retain their upstream licenses; see
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).


## Source layout

The extension entry point is intentionally small. Runtime responsibilities are
separated without changing the session model:

```text
extension.js                 activation / registrations / command wiring
src/constants.js            shared identifiers and session-mode constants
src/direct-open/provider.js local .7z launcher Custom Editor
src/virtual/                virtual archive FileSystemProvider + decorations
src/secure-editor/          private CustomDocument Secure Text Editor
src/security/paths.js       untrusted path validation + materialization checks
src/native/backend.js       native stdin/stdout protocol + e7z_bridge wrapper
src/archive/core.js         fingerprints, stable reads, transactions, mode helpers
src/session/lifecycle.js    session routing/recovery + Materialized lifecycle
src/ui/activity-bar.js      Activity Bar state/presentation
```

The v0.0.31 refactor is intentionally mechanical: responsibilities moved to
modules, but archive mutation/session behavior was not redesigned.


## Header encryption on directory-only and empty archives

Header encryption applies to archive member names, including directory names.

- **directory-only archive:** Header Encryption can be toggled normally. The
  extension creates a collision-safe temporary zero-byte file inside the
  transactional candidate archive, uses it only as the native header-policy
  anchor, and deletes it before commit.
- **truly empty archive:** Header Encryption is **N/A** because there are no
  member names to encrypt. The status bar and Activity Bar report N/A and the
  toggle command is an informational no-op.

The temporary directory-only anchor is never written to the original archive if
any phase fails because the whole operation runs against the transaction
candidate.
