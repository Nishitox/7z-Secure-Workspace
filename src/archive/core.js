"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { VIRTUAL_SCHEME, SESSION_MODE } = require("../constants");
const { validateArchiveEntries } = require("../security/paths");

function isKnownSessionMode(mode) {
  return Object.values(SESSION_MODE).includes(mode);
}

function isVirtualSessionMode(mode) {
  return (
    mode === SESSION_MODE.SECURE_VIRTUAL ||
    mode === SESSION_MODE.STANDARD_VIRTUAL
  );
}

function virtualSchemeForMode(mode) {
  switch (mode) {
    case SESSION_MODE.SECURE_VIRTUAL:
      return VIRTUAL_SCHEME.SECURE;
    case SESSION_MODE.STANDARD_VIRTUAL:
      return VIRTUAL_SCHEME.STANDARD;
    default:
      throw new Error(
        `Session mode ${String(mode)} has no virtual URI scheme.`
      );
  }
}

function isVirtualResourceScheme(scheme) {
  return (
    scheme === VIRTUAL_SCHEME.SECURE ||
    scheme === VIRTUAL_SCHEME.STANDARD
  );
}

function isSecureVirtualUri(uri) {
  return Boolean(
    uri &&
    uri.scheme === VIRTUAL_SCHEME.SECURE
  );
}

function requireVirtualSessionMode(mode) {
  if (!isKnownSessionMode(mode)) {
    throw new Error(`Unknown archive session mode: ${String(mode)}`);
  }
  if (!isVirtualSessionMode(mode)) {
    throw new Error(
      `Session mode ${mode} is not a virtual-workspace mode.`
    );
  }
  return mode;
}

function sessionModeLabel(mode) {
  switch (mode) {
    case SESSION_MODE.SECURE_VIRTUAL:
      return "Secure Virtual";
    case SESSION_MODE.STANDARD_VIRTUAL:
      return "Standard Virtual";
    case SESSION_MODE.MATERIALIZED:
      return "Materialized";
    default:
      return "Unknown";
  }
}

function modeUsesHotExitGuard(mode) {
  // Secure Virtual owns its CustomDocument backup and Materialized explicitly
  // allows plaintext-on-disk. Only Standard Virtual relies on TextDocument and
  // therefore needs the supplemental global files.hotExit guard.
  return mode === SESSION_MODE.STANDARD_VIRTUAL;
}

class ExternalArchiveChangeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalArchiveChangeError";
  }
}

async function computeArchiveFingerprint(archivePath) {
  let before;
  try {
    before = await fs.promises.stat(archivePath);
  } catch (error) {
    throw new ExternalArchiveChangeError(
      `Archive is no longer available: ${archivePath}`
    );
  }

  if (!before.isFile()) {
    throw new ExternalArchiveChangeError(
      `Archive path is no longer a regular file: ${archivePath}`
    );
  }

  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(archivePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  let after;
  try {
    after = await fs.promises.stat(archivePath);
  } catch {
    throw new ExternalArchiveChangeError(
      `Archive disappeared while it was being checked: ${archivePath}`
    );
  }

  // Detect a file that changed while hashing it. This avoids accepting a hash
  // produced from a moving target.
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new ExternalArchiveChangeError(
      "Archive changed while Secure Mode was checking it. No write was attempted."
    );
  }

  return {
    size: after.size,
    sha256: hash.digest("hex")
  };
}

function sameArchiveFingerprint(a, b) {
  return Boolean(
    a &&
    b &&
    a.size === b.size &&
    a.sha256 === b.sha256
  );
}

async function assertArchiveUnchanged(
  archivePath,
  expectedFingerprint,
  output,
  phase
) {
  const actual = await computeArchiveFingerprint(archivePath);

  if (!sameArchiveFingerprint(actual, expectedFingerprint)) {
    output?.appendLine(
      `[EXTERNAL CHANGE] ${phase}: archive fingerprint mismatch.`
    );

    throw new ExternalArchiveChangeError(
      "The .7z archive changed outside Secure Mode after it was opened. " +
      "Your Secure Mode changes were NOT written. Close and reopen the archive " +
      "before editing it again."
    );
  }

  return actual;
}

