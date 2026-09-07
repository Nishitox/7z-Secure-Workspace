# 7z Secure Workspace

[English](README.md) | [日本語](README.ja.md)
A Windows VS Code extension for opening and editing encrypted `.7z` archives as
workspaces, with explicit security and compatibility tradeoffs for different
editing modes.

> **Development:** Developed by Nishitox with development assistance from OpenAI GPT-5.6 Sol.

**Version 1.0.0 targets Windows x64 and VS Code 1.136.1 or later.** The stable
1.0 release was regression-tested on VS Code 1.136.1.

## Current capabilities

- Open a local `.7z` directly from VS Code.
- Mount the archive as a dedicated virtual workspace in Secure Virtual or
  Standard Virtual mode.
- Read and write archive members through a native `7z.dll` bridge.
- Preserve existing per-file Data Encryption on normal virtual saves.
- Create new non-empty file data encrypted by default.
- Mix encrypted and unencrypted file data in one archive.
- Toggle per-file Data Encryption and archive Header Encryption independently.
- Mark files whose **data** is unencrypted with `🔓` in Explorer.
- Detect external archive modification before reads and commits.
- Commit mutations transactionally through an encrypted candidate archive.
- Use a private `CustomDocument` Secure Text Editor path with encrypted VS Code
  backup data.
- Keep the normal VS Code text editor available through Standard Virtual mode.
- Provide an explicit Materialized mode for normal filesystem, Git, and
  external-tool workflows.
- Support solid archives, zero-byte files, directory-only archives, and direct
  `.7z` Custom Editor opening.

## Opening an archive

Open a local `.7z` using normal VS Code file-open paths, including
double-clicking the file in the VS Code Explorer or using `Ctrl+O`.

The extension prompts for the archive password and then asks which session mode
to use. The Command Palette entry `7z Secure: Open Encrypted Archive` uses the
same mount path.

## Session modes

The selected mode is immutable for the archive session. Changing mode requires
closing and reopening the archive.

### Secure Virtual

Uses a virtual archive filesystem and a private `CustomDocument` Secure Text
Editor. Archive file contents are not intentionally materialized as plaintext
files during normal operation, and Secure Editor backup data is encrypted.

This minimizes VS Code working-copy exposure, but it is **not** a complete
sandbox. Plaintext exists in process memory while being used, and protection
against page files, process dumps, clipboard use, malicious software, or every
possible observation path available to another VS Code extension is outside the
guarantee.

### Standard Virtual

Uses the virtual archive filesystem with normal VS Code `TextDocument` editing.
It also avoids intentionally materializing archive contents as plaintext files,
but exposes plaintext to a broader VS Code extension/editor surface than Secure
Virtual.

### Materialized

Explicitly writes plaintext into a random extension-owned system-TEMP working
directory for normal filesystem, Git, and external-tool workflows. Filesystem
changes are autosynced back to the encrypted archive, and manual Sync remains
available as an explicit checkpoint.

New sessions use a directory of the form:

```text
%TEMP%\7z-secure-workspace-<random>\
```

The archive filename is intentionally not included in the TEMP directory name.
`.git` is ordinary project content and is synchronized with the rest of the
working tree; transient Git lock files defer autosync until Git metadata updates
finish.

Materialized mode treats the real working directory as the source of truth. An
operation such as rename may be represented as archive `delete + add`, so exact
archive-item identity is not guaranteed:

- contents and paths are synchronized
- same-path edits to existing non-empty items preserve their current Data
  Encryption state
- new, recreated, or new-path non-empty items follow the new-data default and
  are encrypted
- original modified time, Windows attributes, and similar archive-item metadata
  are best-effort when an item is reconstructed

Successful normal close performs a final sync before deleting plaintext. If the
final sync fails, the working directory is retained for recovery rather than
risking data loss. Crash/force-kill cleanup cannot be guaranteed, and deletion
is not secure erase.

