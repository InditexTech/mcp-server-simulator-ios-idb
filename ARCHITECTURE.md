<!--
SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
SPDX-License-Identifier: Apache-2.0
-->

# ARCHITECTURE

Architecture of `mcp-server-simulator-ios-idb` as implemented today. Every
section below is grounded in the actual source tree; repository-level agent
rules live in [AGENTS.md](AGENTS.md).

## Execution flow

```
MCP client (LLM host)
        │  JSON-RPC over stdio (StdioServerTransport)
        ▼
src/index.ts ── entry point: overrides console output in its module body,
        │      creates logs/, installs signal/exception handlers, calls
        │      start() unconditionally
        ▼
src/mcp/mcp-server.ts ── MCPSimulatorServer singleton (module-level instance)
        │  registers the `process-instruction` tool on CallToolRequestSchema
        ▼
src/orchestrator/MCPOrchestrator.ts ── processInstruction(instruction)
        │
        ├─ 1. parse          → NLParser.parseInstruction()   (ParseResult)
        ├─ 2. validate       → NLParser.validateInstruction() (ValidationResult)
        ├─ 3. normalize      → NLParser.normalizeParameters() (ParseResult)
        ├─ 4. convert        → ParserToOrchestrator.convertToCommand()
        │                       (ParseResult → IOrchestratorCommand)
        └─ 5. execute        → SEQUENCE/CONDITIONAL dispatched by
        │                       MCPOrchestrator; single commands by
        │                       OrchestratorToIDB.executeCommand()
        ▼
src/idb/IDBManager.ts ── execFile(<command>, <args[]>) against:
        • `idb` (facebook/idb CLI: ui tap, ui text, screenshot, install, …)
        • `xcrun simctl` (list devices --json, boot, shutdown)
```

A tool call returns one `CommandResult` (`{ success, data?, error?, timestamp }`)
serialized as JSON text content; on thrown errors the tool responds with
`isError: true` and the error message. Unsupported tool names raise
`MethodNotFound`; missing/non-string `instruction` arguments raise
`InvalidParams`.

## Component responsibilities and contracts

| Component | File | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Transport bootstrap. Overrides `console.log/info/warn/debug` and routes `console.error` to stderr **in its module body**; creates `logs/`; registers `SIGINT`/`SIGTERM` handlers that call `process.exit(0)` immediately, plus `uncaughtException`/`unhandledRejection` handlers; calls `start()` unconditionally at module load. Exports public interfaces/implementations/adapters. Note: ESM static imports are evaluated *before* the module body regardless of textual position, so diagnostics emitted by imported modules during their own evaluation are not guaranteed to be suppressed. The stdout invariant holds from `start()` onward: nothing writes to the protocol pipe while the server runs. |
| MCP server | `src/mcp/mcp-server.ts` | Exports `createMCPServer()` factory (builds `IDBManager` + `NLParser` + `MCPOrchestrator`) and a **module-level `MCPSimulatorServer` default export**. Registers the `process-instruction` tool on `CallToolRequestSchema` and advertises it to clients via `ListToolsRequestSchema`; all logging goes to `logs/mcp-server.log` via synchronous `logToFile()`. Its own `SIGINT`/`SIGTERM` handlers attempt an async `close()` before exiting; since `src/index.ts` exits immediately on the same signals, which handler runs first is not guaranteed — graceful shutdown on signals is best-effort, not guaranteed. |
| Orchestrator | `src/orchestrator/MCPOrchestrator.ts` | Coordinates parse → validate → normalize → convert → execute. Dispatches `SEQUENCE` commands (iterating child commands with `stopOnError` semantics) and `CONDITIONAL` commands (async predicate + branch) itself via `executeSequenceCommand`/`executeConditionalCommand`; delegates single commands to `OrchestratorToIDB`. Owns session state, `commandHistory`, and a `sessionCreated`/`sessionTerminated`/`commandExecuted`/`sessionActivated`/`sessionDeactivated` event bus (internal `emit`/listener registry, not Node `EventEmitter`). |
| Parser | `src/parser/NLParser.ts` | Wraps the `CommandRegistry`; implements `IParser` (`parseInstruction`, `validateInstruction`, `normalizeParameters`). |
| Command definitions | `src/parser/commands/*.ts` | Per-domain `BaseCommandDefinition` subclasses (Simulator, App, UI, Accessibility, Capture, Debug, Misc) with regex `patterns` (Spanish + English), parameter extractors, examples. |
| Adapter (parser→orchestrator) | `src/adapters/ParserToOrchestrator.ts` | Static Spanish/English phrase → `CommandType` mapping (exact match, then substring match); throws if no mapping exists. |
| Adapter (orchestrator→IDB) | `src/adapters/OrchestratorToIDB.ts` | `switch` over `CommandType` translating **single** commands to concrete `IDBManager` calls; session resolution falls back with `||` (`command.parameters.sessionId \|\| sessionId \|\| ''`); returns measured `CommandResult`s. |
| IDB gateway | `src/idb/IDBManager.ts` | Implements `IIDBManager`. Resolves session→UDID internally; shells out via `execFileAsync` only. |

