# Security Model

## Reporting security issues

Security-sensitive findings should be reported through GitHub Private
vulnerability reporting instead of a public Issue when that feature is enabled
for the repository. Do not include real archive passwords, private archives, or
sensitive plaintext unless a secure exchange has been explicitly agreed.

The project is maintained on a best-effort basis and does not promise a
response-time or support SLA. Public Issues remain appropriate for ordinary
non-sensitive reproducible bugs.

## Security goal

This file is the canonical record of security intent for the project. Structural
context may be explained in `ARCHITECTURE.md`, and contributor rules may repeat
important constraints in `DEVELOPMENT.md`, but security-sensitive design changes
should be reflected here.

In non-materialized modes, the extension should not intentionally create
plaintext archive-member files on persistent storage.

This is a practical application-security goal, not a forensic guarantee that
plaintext can never reach disk through the operating system. Process memory,
pagefile/swap, crash dumps, GPU/browser internals, and other system-level
mechanisms are outside the guarantee.

## Core invariants

### Password transport

The archive password must not be passed in:

- process argv
- environment variables
- workspace-configurable executable paths

The native helper path is fixed under the installed extension directory.
Password and file bytes are transferred through the private stdin/stdout binary
protocol.

### Secret lifetime

The password normally exists only in process memory.

During the one-time workspace mount handoff, password and archive path may be
stored temporarily in VS Code `SecretStorage` so a restarted Extension Host can
finish mounting. They must be deleted immediately after the handoff is consumed.

Do not turn this into general session persistence.

### Plaintext TEMP policy

Normal READ/WRITE operations do not intentionally create plaintext TEMP files.

The `MKDIR` implementation is a narrow exception: bit7z requires a filesystem
item for `addItems()`, so the helper creates a cryptographically random **empty
directory** in TEMP and aliases it to the archive directory path. No archive
file contents and no requested archive path are written there.

### Transactional mutation

Do not mutate the original archive directly.

All mutations use an encrypted sibling candidate, verify the candidate with 7z,
re-check the original SHA-256 baseline immediately before commit, and replace
through `ReplaceFileW`.

The fingerprint checks are security/integrity checks, not optional diagnostics.

### External modification

A mounted session keeps an archive SHA-256 baseline.

Reads check the original before and after native extraction. Mutations check the
baseline at multiple transaction boundaries. A mismatch makes the session stale
and the operation fails instead of merging unknown external changes.

### Archive path and virtual-tree safety

Archive member names are untrusted input.

Before a tree is mounted, entries are rejected if they contain:

- absolute or drive-qualified paths
- empty path segments
- `.` or `..` segments
- NUL characters
- duplicate/canonical path collisions
- file-as-ancestor contradictions such as `file` plus `file/child`

The virtual filesystem also binds every resource URI to the random authority of
the active `encrypted7z://<session-id>/` root. A stale URI from an older session
must fail instead of resolving against the newly opened archive.

These checks are part of the security boundary, not UI validation.

### Mixed encryption

File data encryption and header encryption are separate policies.

- normal save: preserve the item's existing data-encryption state
- new file: encrypted by default
- explicit data toggle: change only the target's data encryption
- explicit header toggle: change the archive-wide header policy

The `🔓` Explorer badge means `Unencrypted data`.

A `🔓` file can still have its filename hidden when header encryption is ON.


### Zero-byte file data encryption

The 7z format represents an empty file using EmptyStream / EmptyFile metadata;
there is no file-data stream to run through an AES coder.

Therefore a zero-byte file does not have a meaningful persisted per-file
**data-encryption** state.

Security policy:

- do not display `🔓` for empty files
- do not pretend Toggle Data Encryption can encrypt an absent stream
- when an empty file later receives content, treat that content as new data and
  encrypt it by default
- filename protection remains governed independently by header encryption

This avoids a dangerous false inheritance where an archive reader reports an
empty item as unencrypted and later content would otherwise be written
unencrypted.

### Header rewrite lifecycle

Mixed-encryption changes may require:

```text
header OFF
target data rewrite
header ON
```

These phases are deliberately executed using separate short-lived helper
processes. Earlier real-archive tests showed that reusing one native process
across successive bit7z archive rewrites could produce access/unsupported
operation failures.

Do not merge these phases merely to reduce process launches without regression
testing.

### Solid reblock fallback

For a non-empty item in a solid archive with `packSize == 0`, changing encryption
may require removing the item from the old shared block and adding it back as
new archive data.

This changes internal solid-block placement. It is a compatibility mechanism for
the 7z format, not an optimization.