async function readStableArchiveState(backend, archivePath, password) {
  // Fingerprint both sides of the archive listing. If another process changes
  // the archive while it is being opened, do not mount a tree from one version
  // while remembering the fingerprint of another.
  const before = await computeArchiveFingerprint(archivePath);
  const entries = await backend.list(archivePath, password);
  const headerEncrypted = await backend.getHeaderEncryption(
    archivePath,
    password
  );
  const after = await computeArchiveFingerprint(archivePath);

  if (!sameArchiveFingerprint(before, after)) {
    throw new ExternalArchiveChangeError(
      "The .7z archive changed while Secure Mode was opening it. Please open it again."
    );
  }

  // All archive trees entering the session must pass path/collision validation
  // at this boundary. Callers can still validate defensively, but they should
  // not need to remember to do so before using this stable snapshot.
  validateArchiveEntries(entries);

  return {
    entries,
    fingerprint: after,
    headerEncrypted
  };
}

// All archive mutations use an encrypted sibling candidate.
//
// Invariants:
// 1. verify the original fingerprint before work,
// 2. mutate/test the candidate,
// 3. verify the original again immediately before commit,
// 4. atomically replace via the native ReplaceFileW wrapper.
//
// This protects against both failed archive rewrites and external concurrent
// modification. Do not replace this with direct in-place mutation.
async function mutateArchiveTransactionally({
  archivePath,
  backend,
  password,
  expectedFingerprint,
  output,
  mutate
}) {
  const archiveDir = path.dirname(archivePath);
  const archiveBase = path.basename(archivePath);
  const token = crypto.randomBytes(8).toString("hex");

  const candidateArchive = path.join(
    archiveDir,
    `.${archiveBase}.${token}.candidate.7z`
  );
  const backupArchive = path.join(
    archiveDir,
    `.${archiveBase}.${token}.backup.7z`
  );

  let committed = false;

  try {
    await assertArchiveUnchanged(
      archivePath,
      expectedFingerprint,
      output,
      "before mutation"
    );

    fs.copyFileSync(archivePath, candidateArchive);

    await assertArchiveUnchanged(
      archivePath,
      expectedFingerprint,
      output,
      "after candidate copy"
    );

    await mutate({ candidateArchive });
    await backend.test(candidateArchive, password);

    const candidateFingerprint = await computeArchiveFingerprint(
      candidateArchive
    );

    await assertArchiveUnchanged(
      archivePath,
      expectedFingerprint,
      output,
      "before commit"
    );

    await backend.replaceFile(
      archivePath,
      candidateArchive,
      backupArchive
    );
    committed = true;

    // ReplaceFileW created an encrypted backup of the previous original.
    fs.rmSync(backupArchive, { force: true });

    output?.appendLine(
      "[ARCHIVE BASELINE] Updated after successful transactional commit."
    );

    return {
      fingerprint: candidateFingerprint
    };
  } catch (error) {
    // A documented ReplaceFileW failure can move the old original to the
    // backup pathname before failing to move the replacement. Restore only
    // when the original pathname is absent.
    if (!fs.existsSync(archivePath) && fs.existsSync(backupArchive)) {
      try {
        fs.renameSync(backupArchive, archivePath);
      } catch {
        output?.appendLine(
          "[RECOVERY WARNING] Encrypted backup could not be restored automatically."
        );
      }
    }

    throw error;
  } finally {
    fs.rmSync(candidateArchive, { force: true });

    // On unusual failure states keep an encrypted backup instead of deleting
    // a potentially recoverable copy.
    if (committed) {
      fs.rmSync(backupArchive, { force: true });
    }
  }
}


module.exports = {
  isKnownSessionMode,
  isVirtualSessionMode,
  virtualSchemeForMode,
  isVirtualResourceScheme,
  isSecureVirtualUri,
  requireVirtualSessionMode,
  sessionModeLabel,
  modeUsesHotExitGuard,
  ExternalArchiveChangeError,
  computeArchiveFingerprint,
  sameArchiveFingerprint,
  assertArchiveUnchanged,
  readStableArchiveState,
  mutateArchiveTransactionally
};
