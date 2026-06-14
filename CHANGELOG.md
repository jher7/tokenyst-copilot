# Change Log

<!--
Section guide (omit any that are empty for a release):
  Added      – new features
  Changed    – changes to existing behavior
  Deprecated – soon-to-be removed features
  Removed    – features removed in this release
  Fixed      – bug fixes
  Security   – vulnerability fixes
-->

<!-- ## [Unreleased] -->

## [0.5.5] - 2026-06-14
### Changed
- Cache write/read is now presented as a **CLI-only** metric, since GitHub Copilot only persists a per-request cache breakdown for CLI sessions — Chat sessions never save it. Chat session details no longer show empty cache rows, and cache totals now live in their own **"Cache (CLI Only)"** section that appears only when you have CLI usage.

### Removed
- Removed the cache-reuse percentage and the "Low cache reuse" insight. These were derived from Chat cache data that isn't actually recorded, so they could be misleading.

## [0.5.4] - 2026-06-11
### Fixed
- Cache write/read tokens and cache-reuse percentage no longer show a misleading `0` when GitHub Copilot's session files don't include a per-request token breakdown (the case in recent VS Code builds). These now display **"not reported"**, and the "Low cache reuse" insight no longer fires when there is simply no cache data to measure.

## [0.5.3] - 2026-06-09
### Fixed
- Import Historical Usage no longer fails on Windows with `A system error occurred (EPERM): operation not permitted, rename`. Saving config now retries briefly when another process (e.g. antivirus or the search indexer) momentarily locks the file, and importing history saves once for the whole import instead of once per session.

- Fixed an issue where users with no chat history are shown a blank Tokenyst panel.

## [0.5.2] - 2026-06-05
### Fixed
- Collapse/Expand All control not working as expected.

## [0.5.1] - 2026-06-05
### Changed
- Update demo screenshots in README.

## [0.5.0] - 2026-06-05
### Added
- **Sessions panel**: a new section that lists usage per individual chat/CLI session. Click any row to expand a detail view.
- **Token breakdown**: totals for input, output, cache-write and cache-read tokens, plus a cache-reuse percentage, to show what's driving spend.
- **Optimization insights**: suggestion cards based on your usage patterns: low cache reuse, model hotspot, repo hotspot, and expensive-but-low-output sessions.
- Metric breakdown sections are now collapsible.

### Changed
- Breakdown bar charts use a wider label column.

## [0.4.0] - 2026-06-04
### Fixed
- Enabling Copilot tracking inside a **dev container** no longer fails with "No Copilot Chat session files found." Tokenyst now runs on the host by default, where VS Code stores Copilot Chat sessions, so Chat usage from dev containers (and WSL, SSH, Codespaces) is tracked automatically. No need to install it in the remote.

### Added
- Optional tracking of **Copilot CLI usage from inside a container**, via VS Code's `remote.extensionKind` setting.

## [0.3.1] - 2026-06-03
### Changed
- Improved Marketplace listing. No functional changes.

## [0.3.0] - 2026-06-02
### Added
- Track **GitHub Copilot CLI** usage alongside Copilot Chat, combined into one monthly budget. Tracking auto-detects CLI sessions (`~/.copilot`) — no separate setup; enabling tracking and importing history now cover both sources.
- New source in the breakdown stats panel showing how much spend came from Chat vs the CLI.

## [0.2.1] - 2026-06-02
### Fixed
- Fixed tracking unexpectedly disabling itself during normal use, caused by a config-file write race when syncing and importing usage at the same time

## [0.2.0] - 2026-06-02
### Added
- Import historical usage from last 30 days, 90 days, or all usage on disk
- View breakdown stats from last period or a custom date range
- Option to reset all Tokenyst data

### Fixed
- Fixed tracking issues for VS Code - Insiders users

## [0.1.5] - 2026-06-02
### Added
- Credit/dollar units toggle added to options menu
- Status bar today/this period toggle (by clicking the status bar value)

### Fixed
- Fixed This period/All time dropdown not persisting after re-opening the panel
