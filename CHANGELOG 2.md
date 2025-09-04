# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
