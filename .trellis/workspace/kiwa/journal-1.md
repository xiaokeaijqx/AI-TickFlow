# Journal - kiwa (Part 1)

> AI development session journal
> Started: 2026-06-12

---



## Session 1: Fix DONE-tracking chain + security audit hardening

**Date**: 2026-06-16
**Task**: Fix DONE-tracking chain + security audit hardening
**Branch**: `main`

### Summary

Fixed a chain of task-completion bugs and hardened security. (1) Batch runtime state was renderer-memory-only and lost on restart/HMR, orphaning DONE markers -> persist per-filePath and restore on startup. (2) DONE parsing used an absolute char offset into a sliding tmux capture window (offset drift filtered out real markers) -> per-batch sentinel anchor re-located via lastIndexOf each poll. (3) writeTaskStatus flipped checkboxes by positional line index, so concurrent agent edits flipped the wrong task -> content/title-anchored writes. Then a full security audit: high-sev (sentinel-not-found now claims zero not all; validate persisted batchRuntime on restore; afplay exec->execFile + sound allowlist) and medium-sev (CSP, navigation/window-open guards, filePath allowlist on file IPC, custom-command control-char rejection + enforce-at-save, fs size cap). Audit #8 resolved per design: agent idle warning is advisory notice-only (no auto-stop), watchdog stays no-new-output based with threshold raised 5->20min, stopping consolidated to the single bottom Stop button. Every fix verified end-to-end against the live app. 4 spec docs captured the anti-patterns.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b75e4a7` | (see git log) |
| `32b0588` | (see git log) |
| `1cfc345` | (see git log) |
| `2bf4edc` | (see git log) |
| `03df71b` | (see git log) |
| `8615701` | (see git log) |
| `2dbb1dd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
