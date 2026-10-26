// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Drives the built server (dist/index.js) over the real MCP stdio transport
// against the disposable simulator created by globalSetup. The tests run in
// order and share one session.

interface CommandResult {
  success: boolean;
  data?: any;
  error?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFARI = 'com.apple.mobilesafari';

const describeOnSimulator = process.env.IOS_SIM_INTEGRATION === '1' ? describe : describe.skip;

describeOnSimulator('MCP server against a real iOS Simulator', () => {
  const udid = process.env.IOS_SIM_INTEGRATION_UDID ?? '';
  const artifactsDir = process.env.IOS_SIM_ARTIFACTS_DIR
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-integration-'));
  let client: Client;

  async function run(instruction: string): Promise<CommandResult> {
    const response = await client.callTool({
      name: 'process-instruction',
      arguments: { instruction }
    });
    const [content] = response.content as Array<{ type: string; text?: string }>;
    if (response.isError) {
      throw new Error(`"${instruction}" returned a tool error: ${content?.text}`);
    }
    return JSON.parse(content?.text ?? '') as CommandResult;
  }

  async function runOk(instruction: string): Promise<CommandResult> {
    const result = await run(instruction);
    if (!result.success) {
      throw new Error(`"${instruction}" failed: ${result.error}`);
    }
    return result;
  }

  beforeAll(async () => {
    if (!udid) {
      throw new Error('IOS_SIM_INTEGRATION_UDID is not set; globalSetup did not create a simulator');
    }
    fs.mkdirSync(artifactsDir, { recursive: true });

    client = new Client({ name: 'integration-tests', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/index.js')],
      env: process.env as Record<string, string>,
      stderr: 'inherit'
    }));
  });

  afterAll(async () => {
    await client?.close();
  });

  it('advertises the process-instruction tool', async () => {
    const { tools } = await client.listTools();

    expect(tools.map(tool => tool.name)).toContain('process-instruction');
  });

  it('lists the disposable simulator as booted', async () => {
    const result = await runOk('list booted simulators');

    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ udid, state: 'Booted' })
    ]));
  });

  it('creates a session on the disposable simulator', async () => {
    const result = await runOk(`create session with ${udid}`);

    expect(typeof result.data).toBe('string');
  });

  it('takes a screenshot', async () => {
    const outputPath = path.join(artifactsDir, 'screenshot.png');

    const result = await runOk(`take screenshot to ${outputPath}`);

    expect(result.data).toBe(outputPath);
    expect(fs.readFileSync(outputPath).subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  });

  it('lists Safari among the installed apps', async () => {
    const result = await runOk('list apps');

    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ bundleId: SAFARI })
    ]));
  });

  it('launches and terminates Safari', async () => {
    const launched = await runOk(`launch app ${SAFARI}`);
    const terminated = await runOk(`terminate app ${SAFARI}`);

    expect(launched.data).toEqual({ bundleId: SAFARI });
    expect(terminated.data).toEqual({ bundleId: SAFARI });
  });

  it('opens a URL', async () => {
    const result = await runOk('open url https://example.com');

    expect(result.data).toEqual({ url: 'https://example.com' });
  });

  it('sets the location', async () => {
    const result = await runOk('set location 40.4168, -3.7038');

    expect(result.data).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });

  // A fresh simulator has no crash logs, so this checks the command runs but
  // not how idb's crash list output is parsed (needs a fixture app, see #76)
  it('lists crash logs', async () => {
    const result = await runOk('list crash logs');

    expect(Array.isArray(result.data)).toBe(true);
  });

  it('ends the session', async () => {
    await runOk('end session');
  });
});
