# Regression Testing

## Stable 1.0 validation environment

The 1.0.0 regression pass was performed on Windows x64 with VS Code 1.136.1.
`package.json` therefore declares `^1.136.1` as the stable 1.0 minimum. A future
lower minimum should be claimed only after explicit compatibility testing on
that VS Code line.

The final 1.0 regression matrix covered these representative boundaries and
passed:

1. Secure Virtual / Header ON / encrypted edit-save-reopen.
2. Secure Virtual / Header ON / existing unencrypted non-empty file normal save.
3. Standard Virtual / mixed encrypted + unencrypted normal editing.
4. Virtual create / rename / delete / mkdir / zero-byte behavior.
5. Solid mixed-encryption Data Encryption toggle, including content/CRC and the
   reblock MTime/Windows-attributes preservation regression.
6. Materialized edit / add / delete / rename filesystem synchronization, with
   archive metadata fidelity evaluated according to the documented Materialized
   boundary rather than as an archive-identity guarantee.
7. Materialized explicit close/cleanup and retained-TEMP recovery after abnormal
   termination.
8. Virtual VS Code restart fail-closed behavior.
9. External archive fingerprint conflict rejection without overwriting the
   externally changed `.7z`.
10. Direct `.7z` Custom Editor coexistence with another archive extension via VS
    Code's editor selection UI.

Run this checklist after structural cleanup or native protocol changes.

## Build smoke test

For native changes:

```powershell
cd .\native
.\build-native.ps1
```

Then launch the Extension Development Host with `F5`.

## Direct archive open

1. Open a normal local folder containing `sample.7z`.
2. Double-click `sample.7z`.
3. Confirm password prompt appears.
4. Enter the correct password.
5. Confirm the window becomes an `encrypted7z://` workspace.
6. Close Secure Mode and confirm the original workspace returns.

Also test:

- cancel password → launcher remains with Retry
- wrong password → error + Retry
- `Ctrl+O` opening `.7z`
- `7z Secure: Open Encrypted Archive` command
- attempting to open a second archive while one is mounted

## Virtual filesystem

Test:

- read existing file
- save existing file
- create file
- create true empty directory
- rename file
- rename directory
- move file
- move directory
- delete file
- recursive directory delete

Verify the archive still opens in ordinary 7-Zip.

## External-change protection

1. Mount archive.
2. Modify the original `.7z` externally.
3. Attempt a read.
4. Confirm it fails as stale.
5. Repeat with a mutation and confirm commit is refused.

## Mixed data encryption

Prepare an archive containing multiple files.

Verify:

- encrypted → unencrypted
- `🔓` decoration appears
- unencrypted → encrypted
- `🔓` disappears
- normal save of an encrypted item remains encrypted
- normal save of an unencrypted item remains unencrypted
- new file defaults to encrypted

### Solid follower regression

Use a solid archive containing an item that reports:

```text
archiveSolid=yes
packSize=0
```

Toggle its data encryption.

Expected: native update mode is `reblock` and the operation succeeds. Compare
ordinary 7-Zip listings before/after and confirm the target keeps its original
modified time and Windows attributes while Size/CRC remain unchanged and only
the requested data-encryption state changes.

Also test a block-leading/direct item (`packSize > 0`) to ensure the direct path
still succeeds.

## Header encryption

Test both directions:

- Header ON → OFF
- Header OFF → ON

After each operation:

- verify archive contents
- verify item data-encryption mix is preserved
- check member-name visibility with ordinary 7-Zip

Remember: `🔓` refers only to file data.

## Important save regression

Create this specific state:

```text
header encryption = ON
target file data  = unencrypted
```

Open the target, edit it, and save normally.

This path must remain in the regression suite because native helper lifecycle
issues were previously observed in adjacent mixed-encryption operations.

## Secure Text Editor

Open a virtual text file using Secure Text Editor.

Security Status should show:

