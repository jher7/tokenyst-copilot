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
