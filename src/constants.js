"use strict";

const VIRTUAL_SCHEME = Object.freeze({
  SECURE: "encrypted7z-secure",
  STANDARD: "encrypted7z"
});

const SESSION_KEY = "encrypted7zSecure.currentArchive";
const PASSWORD_KEY = "encrypted7zSecure.currentPassword";
const ARCHIVE_PATH_KEY = "encrypted7zSecure.currentArchivePath";
const HOT_EXIT_STATE_KEY = "encrypted7zSecure.hotExitPreviousState";
const MATERIALIZED_CLEANUP_KEY =
  "encrypted7zSecure.materializedPendingCleanup";
const MATERIALIZED_AUTOSYNC_DEBOUNCE_MS = 250;
const MATERIALIZED_GIT_LOCK_RETRY_MS = 500;
const ARCHIVE_OPENER_VIEW_TYPE =
  "encrypted7zSecure.archiveOpener";
const SECURE_UI_VIEW_ID =
  "encrypted7zSecure.actions";

const SESSION_MODE = Object.freeze({
  SECURE_VIRTUAL: "secureVirtual",
  STANDARD_VIRTUAL: "standardVirtual",
  MATERIALIZED: "materialized"
});

module.exports = {
  VIRTUAL_SCHEME,
  SESSION_KEY,
  PASSWORD_KEY,
  ARCHIVE_PATH_KEY,
  HOT_EXIT_STATE_KEY,
  MATERIALIZED_CLEANUP_KEY,
  MATERIALIZED_AUTOSYNC_DEBOUNCE_MS,
  MATERIALIZED_GIT_LOCK_RETRY_MS,
  ARCHIVE_OPENER_VIEW_TYPE,
  SECURE_UI_VIEW_ID,
  SESSION_MODE
};