```text
Secure CustomDocuments: 1
Matching VS Code TextDocuments: 0
```

Test:

- edit / dirty tab
- Ctrl+S
- confirm the archive content is saved
- confirm the tab dirty indicator clears immediately after the save completes
- close the tab and confirm VS Code does not prompt to save again
- undo / redo
- find / replace
- split editor synchronization
- Revert
- Save As refusal
- UTF-8 validation

### Encrypted custom backup

1. Edit and leave dirty long enough for VS Code to request backup.
2. Run `7z Secure: Secure Editor Security Status`.

Expected:

```text
Last custom backup: AES-256-GCM ...
```

Output should contain an encrypted-backup event.

## Standard Text Editor

Open a file with the standard editor and test ordinary VS Code editing behavior.

This is a functionality test only; it should not be interpreted as proving the
same persistence boundary as Secure Text Editor.

## Session lifecycle

Test:

- Secure Close with clean tabs
- Secure Close with dirty Secure Text Editor
- Secure Close with dirty Standard TextDocument
- Extension Host restart during mount handoff
- normal restart after handoff: password should not behave like a persistent
  saved session
- previous `files.hotExit` global setting is restored when Secure Mode closes

## Explorer decoration

For unencrypted file data:

- `🔓` appears
- tooltip says `Unencrypted data`

Check that the glyph renders acceptably on the target Windows/VS Code setup.
Emoji rendering is platform/font dependent; if it looks poor, prefer a compact
Unicode symbol rather than reverting to an ambiguous semantic label.


## Session mode persistence

The open flow presents Secure Virtual, Standard Virtual, and Materialized as
immutable per-session choices.

Verify:

- direct open and command open both present the mode choice
- the selected mode survives the one-shot workspace handoff/restart
- missing/invalid persisted mode fails closed instead of guessing
- Standard Virtual still enables/restores the Hot Exit guard
- changing mode requires closing and reopening the archive; there is no in-place
  Secure/Standard mode switch


## Mode selection and automatic routing

Open a `.7z`.

### Secure Virtual

1. Choose `Secure Virtual`.
2. Confirm workspace URI uses `encrypted7z-secure://`.
3. Open `.md`, `.txt`, and another supported text file by ordinary Explorer
   double-click.
4. Confirm each opens directly in `7z Secure Text Editor`.
5. Run `7z Secure: Secure Editor Security Status`.
6. Confirm the file has a CustomDocument and no matching VS Code TextDocument.

There should be no extension-provided Explorer command named
`Open in Secure Text Editor`.

### Standard Virtual

1. Close and reopen the same archive.
2. Choose `Standard Virtual`.
3. Confirm workspace URI uses `encrypted7z://`.
4. Open the same files normally.
5. Confirm they use the normal VS Code text editor / TextDocument.

Secure Text Editor must not automatically take over Standard Virtual resources.

### Local file isolation

While the extension is installed, open an ordinary local `.md` or `.txt`.

Expected: the Secure Text Editor does not take over the local file.

## Zero-byte data-encryption regression

1. Create or prepare a 0-byte file.
2. Confirm it has no `🔓` badge.
3. Run Toggle Data Encryption.
4. Confirm the extension explains that an empty file has no data stream and the
   archive remains valid.
5. Add non-empty content and save.
6. Reopen/archive-inspect and confirm the new data is encrypted by default.
7. Toggle to unencrypted; confirm `🔓` appears.
8. Toggle back to encrypted; confirm `🔓` disappears.


## Materialized mode

1. Open an archive and choose `Materialized`.
2. Confirm the plaintext warning appears.
3. Confirm no destination-folder picker appears.
4. Confirm VS Code opens a fresh random `file://` working directory under the OS
   system TEMP location and that its directory name does not include the archive
   basename.
5. Confirm all archive files/directories appear as real filesystem items.
6. Run `git init`; confirm `.git` is created normally.
7. Modify one existing file, add one file, delete one file, create/delete an
   empty directory.