## Secure Text Editor

The Secure Text Editor exists for one security reason: avoid VS Code's normal
`TextDocument` working-copy backup path.

It uses:

```text
CustomEditorProvider
private CustomDocument
Webview editor
```

VS Code-requested backups are AES-256-GCM ciphertext.

Current backup format:

```text
magic: E7SBK02
PBKDF2-HMAC-SHA256
120,000 iterations
16-byte salt
12-byte IV
16-byte GCM authentication tag
```

The encrypted payload contains:

- unsaved text
- source archive path
- archive member path
- archive fingerprint
- backup timestamp

If the archive fingerprint changed before a backup is restored, the editor marks
a recovery conflict and refuses to save the stale recovery state over the newer
archive.

### What this editor does not guarantee

- plaintext is present in JS / Webview memory while editing
- JavaScript strings cannot be reliably zeroized
- OS swap/pagefile and crash dumps are outside the guarantee
- avoiding `TextDocument` does not create an extension-isolation boundary: the
  Secure Virtual scheme is still backed by a VS Code `FileSystemProvider` whose
  `readFile` path returns decrypted bytes for valid active-session resources;
  Secure Virtual therefore does not claim to prevent other installed extensions
  from observing plaintext through VS Code APIs if they can address such a
  resource
- this is not intended to reproduce every built-in VS Code editor feature

## Standard Virtual mode

The standard editor path uses a normal VS Code `TextDocument`.

`files.hotExit=off` is forced only while a Standard Virtual session is active
and restored afterward, but this is supplemental only. It is not sufficient to claim that standard
working-copy persistence cannot occur.

Use Secure Virtual mode when that distinction matters.

Because this path creates a normal VS Code `TextDocument`, other installed
extensions with appropriate VS Code API access can also observe that document.
That is another reason not to describe Standard Virtual as the strict boundary.

## Webview policy

Secure Webviews should:

- use `default-src 'none'` CSP
- avoid remote/CDN dependencies
- keep `localResourceRoots` empty unless a reviewed local resource is necessary
- never receive archive passwords

## Logging policy

Release logging is privacy-minimized by default.

- routine operation logs omit source archive paths and archive member names
- routine Materialized autosync logs omit filesystem event paths
- archive fingerprint values are not printed; logs report only whether the baseline is active or mismatched
- operation-level diagnostics, counts, modes, and phase names remain available
- passwords and plaintext contents are never logged
- interactive error messages may identify the affected user-visible resource when that is necessary to explain a failure; such details are not added to routine Output logs

## Release/security review notes

- Keep the dedicated regression for normal save of an already-unencrypted item
  while Header Encryption is ON. That case has been exercised successfully, but
  adjacent mixed-encryption operations previously exposed helper-lifecycle
  sensitivity, so the test remains intentional.
- Windows x64 is the only native build currently shipped.
- Directory-only Header Encryption toggles use a temporary zero-byte anchor only
  inside the transactional candidate. A truly empty archive reports Header
  Encryption as N/A because there is no member name to protect.
- Large-file memory limits are not enforced; file bytes may exist in several
  in-memory buffers during an operation.
- Native dependency versions are pinned for the release build: bit7z 4.1.0 is
  fetched by exact release commit and both headers/runtime target 7-Zip 26.03.
  The package step verifies generated native hashes against the build manifest.
  Version/hash consistency does not itself prove the provenance of an arbitrary
  caller-supplied `7z.dll`; public release builders must intentionally select the
  upstream 7-Zip 26.03 x64 distribution.
- Project-level publisher/repository/license metadata and release signing are
  still separate release decisions and are not yet final.


## Mode immutability

Security properties are session-level, not per-tab preferences. An archive
session records exactly one mode. Switching from Standard Virtual to Secure
Virtual after a TextDocument has already existed cannot retroactively erase
working-copy persistence, so in-place mode switching must not be offered.

A mode change means closing the current archive session and opening a new one.

Automatic mode-specific editor routing is already part of the session model.
Do not add an in-place Secure/Standard mode switch that would pretend earlier
`TextDocument` exposure can be undone.


## Mode-specific URI boundary

Secure Virtual and Standard Virtual intentionally use separate URI schemes.

```text
Secure Virtual   encrypted7z-secure://
Standard Virtual encrypted7z://
```

The active session validates both scheme and random authority. A resource from a
different mode or old session must not resolve against the current archive.

Secure Text Editor is registered as the default only for the Secure Virtual
scheme-qualified resource pattern. This avoids globally claiming ordinary files.


## Materialized mode security boundary

