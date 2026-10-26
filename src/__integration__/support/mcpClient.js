// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Drives the real MCP protocol: spawns dist/index.js and talks to it with the
 * official SDK Client over StdioClientTransport. This covers the full path
 * transport -> parser -> adapters -> IDBManager -> idb/simctl.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '../../../dist/index.js');

/**
 * Starts the server as a subprocess and returns a connected client.
 */
export async function startMcpServer() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe'
  });
  const client = new Client(
    { name: 'mcp-integration-tests', version: '1.0.0' },
    // idb operations (app launch, screenshot) can be slow on a cold boot;
    // keep protocol requests well above the SDK's 60 s default.
    { timeout: 180_000 }
  );
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
  });
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