8. Allow autosync to settle, then run `7z Secure: Sync Materialized Working
   Directory` as an explicit checkpoint.
9. Open the `.7z` in ordinary 7-Zip and verify the working-tree changes.
10. Confirm `.git` is ordinary archive content and was synced after Git lock
    files disappeared.
11. Confirm a same-path existing unencrypted non-empty file remains unencrypted
    after a content edit; new non-empty files default encrypted.
12. Rename a file and confirm path/content integrity. Do **not** require original
    modified time or Windows attributes to survive: Materialized rename can be
    reconciled as delete + add. A previously unencrypted item may likewise be
    treated as new-path data and return to the encrypted-by-default policy.
13. Modify the source `.7z` externally during the session and confirm sync is
    refused while the plaintext working tree is preserved.
14. Run `7z Secure: Close Encrypted Archive`; confirm the modal offers `Sync and
    Close` and `Cancel`.
15. Choose `Sync and Close`; after successful final sync and workspace
    restoration, confirm the plaintext TEMP directory is removed.
16. Repeat with a failed/conflicted final sync and confirm the working directory
    is retained for recovery rather than deleted.
17. Restart VS Code while the Materialized workspace is open; confirm the
    working tree remains usable and the archive password is requested again when
    authentication is needed for sync.

### Materialized path safety

Verify Materialized mode rejects archives containing:

- Windows reserved names such as `CON` / `NUL` / `COM1`
- `:` `?` `*` and other Windows-invalid filename characters
- trailing dot/space names
- case-only path collisions such as `A.txt` and `a.txt`

Also verify sync refuses symlinks/junctions/special files rather than following
or flattening them. `.git` is explicitly allowed and is ordinary archive
content.


## Secure Editor Security Status

In Secure Virtual mode, open at least one file and either:

- press `Ctrl+Shift+P` and run
  `7z Secure: Secure Editor Security Status`, or
- click `Security status` in the Secure Text Editor.

For one clean open file, expect approximately:

```text
Secure CustomDocuments: 1.
Matching VS Code TextDocuments: 0.
Dirty Secure documents: 0.
```

Opening multiple secure files can increase `Secure CustomDocuments`; the
important invariant is `Matching VS Code TextDocuments: 0`.

### Secure Virtual filesystem-API boundary

Do not interpret `Matching VS Code TextDocuments: 0` as extension isolation.
Secure Virtual is still registered as a VS Code `FileSystemProvider`, and its
`readFile` implementation returns decrypted bytes for a valid current-session
URI. The reviewed security boundary is therefore:

- Secure Text Editor avoids the normal `TextDocument` working-copy/backup path
- plaintext still exists in extension/Webview/process memory
- the extension does not claim to prevent other installed extensions from
  observing plaintext through VS Code filesystem APIs if they can address an
  active Secure Virtual resource

Keep this distinction aligned with `SECURITY.md` when changing provider/editor
routing.

## Extension Development Host workspace handoff

The default `Run Extension` debug configuration intentionally passes only:

```text
--extensionDevelopmentPath=${workspaceFolder}
```

Do not add `${workspaceFolder}` as a second positional launch argument.

Opening Secure Virtual, Standard Virtual, or Materialized mode uses
`vscode.openFolder(..., { forceReuseWindow: true })`. VS Code shuts down the
current Extension Host and starts a new one for the target workspace. The
one-shot SecretStorage handoff exists specifically to survive that restart.

Regression:

1. Press F5 with `Run Extension`.
2. Open a `.7z`.
3. Choose Secure Virtual and enter the password.
4. Confirm the Extension Development Host window reloads into the virtual
   workspace instead of closing permanently.
5. Close the archive and repeat with Standard Virtual.
6. Repeat with Materialized.
7. Repeat the whole cycle several times.

A short window reload/flicker is acceptable; the test window disappearing and
not reopening is a failure.

