# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-11-24

### Added

- [#19](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/19) Support tvOS simulators: Siri Remote input, focus-aware accessibility and a real tvOS integration suite

## [2.0.0] - 2026-11-19

### Added

- [#82](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/82) Support foldable simulators (iPhone Duo): hinge angle, posture and per-display screenshots
- [#101](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/101) Eliminate redundant idb list-targets checks, duplicate simctl listings, and cwd screenshot temp files

### Changed

- [#76](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/76) Integration tests against a real iOS Simulator
- [#73](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/73) Complete stable dependency and toolchain upgrade
- [#65](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/65) Add AGENTS.md and ARCHITECTURE.md and align README library docs with actual code
- [#40](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/40) CodeQL code security fixes
- [#29](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/29) CodeQL enhancements
- [#18](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/18) Update SECURITY.md
- [#10](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/10) Update SECURITY.md

### Fixed

- [#104](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/104) Recover once from companion startup timeouts
- [#92](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/92) Fix MCP command contract gaps found during real-simulator validation
- [#93](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/93) Route verification instructions to the isAppInstalled and isSimulatorBooted commands
- [#95](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/95) Return screenshots as image content instead of a Buffer JSON object
- [#94](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/94) Report app-listing failures instead of treating the app as missing
- [#89](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/89) install app returns a made-up bundle ID instead of the one idb reports
- [#72](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/72) Most parser commands are not executed or run the wrong operation
- [#59](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/59) create session never matches a device name and boots a random simulator
- [#58](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/58) MCP server connects but exposes no tools and most instructions fail
- [#11](https://github.com/InditexTech/mcp-server-simulator-ios-idb/pull/11) Move MCP server creation logic to mcp-server.ts to resolve circular dependency issue

## [1.0.1] - 2025-04-02

### Fixed
- Fixed logs directory creation issue where logs were being created in the root directory instead of the application directory
- Updated both index.ts and mcp-server.ts to use ESM equivalent of __dirname instead of process.cwd()

## [1.0.0] - 2025-03-20

### Added
- Initial release
- Natural Language Parser for IDB commands
- MCP Server implementation
- IDB Manager with complete command support
- Orchestrator for command handling
- Support for all IDB simulator management features
- Extensive test coverage for core components
- Command registry with accessibility, app, capture, debug, misc, simulator and UI commands
- Documentation and examples
- Security policy
- Contribution guidelines
- Code of conduct
