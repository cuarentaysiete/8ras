# Changelog

All notable changes to 8ras Time Tracker are documented here.

## [2.3.0] - 2025-11-17

### Fixed
- **Timezone bug**: date keys now use the local calendar date (year-month-day from the system clock) instead of UTC (`toISOString`). Previously, a Tuesday session in Madrid (UTC+1) could land on the Wednesday row when worked between 01:00-06:00 CET. All three test timezones (UTC, Europe/Madrid, America/New_York) now pass.
- **Idle resume after tool change** (v2.2.0 gap): tracking now resumes automatically when the user continues working with the same tool (e.g. brush strokes). The fix polls `app.activeDocument.historyStates.length` every second -- any increase in history stack depth triggers `touchDoc()`, reopening the current session without requiring a document or tool switch.

### Changed
- Weekday labels changed from single letters (M T W T F S S) to two-letter abbreviations (Mo Tu We Th Fr Sa Su).
- Header branding reverted to plain text ("8ras time tracker v2.3.0") -- no logo images.
- Test suite expanded from 46 to 65 assertions, covering timezone correctness and activity-probe resume.

## [2.2.1] - 2025-11-17

### Added
- Activity probe: `historyStates.length` polling in `tick()` to detect undoable steps (including strokes of the currently active tool), enabling automatic resume after idle without switching documents or tools.

## [2.2.0] - 2025-11-17

### Added
- Week starts on Monday (Mo through Su), not Sunday.
- LOG toggle moved inside Settings card (not header).
- "Change folder..." button in Settings to reconfigure the data folder location while preserving existing metrics.json.
- Explicit time units everywhere: "1h 05m 09s", "4m 12s", "38s" (never bare "hh:mm:ss").
- Progress bars scale to fixed 24-hour maximum (86400 seconds), not relative to max day.
- Default view shows timer only; "This week" tab must be pressed to reveal the dashboard.
- Official plugin name set to "8ras time tracker" (all lowercase) across manifest, HTML, and UI.

### Fixed
- Inline event handlers removed entirely: all click/change handlers use `data-action` / `data-change` attributes bound via `addEventListener` after innerHTML injection (UXP forbids inline handlers).
- `uxp.storage.local` fallback added for KV persistence (some PS builds do not expose it); `window.localStorage` used as primary store.

## [2.1.0] - 2025-11-17

### Added
- Complete rewrite abandoning React/Vite. Vanilla JS, separated into `main.js` (logic) and `style.css` (theme).
- Manifest v5 with new ID `com.8ras.time-tracker.v2`.
- Dark theme matching Photoshop's native panels.
- Headless smoke test suite (initially 46 assertions, growing with each release).

### Removed
- All React/Vite build tooling (Vite was incompatible with UXP's Chromium V8 engine).