Stale workspace recovery is tested by intentionally stopping/debugging while a
virtual or Materialized workspace is active, then pressing F5 again. Provider
registration must occur before recovery, and stale sessions must fail closed
without duplicate-provider errors.

## Materialized autosync

1. Open an archive in Materialized mode.
2. Edit an existing text file.
3. Press Ctrl+S.
4. Without running manual Sync, inspect/reopen the source `.7z`.
5. Confirm the saved content is already present.

Repeat with several rapid saves. Syncs must serialize without fingerprint races.

The manual Sync command must still work and should report "already in sync" when
nothing changed.

### Normal close cleanup

1. Save an edit.
2. Run `7z Secure: Close Encrypted Archive`.
3. Confirm final sync succeeds.
4. Confirm VS Code returns to the previous workspace.
5. Confirm the plaintext working directory is deleted.

### Extension Host/window close cleanup

With a Materialized session opened in the current host:

1. Save an edit.
2. Close the Extension Development Host normally.
3. Confirm the source archive contains the edit.
4. Confirm the plaintext working directory was removed.

Force-kill/crash is not expected to guarantee cleanup.

### Detached-session recovery

If a Materialized working directory survives an older build/crash, opening
another archive should offer:

- Delete Plaintext and Forget
- Reopen Working Directory
- Cancel

Delete/forget should clear the old state and then allow a new archive to open.


## Materialized TEMP + watcher regression

1. Open Materialized mode and accept the plaintext warning.
2. Confirm no folder picker appears.
3. Confirm the workspace is under the system TEMP directory and the random
   directory name does not contain the archive basename.
4. Edit/save a file and confirm the encrypted `.7z` updates after the debounce.
5. Create, rename, and delete files/directories without using manual Sync;
   confirm the archive eventually follows.
6. Run `git init` in a project that previously had no `.git`.
7. Confirm `.git` appears in the encrypted archive after Git settles.
8. Perform Git operations; temporary `.git/*.lock` files should cause deferral,
   not a sync error. Sync should resume when locks disappear.
9. Run manual Sync as a checkpoint and confirm it still works.
10. Run `7z Secure: Close Encrypted Archive`; confirm the modal offers
    `Sync and Close` and `Cancel`.
11. Choose `Sync and Close`; confirm final sync, workspace restoration, and TEMP
    directory deletion.

Crash/force-kill remains a recovery scenario.


## VS Code-native close regression

Repeat for Secure Virtual and Standard Virtual:

1. Open an archive normally.
2. Use VS Code `File > Close Folder` instead of
   `7z Secure: Close Encrypted Archive`.
3. Start the Extension Development Host again.
4. Open the archive again.
5. Confirm password entry completes the workspace handoff and the test window
   does not disappear permanently.
6. Repeat using `File > Open Folder...` to leave the archive workspace.
7. Repeat by closing/reopening the Extension Development Host window.

If VS Code restores an old virtual URI after an external close/reload, the
extension should return fail-closed to the saved pre-archive target, not attempt
a passwordless session restore.

For Materialized:

1. Open Materialized mode and edit/allow autosync.
2. Use VS Code `Close Folder`.
3. Confirm final sync/TEMP deletion if deactivation has enough time.
4. If VS Code terminates before cleanup completes, confirm next-run recovery is
   offered and remains functional.
5. Repeat opening another folder from VS Code instead of using extension Close.



## Installed lifecycle regression

Because the F5 Extension Development Host may close its debug window when
`vscode.openFolder` reloads the workspace, final archive-session lifecycle tests
must be repeated in an installed VSIX.

Minimum installed regression:

1. Secure Virtual open → password → mount.
2. `7z Secure: Close Encrypted Archive` → return target.
3. Repeat Secure Virtual several times.
4. Secure Virtual → VS Code `Close Folder` → reopen archive.
5. Repeat Standard Virtual.
6. Materialized → edit/Git/autosync → extension Close → TEMP removed.
7. Materialized → window `×` → next-run Reopen/Delete recovery.

