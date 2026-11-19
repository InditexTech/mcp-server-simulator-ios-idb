// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Drives the real MCP protocol: spawns dist/index.js and talks to it with the
 * official SDK Client over StdioClientTransport. This covers the full path
 * transport -> parser -> adapters -> IDBManager -> idb/simctl.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '../../../dist/index.js');

/** Last stderr bytes emitted by the MCP server child process (capped). */
export const STDERR_TAIL_LIMIT = 4_000;

/**
 * Bounded in-memory tail of the MCP server child stderr.
 *
 * Pure helper (exported for regression coverage): keeps only the last
 * STDERR_TAIL_LIMIT bytes so a chatty server cannot grow the harness
 * memory, while guaranteeing the END of the stream — where fatal boot
 * errors like MODULE_NOT_FOUND live — is always retained.
 */
export function createStderrCollector(limit = STDERR_TAIL_LIMIT) {
  let tail = '';
  return {
    push(/** @type {unknown} */ chunk) {
      tail = (tail + String(chunk)).slice(-limit);
    },
    get tail() {
      return tail;
    }
  };
}

/**
 * Per-call request timeout passed to the MCP SDK client.
 *
 * The SDK's default request timeout is 60 s (DEFAULT_REQUEST_TIMEOUT_MSEC in
 * shared/protocol) and the timeout is a PER-CALL RequestOptions field, not a
 * client-constructor option: an object passed to the Client constructor only
 * carries ProtocolOptions (enforceStrictCapabilities, capabilities, ...) and
 * any `timeout` there is silently ignored. This matters because cold simulator
 * boots under Xcode 27 runtimes have been observed issuing idb launch/install
 * calls far beyond 60 s (launch_ms=163439 and install_ms=159719 on the idb
 * companion device log), which made two integration tests fail with
 * `MCP error -32001: Request timed out` ~62 s into the request while the
 * companion itself eventually completed the operation successfully.
 */
export const MCP_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Starts the server as a subprocess and returns a connected client.
 *
 * The child's stderr is piped and its tail is kept in memory so an
 * unexpected server death is diagnosable from the Jest/CI output: without
 * this the runner only reports an opaque `MCP error -32000: Connection
 * closed` while the actual cause (e.g. MODULE_NOT_FOUND because `dist/` was
 * never built) sat on a stderr stream nobody consumed. The collector is
 * attached to transport.stderr BEFORE client.connect() because the SDK
 * exposes the PassThrough stderr stream at construction time, so even the
 * earliest boot failure output is captured.
 *
 * Cleanup semantics: the child 'close' event always fires transport.onclose,
 * including during intentional afterEach teardown. The guard therefore only
 * prints when the close/error arrives outside a transport.close() call
 * (see installStderrGuard / stopMcpServer).
 */
export async function startMcpServer() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe'
  });

  // Collect the child stderr tail. transport.stderr is a PassThrough that
  // exists immediately (SDK >= the pinned 1.32.2), so attaching now captures
  // pre-connect boot output that would otherwise be lost.
  const collector = createStderrCollector();
  transport.stderr?.on('data', (chunk) => collector.push(chunk));

  installStderrGuard(transport, () => collector.tail);

  // NOTE: the constructor only accepts ProtocolOptions; per-request timeout
  // must be set on each request (see MCP_REQUEST_TIMEOUT_MS above). idb
  // operations (app launch, install) can take minutes on a cold boot.
  const client = new Client({ name: 'mcp-integration-tests', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    // connect() can reject while the child never made it past boot; surface
    // the captured stderr so the -32000/-32001 style failure is explainable.
    transport.__closed = true;
    console.error(
      `[mcp-client] MCP server child stderr (captured during client.connect):\n` +
      formatStderrTail(collector.tail)
    );
    throw error;
  }
  return { client, transport, getStderrTail: () => collector.tail };
}

/**
 * Formats the captured child stderr tail with one prefixed line per entry so
 * Jest/CI logs show WHY the server died.
 */
function formatStderrTail(stderrTail) {
  const tail = (stderrTail || '').trim();
  return tail
    ? tail.split('\n').map((line) => `[mcp-child-stderr] ${line}`).join('\n')
    : '<empty>';
}

/**
 * Wraps the transport's close()/onclose/onerror so unexpected child death is
 * reported while intentional teardown stays silent.
 *
 * SDK semantics (verified against the pinned @modelcontextprotocol/sdk
 * 1.32.2): the child process 'close' event always invokes transport.onclose,
 * even after a graceful close(), and Protocol.connect() wraps whatever
 * onclose/onerror are set BEFORE connect, so installing here keeps the guard
 * in the chain after client.connect() re-arms the transport handlers.
 * Exported so the unit suite can verify the contract against synthetic
 * transports without spawning an MCP server.
 */
export function installStderrGuard(transport, getStderrTail) {
  // Graceful teardown marker: transport.close() is only called via
  // stopMcpServer / client.close() (which await transport.close()), or by
  // the SDK itself when initialization fails (startMcpServer's catch).
  const originalClose = transport.close.bind(transport);
  transport.close = async () => {
    transport.__closed = true;
    await originalClose();
  };
  const originalOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      // transport.__closed covers intentional close(); a 'close' child event
      // without it is an unexpected death (crash, MODULE_NOT_FOUND, OOM...).
      if (!transport.__closed) {
        console.error(
          '[mcp-client] MCP server child stderr (captured after unexpected server close):\n' +
          formatStderrTail(getStderrTail())
        );
      }
    } finally {
      originalOnClose?.();
    }
  };
  const originalOnError = transport.onerror;
  transport.onerror = (error) => {
    try {
      if (!transport.__closed) {
        console.error(
          `[mcp-client] MCP server child stderr (captured after transport error: ${error?.message ?? error}):\n` +
          formatStderrTail(getStderrTail())
        );
      }
    } finally {
      originalOnError?.(error);
    }
  };
}

/**
 * Calls the process-instruction tool with a natural-language instruction and
 * returns the parsed CommandResult JSON.
 * @param {Client} client Connected MCP client
 * @param {string} instruction Natural language instruction
 */
export async function processInstruction(client, instruction) {
  const response = await client.callTool({
    name: 'process-instruction',
    arguments: { instruction }
  }, undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
  const text = /** @type {any} */ (response.content?.find(c => c.type === 'text'))?.text || '';
  const structured = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  return { response, structured, text };
}

/**
 * Stops the server subprocess. The server exits on transport close via its
 * registered signal handlers; the fallback kills it after grace period.
 */
export async function stopMcpServer(transport, client) {
  try {
    if (client) {
      await client.close();
    }
  } catch {
    // client.close may throw if the transport is already broken; proceed to
    // transport close which terminates the child.
  }
  try {
    if (transport) {
      await transport.close();
    }
  } catch {
    // ignore
  }
}
