<!--
SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
SPDX-License-Identifier: Apache-2.0
-->

# AGENTS.md

Repository-local guidance for AI coding agents and human contributors working on
`mcp-server-simulator-ios-idb` — an MCP server that lets LLMs control iOS
simulators via natural language instructions executed through `idb` and
`xcrun simctl`.

For component responsibilities, the execution flow, the session model, and the
checklist for adding a new command, read [ARCHITECTURE.md](ARCHITECTURE.md).
This file intentionally does not duplicate it.

## Build, test, and run

Actual scripts defined in `package.json` (there is **no** lint script in this
repository):

| Command | What it does |
|---|---|
| `npm run build` | Compiles TypeScript to `dist/` with `tsc` |
| `npm test` | Runs Jest with ts-jest (`NODE_OPTIONS=--experimental-vm-modules`) |
| `npm run test:coverage` | Same as `npm test` with coverage |
| `npm start` | Runs `node dist/index.js` (the MCP stdio server) |

### ⚠️ Dependency installation has heavy side effects

`npm install` and `npm ci` both trigger the `postinstall` script
(`scripts/install_dependencies.sh`), which:

1. Hard-fails unless running on **macOS** with **Homebrew** available.
2. Runs `brew tap facebook/fb && brew install idb-companion`.
3. Hard-fails unless a **Python virtual environment is already active**
   (`$VIRTUAL_ENV` must be set), then runs
   `python3 -m pip install --upgrade pip` followed by
   `python3 -m pip install fb-idb` into it.

Do not run these installers as part of agent work unless installing
dependencies is explicitly the task. Before running them manually, create and
activate the venv (`python3 -m venv venv && source venv/bin/activate`) and keep
it active whenever the server runs.

## Language and module conventions

- **TypeScript ESM**, `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`
  (`tsconfig.json`), targeting ES2020 with `strict: true`.
- **Relative imports must end in `.js`** (e.g. `import { IDBManager } from
  '../idb/IDBManager.js'`) — this is required by NodeNext ESM resolution even
  for `.ts` source files. Do not write extensionless relative imports.
- Node.js >= 20; `package.json` declares `"os": "darwin"` in its `engines`
  field.
- Keep the SPDX copyright and license header lines at the top of source
  files, consistent with existing files and [REUSE.toml](REUSE.toml).

## stdout is reserved for the MCP stdio transport

- `src/index.ts` overrides `console.log/info/warn/debug` and routes
  `console.error` to `stderr` in its module body. But ESM evaluates static
  imports **before** the module body runs, regardless of where the override
  statements appear textually — so diagnostics emitted by imported modules
  during their own evaluation are not guaranteed to be suppressed.
- The effective invariant holds from `start()` onward: once the server runs,
  nothing writes to **stdout** — it is the protocol pipe. Diagnostics go to
  **stderr** (`process.stderr.write`) or to the log file
  `logs/mcp-server.log` written synchronously by `src/mcp/mcp-server.ts`
  (`logToFile`).

## Import side effects (important when using the code as a library)

- Importing `src/index.ts` (the package root, `dist/index.js`) **immediately
  starts the MCP stdio server**: it creates a `logs/` directory, registers
  process handlers (`SIGINT`, `SIGTERM`, `uncaughtException`,
  `unhandledRejection`), overrides console output in its module body, and
  calls `start()` at module load. There is no opt-out.
- Importing `src/mcp/mcp-server.ts` instantiates the singleton
  `MCPSimulatorServer` at module load: it also creates `logs/`, registers
  signal handlers, and registers tool handlers.
- To use the components **without** transport/signal bootstrap, import the
  compiled component modules by deep path instead of the package root,
  e.g. `mcp-server-simulator-ios-idb/dist/orchestrator/MCPOrchestrator.js`,
  `.../dist/parser/NLParser.js`, `.../dist/idb/IDBManager.js`, and the
  adapters under `.../dist/adapters/`. Named imports from the package root do
  **not** avoid the startup side effects — the root module always bootstraps.

## Exercise extreme caution when executing simulator commands

- Preserve **command + argument array separation**: `IDBManager.executeCommand`
  uses `child_process.execFile(command, args)`. Never concatenate user-derived
  values into a shell command string or introduce a shell-invoking path —
  argument-list execution is part of this codebase's command injection defense.
- `IDBManager` methods resolve a session ID to a UDID through an internal
  map and throw `Session not found: ${sessionId}` for unknown sessions. Do not
  bypass session resolution to execute against raw UDIDs outside the
  existing by-UDID methods.

## Testing

- Tests live in `src/**/__tests__/` (Jest + ts-jest, ESM via
  `--experimental-vm-modules`):
  - `src/idb/__tests__/IDBManager.test.ts`
  - `src/orchestrator/__tests__/MCPOrchestrator.test.ts`
  - `src/parser/__tests__/NLParser.test.ts`
- Existing unit tests spy on `IDBManager`'s private `executeCommand` (or mock
  collaborators) and never touch real simulators.
- Tests that drive a **real simulator** through `idb` / `xcrun simctl` are an
  explicitly approved operation only: require explicit user/agent approval
  before running anything that boots, installs, taps, or otherwise mutates
  simulator state. Default to mocking.

## Never edit generated directories

Do not edit files in:

- `dist/` — TypeScript build output
- `coverage/` — Jest coverage output
- `node_modules/`
- `venv/` — Python virtual environment
- `logs/` — runtime server logs

## Adding a new command

Follow the concrete checklist (files to touch, registration order, adapter
mapping) in [ARCHITECTURE.md](ARCHITECTURE.md#adding-a-new-command). In short:
a new command must be added in the parser definition, reflected in the
`ParserToOrchestrator` mapping, and implemented in `OrchestratorToIDB` +
`IDBManager` — a command existing in only one layer is incomplete.

## Contribution, licensing, and security

- Human contribution flow (CLA, branch/PR conventions): [CONTRIBUTING.md](CONTRIBUTING.md).
- Vulnerability reporting: [SECURITY.md](SECURITY.md).
- The project is Apache-2.0. Keep SPDX license/copyright annotations on new
  files; Markdown documentation currently carries its annotations either in
  the file itself or via [REUSE.toml](REUSE.toml).