The extension must not contain a separate Development-only mount behavior merely
to make F5 survive workspace reloads.


## Activity Bar UI regression

1. Launch/open installed extension with no archive session.
2. Confirm a `7z Secure` Activity Bar item is present.
3. Open it and confirm `Open Encrypted Archive` is offered.
4. Open Secure Virtual:
   - view description says Secure Virtual
   - Close, Toggle Header, Security Status are accessible
   - Materialized Sync is not shown
5. Open Standard Virtual:
   - Close and Toggle Header are accessible
   - Secure Editor Security Status is not shown
6. Open Materialized:
   - view description says Materialized / Autosync
   - Sync and Close are accessible
   - Header/Secure Editor actions are not shown
7. Confirm per-file Toggle Data Encryption remains available from the archive
   Explorer file context menu.
8. Confirm the same commands still work from Command Palette where applicable.

## VSIX content regression

Run `.\package-vsix.ps1`, then inspect the VSIX file list.

Required runtime files include:

- `extension.js`
- `src/**/*.js`
- `package.json`
- `media/7z-secure.svg`
- `native/bin/win32-x64/e7z_bridge.exe`
- `native/bin/win32-x64/7z.dll`
- `native/bin/win32-x64/runtime-manifest.json`
- `native/bin/win32-x64/licenses/7zip-LICENSE.txt`
- `native/bin/win32-x64/licenses/bit7z-MPL-2.0.txt`

Development-only `.vscode/**`, `.gitignore`, `native/src/**`,
`native/CMakeLists.txt`, `native/build-native.ps1`, `native/build/**`,
`native/bin/win32-x64/BUILD_REQUIRED.txt`, and `package-vsix.ps1` must not be
packaged.

Before packaging, confirm the selected runtime DLL came intentionally from the
upstream 7-Zip 26.03 x64 distribution, then confirm `build-native.ps1` reports
bit7z commit `c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742` and 7-Zip 26.03, and that
`package-vsix.ps1` accepts the runtime manifest without a hash mismatch.

Before a public source push, also inspect `git status --ignored` (or equivalent)
and confirm generated native binaries, CMake build state, VSIX/ZIP artifacts,
TEMP working trees, and machine-specific diagnostic files are not staged. Search
tracked text for local absolute paths and credentials before publishing.


## Module split regression

After any source-layout refactor:

1. `node --check` every runtime `.js` file.
2. Load every runtime module with a VS Code API stub to catch missing exports,
   bad relative imports, or circular initialization failures.
3. Re-run generated Secure Editor and Direct Archive Opener Webview syntax
   checks.
4. Confirm activation still registers both virtual filesystem schemes and both
   Custom Editor providers before awaited recovery.
5. Re-run basic Secure Virtual / Standard Virtual / Materialized smoke tests
   before starting the full release regression matrix.


## Header Encryption edge cases

### Directory-only archive

1. Create a password-protected 7z containing one or more empty directories and
   no files.
2. Open in Secure Virtual.
3. Toggle Header Encryption ON → OFF.
4. Close/reopen; confirm directories remain and Header is OFF.
5. Toggle OFF → ON.
6. Close/reopen; confirm directories remain and Header is ON.
7. Confirm no `.__e7z_header_anchor_*` member is present.

Repeat once in Standard Virtual if desired; both modes share the same provider.

### Zero-byte-file-only archive

This remains a regression case:

- Header ON → OFF → reopen
- Header OFF → ON → reopen
- zero-byte files remain zero bytes
- data-encryption badge remains N/A/no-unlocked badge

### Truly empty archive

1. Remove the last member and reopen.
2. Status bar must show `7z Header: N/A`.
3. Activity Bar must not offer Toggle Header Encryption.
4. Invoking the command from Command Palette must show an informational N/A
   message and must not mutate the archive.
5. Creating the first file/directory makes Header Encryption applicable again.