Materialized mode intentionally relaxes the virtual-mode plaintext persistence
goal. The extension creates a random system-TEMP directory and decrypted
archive contents are written there.

Security rules:

- the extension creates and owns a fresh random system-TEMP directory before materialization
- archive paths are revalidated for Windows filesystem legality and
  case-insensitive collisions before any plaintext write
- symlinks/junctions/special files in the working tree are not followed during
  sync
- `.git` is ordinary project/archive content and round-trips normally,
  including repositories created during the Materialized session
- temporary `.git/**/*.lock` files defer autosync until Git finishes its
  metadata transaction
- the encrypted source archive fingerprint must still match the session
  baseline before sync; external archive changes cause sync refusal
- sync still uses encrypted candidate + 7z integrity test + `ReplaceFileW`
- same-path edits to an existing non-empty file preserve that item's
  data-encryption state; a new/recreated/new-path non-empty item follows the
  new-data default and is encrypted
- Materialized mode does not guarantee preservation of archive-item metadata
  such as modified time or Windows attributes when filesystem activity is
  reconciled as delete + add
- archive passwords are never stored in working-directory files; after a normal
  VS Code restart the password is requested again before sync
- while a Materialized session exists, extension state records the source
  archive path, working-directory path, and encrypted-archive fingerprint so an
  unsynced working tree can be recognized after restart; the password is not
  stored in that persistent session metadata

If sync fails or the source archive changed externally, the plaintext working
directory is retained so user edits are not destroyed.


## Activation registration ordering

Filesystem providers and Custom Editor providers are registered synchronously
before awaited startup recovery.

VS Code may activate the extension because it needs one of the virtual schemes
or Custom Editors. Recovery can also call `vscode.openFolder`, which tears down
the current Extension Host. Provider registration therefore belongs before that
asynchronous/redirect boundary.


## Materialized autosync and deletion

Materialized mode intentionally writes plaintext to disk, but minimizes its
normal lifetime.

Filesystem create/change/delete/rename activity inside the active working
directory queues a debounced serialized transactional archive sync. Normal
close/shutdown attempts a final sync before plaintext deletion. Manual Sync
remains available as an explicit checkpoint.

Security/data-loss rule:

> Never delete the Materialized working directory after a failed final sync.

If shutdown cannot authenticate, archive integrity verification fails, or the
source archive changed externally, plaintext is retained for recovery.

This is not crash-proof secure deletion. OS crash, force-kill, filesystem
journaling, backups, antivirus/indexers, and storage-device behavior remain
outside the guarantee.


## Materialized TEMP placement and Git metadata

Materialized plaintext is created in a random extension-owned subdirectory of
the system TEMP directory rather than beside the source `.7z`:

```text
%TEMP%\7z-secure-workspace-<random>\
```

The source archive basename is intentionally not included in the TEMP directory
name. This avoids disclosing the archive name through the plaintext working-copy
path and avoids a common accidental-disclosure path where an encrypted archive
lives inside OneDrive, Dropbox, NAS sync, or a backup-managed project directory
and a neighboring plaintext copy would be replicated automatically.

System TEMP is still plaintext persistent storage. The choice reduces accidental
lifetime/replication; it does not provide forensic secure deletion.

`.git` is not excluded. It is ordinary Materialized content and can be protected
inside the encrypted archive with the rest of the project. Temporary Git lock
files postpone autosync so the extension does not intentionally archive a Git
metadata transaction while it is in progress.


## External VS Code close/reload behavior

A passwordless Virtual session must never be silently resumed after VS Code
closes/reloads its workspace outside the extension command.

The extension therefore records an `endedExternally` lifecycle marker while
deleting SecretStorage handoff values. If the same virtual URI is restored on a
later activation, it is rejected fail-closed and the saved return target is
restored.

Materialized external exit attempts final sync without prompting. Deletion of
the plaintext TEMP directory still occurs only after successful final sync.
Failure preserves plaintext and persistent recovery metadata.



## Development host note

There is no separate Development security/mount mode. F5 and installed builds
execute the same archive-session code.

A Development Host window closing during `vscode.openFolder` is a debugger-host
lifecycle issue, not a security fallback. Security and session-lifetime claims
must be confirmed against an installed VSIX.


## Temporary header-policy anchor

Directory-only Header Encryption toggles use a generated archive member name
only inside the transactional candidate archive. The original archive is not
modified until the candidate has passed the normal integrity test and
transactional replacement.

The temporary item contains zero bytes and is deleted before commit. If creation,
header toggle, deletion, testing, or commit preparation fails, the candidate is
discarded.
