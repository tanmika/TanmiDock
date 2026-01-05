# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- SIGINT/SIGTERM signal handling with graceful shutdown
- Global exception handler with DEBUG mode support
- Configuration version checking and migration system
- Path security validation to prevent path traversal attacks
- Global operation lock to prevent concurrent command execution
- Disk space pre-check before download operations

### Changed
- Configuration version bumped to 1.1.0

## [0.2.0] - 2026-01-05

### Added
- Vitest testing framework with coverage support
- File lock mechanism using proper-lockfile
- Transaction system for atomic link operations
- TOCTOU race condition fixes
- fs-utils module for common file operations
- ESLint + Prettier configuration

### Changed
- Improved error handling throughout codebase
- Better code organization with extracted utilities

### Fixed
- Race conditions in concurrent file access
- Link operation atomicity issues

## [0.1.0] - 2026-01-04

### Added
- Initial release
- `init` command - Initialize TanmiDock configuration
- `link` command - Link project dependencies to central store
- `status` command - Show current project status
- `projects` command - List all tracked projects
- `clean` command - Clean unreferenced libraries
- `unlink` command - Remove symlinks from project
- `config` command - View/modify configuration
- `migrate` command - Migrate store to new location
- Central store with symlink-based dependency management
- Cross-platform support (macOS and Windows)
- codepac integration for dependency download

[Unreleased]: https://github.com/user/tanmi-dock/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/user/tanmi-dock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/user/tanmi-dock/releases/tag/v0.1.0
