# Contributing to 8ras Time Tracker

This project is private personal software -- it is not accepting external contributions at this time. The following notes are for the author's own reference when maintaining or extending the plugin.

## Development workflow

1. Edit `main.js`, `index.html`, and/or `style.css` directly. No build step.
2. Run tests: `node test/smoke.cjs`. All 65 assertions must pass.
3. Test in Photoshop with UDT (UXP Developer Tools): select **Reload** from the panel menu.

## Architecture notes

- Single classic `<script>` (`main.js`) loaded from `index.html`. No ES modules, no bundler.
- All UXP API calls verified against [AdobeDocs/uxp-photoshop](https://github.com/AdobeDocs/uxp-photoshop).
- Date keys use local calendar dates (not UTC) to avoid timezone-shift bugs across timezones.
- Persistent token mechanism (`createPersistentToken` / `getEntryForPersistentToken`) remembers the data folder between Photoshop sessions.
- Data folder contains exactly one meaningful file: `metrics.json`. A `.tracker-token.json` metadata marker stores configuration (threshold, folder path, token string).

## Adding new features

1. Write failing tests first in `test/smoke.cjs`.
2. Implement in `main.js`.
3. Verify with `node test/smoke.cjs`.
4. Update `CHANGELOG.md` with a section under `[Unreleased]`.
5. Bump version in `manifest.json`, `main.js`, `index.html`, and `README.md`.

## Testing philosophy

The smoke test suite mocks the real PS UXP API faithfully:
- `localFileSystem.getFolder()` returns a mock Folder object.
- `createPersistentToken(entry)` returns a deterministic token string.
- `getEntryForPersistentToken(token)` resolves back to the same Folder.
- File read/write operations write to an in-memory dictionary keyed by filename.
- Notification listeners fire callbacks via `fireActivity()`.

Tests cover: fresh install, folder selection, activity tracking, idle timeout, document switching, unsaved documents, CSV export, threshold persistence, full restart restore, and folder reconfiguration.