Key interfaces live in:
- `src/idb/interfaces/IIDBManager.ts` — `IIDBManager`, `SimulatorInfo`, `AppInfo`, `SessionConfig`, `ButtonType`, `AccessibilityInfo`, `CrashLogInfo`.
- `src/parser/interfaces/IParser.ts` — `IParser`, `ParseResult`, `ValidationResult`.
- `src/orchestrator/interfaces/IOrchestratorCommand.ts` — `IOrchestratorCommand`, `CommandType`, `CommandResult`, `CommandContext`, `SequenceCommand`, `ConditionalCommand`, `CommandFactory`.

## Session state: manager map vs orchestrator `activeSessionId`

There are two distinct pieces of session state; do not conflate them:

- **`IDBManager.sessions: Map<sessionId, udid>`** — the source of truth for
  simulators. `createSimulatorSession(config?)` verifies idb availability via
  `idb list-targets`, picks a UDID (matching `config.deviceName`
  case-insensitively against simulator names — a UDID is accepted too for
  ambiguous names — with optionally required `platformVersion`, from
  `xcrun simctl list devices --json`; if no name is given, Boots simulators
  are preferred and the first available one otherwise), optionally boots it
  (`autoboot !== false`), and stores a generated `session_<timestamp>_<counter>` **as the map key**, with the UDID as its
  value. Every later manager method (`installApp`, `launchApp`, `tap`,
  `takeScreenshot`, …) looks the UDID up by `sessionId` key and throws
  `Session not found: ${sessionId}` if absent.
  By-UDID variants (`bootSimulatorByUDID`, `shutdownSimulatorByUDID`) bypass
  the map deliberately for UDID-addressed commands.
- **`MCPOrchestrator.activeSessionId: string | null`** — the orchestrator's
  *current working session*. After a successful `CREATE_SIMULATOR_SESSION`, the
  returned session id is stored and used as the default `sessionId` argument
  for subsequent commands and sequence/conditional contexts. A successful
  `TERMINATE_SIMULATOR_SESSION` resets it to `null`;
  `setActiveSessionId(sessionId: string | null)` re-points it (or clears it
  with `null`) **without verifying the session exists** in the manager's map.
  The orchestrator never validates this id against the manager's map itself —
  a stale `activeSessionId` surfaces as `Session not found` from `IDBManager`.

Both pieces reference the *same* session-id namespace (the ids produced by
`createSimulatorSession`); the difference is ownership and lifecycle: the
manager owns id→UDID resolution for the whole lifetime of its instances, while
the orchestrator's `activeSessionId` is merely a mutable "current session"
pointer.

## Parse → validate → normalize → result/error model

1. **Parse** (`CommandRegistry.parseInstruction`): each registered handler sees
   the trimmed, lowercased text in registration order (Simulator → App → UI →
   Accessibility → Capture → Debug → Misc); the first regex match wins.
   `BaseCommandDefinition.parseCommand` then applies each entry of the
   definition's `parameterExtractors` with the regex match and keeps every
   non-`undefined` result in `ParseResult.parameters` — extractors may read
   named regex groups, positional captures, or derive defaults. `confidence`
   is hardcoded `0.9`. No match in any handler →
   `Could not understand the instruction: <text>`.
2. **Validate** (`NLParser.validateInstruction`): looks the parsed command up
   in the registry definitions; rejects unknown commands, missing required
   parameters, and `undefined`/`null` parameter values. Produces
   `ValidationResult { isValid, errorMessage?, missingParameters?,
   invalidParameters? }`. **Caveat:** what validation sees is exactly what the
   extractors put into `ParseResult.parameters` — a required parameter absent
   from that object fails validation even if it might be recoverable from the
   original text, so parser coverage and validation are only as good as the
   extractors.
3. **Normalize** (`NLParser.normalizeParameters`): string values are coerced to
   `Number` when numeric and to `boolean` for `'true'`/`'false'` (case-insensitive).
4. **Execute**: single commands are translated and executed inside
   `OrchestratorToIDB.executeCommand`; `SEQUENCE` commands are iterated by
   `MCPOrchestrator.executeSequenceCommand` (child commands execute
   recursively, honoring `stopOnError`, reporting
   `completedCommands`/`totalCommands`), and `CONDITIONAL` commands are
   evaluated by `MCPOrchestrator.executeConditionalCommand` (async predicate
   against `CommandContext`, then branch). Every terminal failure — validation
   error, adapter mapping error, IDB command failure — is converted into a
   `CommandResult { success: false, error, timestamp }` rather than a thrown
   exception at the orchestrator boundary; actual errors are logged via
   `console.error` (stderr) there.