Use Secure Virtual or Standard Virtual when archive-native item identity and
metadata fidelity matter more than normal filesystem/tooling compatibility.

## Zero-byte files and Data Encryption

A zero-byte 7z member has no file-data stream, so per-file **Data Encryption** is
not applicable while it remains empty.

- empty files do not show the `🔓` Data Encryption badge
- Toggle Data Encryption on an empty file is an informational no-op
- when content is first added, that new data is encrypted by default
- Header Encryption remains independent and can still protect the filename

## Header Encryption edge cases

Header Encryption protects archive member names, including directory names.
Directory-only archives are supported. A truly empty archive has no member name
to protect, so Header Encryption is reported as **N/A** instead of pretending
that an OFF state is meaningful.

The directory-only implementation details and transactional temporary-anchor
rule are documented in `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## VS Code lifecycle

`7z Secure: Close Encrypted Archive` is the explicit close path, but native VS
Code close/reload behavior is also handled.

- Virtual sessions fail closed after VS Code restart instead of silently
  restoring a passwordless decrypted session.
- Materialized external exit attempts final sync and cleanup; unsuccessful final
  sync preserves plaintext and recovery metadata.

Final lifecycle regression should be performed with an installed VSIX because
the Extension Development Host has a debugger-specific workspace-reload
lifecycle.

## Activity Bar UI

The extension contributes a **7z Secure** Activity Bar item. Its command surface
exposes the session-appropriate operations, including:

- Open Encrypted Archive
- Close Encrypted Archive
- Toggle Header Encryption for Virtual sessions
- Secure Editor Security Status for Secure Virtual sessions
- Sync Materialized Working Directory for Materialized sessions

Per-file **Toggle Data Encryption** remains in the Explorer file context menu
because that operation requires a selected archive member.

## Installation

Download the release VSIX from GitHub, then in VS Code use:

**Extensions → `...` → Install from VSIX...**

The release VSIX bundles the native bridge and `7z.dll`; end users do not need a
separate native build or Node.js installation.

Repository: https://github.com/Nishitox/7z-Secure-Workspace

## Build from source

Native bridge changes require Windows x64, CMake, Visual Studio C++ Build Tools,
Git, and 7-Zip 26.03 x64:

```powershell
cd .\native
.\build-native.ps1
```

For JavaScript-only changes, use the included VS Code Extension Development Host
configuration. Release packaging is performed with:

```powershell
.\package-vsix.ps1
```

The native release build pins bit7z 4.1.0 and targets 7-Zip 26.03. Native binary
hashes are recorded in the generated runtime manifest and verified again during
packaging. Detailed source layout, packaging prerequisites, and release
provenance are documented in `docs/DEVELOPMENT.md` and `docs/RELEASE.md`.

## Security and support

The canonical security intent is documented in
[`docs/SECURITY.md`](docs/SECURITY.md). Security-sensitive findings should be
reported through GitHub **Private vulnerability reporting** rather than a public
Issue when that feature is enabled for this repository. Do not attach real
passwords, private archives, or sensitive plaintext to reports.

The project is maintained on a **best-effort basis**. No response-time or support
SLA is promised. Ordinary reproducible bugs may be reported through GitHub
Issues.

## Documentation

- [Architecture and mode model](docs/ARCHITECTURE.md)
- [Security model and invariants](docs/SECURITY.md)
- [Regression testing](docs/TESTING.md)
- [Development / contributor guidance](docs/DEVELOPMENT.md)
- [Native bridge protocol](docs/NATIVE_PROTOCOL.md)
- [Release provenance and packaging](docs/RELEASE.md)

Third-party notices remain in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Project and license

- Publisher: `Nishitox`
- Repository: https://github.com/Nishitox/7z-Secure-Workspace
- Extension source: MIT License, `Copyright (c) 2026 Nishitox`
- Third-party components retain their upstream licenses; see
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the license files
  bundled with release artifacts.
