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
 */
export async function startMcpServer() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe'
  });
  // NOTE: the constructor only accepts ProtocolOptions; per-request timeout
  // must be set on each request (see MCP_REQUEST_TIMEOUT_MS above). idb
  // operations (app launch, install) can take minutes on a cold boot.
  const client = new Client({ name: 'mcp-integration-tests', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
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