## Startup, logs, and import side effects

- `src/index.ts` overrides `console.log/info/warn/debug` **in its module body,
  with `console.error` redirected to stderr**. Because ESM evaluates static
  imports before the module body (regardless of textual order), diagnostics
  from imported modules during their own evaluation are not guaranteed to be
  suppressed — but from `start()` onward nothing writes to stdout, which is
  the stdio transport pipe.
- Both `src/index.ts` and `src/mcp/mcp-server.ts` synchronously `mkdirSync` the
  `logs/` directory at project root on import, and register process handlers.
  Signal handling overlaps: `src/mcp/mcp-server.ts` registers `SIGINT`/`SIGTERM`
  handlers that await `close()` before exiting, while `src/index.ts` registers
  handlers on the same signals that call `process.exit(0)` immediately — the
  order between them is not guaranteed, so graceful shutdown on signals is
  best-effort. `uncaughtException`/`unhandledRejection` handlers in
  `src/index.ts` report to stderr and exit non-zero.
- `logToFile` appends timestamped lines to `logs/mcp-server.log`
  synchronously (`fs.appendFileSync`); logging failures are swallowed.
- Consequence for library consumers: importing the package root
  (`dist/index.js`) starts the server and mutates process state; importing
  `dist/mcp/mcp-server.js` instantiates the MCP singleton (the module-level
  `new MCPSimulatorServer()`) with signal handlers and tool registration.
  To compose the orchestrator/parser/manager without transport bootstrap,
  import the compiled component modules directly — for example
  `mcp-server-simulator-ios-idb/dist/orchestrator/MCPOrchestrator.js`,
  `.../dist/parser/NLParser.js`, `.../dist/idb/IDBManager.js` — as shown in
  [README · Usage as a Library](README.md#-usage-as-a-library).

## Testing and external dependencies

- Jest + ts-jest, ESM (`NODE_OPTIONS=--experimental-vm-modules`), suites under
  `src/idb/__tests__/`, `src/orchestrator/__tests__/`,
  `src/parser/__tests__/`. Unit tests spy on `IDBManager`'s private
  `executeCommand` or inject mock collaborators — no real simulator calls.
- External binaries and installers, each with its own source:
  - **Xcode** provides `xcrun` and its `simctl` subcommand (device listing,
    boot, shutdown). Xcode with iOS simulators installed is a stated
    requirement.
  - **`idb` CLI** (facebook/idb — UI interaction, app install/launch/
    terminate, screenshots, logs) comes from the `idb-companion`
    Homebrew formula plus the `fb-idb` **Python** client installed with `pip`.
  - **Homebrew** is the installer channel for `idb-companion`
    (`brew tap facebook/fb && brew install idb-companion`), and a Python
    virtual environment receives `pip install --upgrade pip` followed by
    `pip install fb-idb`; both run via `scripts/install_dependencies.sh`
    during `npm install`/`npm ci` (macOS + Homebrew + active venv required).
  - `IDBManager` validates idb availability before simulator operations via
    `idb list-targets`.

## Adding a new command

A command must be wired through **all layers**; a command defined in only one
place is incomplete:

1. **Parser definition** — add an entry to the relevant
   `BaseCommandDefinition` subclass in `src/parser/commands/`:
   canonical `command` name, `patterns` (Spanish + English), parameter
   `extractors`, `examples`, required/optional parameter lists.
2. **Adapter mapping** — add the phrase → `CommandType` entries in
   `ParserToOrchestrator`'s `commandMappings`
   (`src/adapters/ParserToOrchestrator.ts`); add parameter conversion in
   `convertParameters` if shapes differ.
3. **`CommandType`** — add the enum member in
   `src/orchestrator/interfaces/IOrchestratorCommand.ts` if it doesn't exist.
4. **Execution switch** — handle the new `CommandType` in
   `OrchestratorToIDB.executeCommand` (`src/adapters/OrchestratorToIDB.ts`),
   mapping to manager parameters (`command.parameters.x || sessionId`); note
   that `SEQUENCE`/`CONDITIONAL` orchestration is owned by `MCPOrchestrator`,
   not this adapter.
5. **IDBManager** — implement (or reuse) the underlying operation in
   `src/idb/IDBManager.ts` + the `IIDBManager` interface, calling binaries via
   `executeCommand(<command>, <args[]>)` — argument array, never a shell string.
6. **Tests** — extend the matching suite under `src/**/__tests__/` (mocks only;
   driving a real simulator is an explicitly approved operation — see
   [AGENTS.md](AGENTS.md#testing)).
7. **README** — add the command to the corresponding table in the
   [Supported Commands](README.md#-supported-commands) section.
