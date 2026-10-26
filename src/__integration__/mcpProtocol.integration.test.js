// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in integration scenarios through the real MCP protocol.
 *
 * Every test in this file drives dist/index.js over stdio with the MCP SDK
 * Client and operates ONLY on the disposable simulator recorded by
 * globalSetup (exact UDID match enforced in assertions).
 */

import { jest } from '@jest/globals';
import { readState } from './support/state.js';
import { listSimulators } from './support/simctl.js';
import { startMcpServer, stopMcpServer, processInstruction } from './support/mcpClient.js';
import { FIXTURE_BUNDLE_ID, buildFixtureApp } from './support/fixtureApp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

jest.setTimeout(240_000);

let state;
let client;
let transport;

const ownedUdid = () => {
  if (!state) {
    throw new Error('Integration state missing; globalSetup did not run');
  }
  return state.udid;
};

async function completeIfApplicable() {
  if (client && !transport.__closed) {
    await stopMcpServer(transport, client);
  }
}

beforeAll(async () => {
  state = readState();
});

afterEach(async () => {
  await completeIfApplicable();
});

function expectOwnedOnly() {
  // Guard: the owned device must be the only simulator this run has BOOTED.
  // Pre-existing inventory recorded in state must stay Shutdown.
  return async () => {
    const devices = await listSimulators();
    const before = new Map(state.beforeInventory.map(d => [d.udid, d.state]));
    for (const device of devices) {
      const beforeState = before.get(device.udid);
      if (device.udid !== ownedUdid() && beforeState === 'Shutdown') {
        expect(device.state).toBe('Shutdown');
      }
    }
  };
}

describe('inventory and ownership invariants', () => {
  it('lists simulators through MCP and includes the owned one', async () => {
    ({ client, transport } = await startMcpServer());
    const { structured } = await processInstruction(client, 'list simulators');
    expect(structured.success).toBe(true);
    const sims = structured.data;
    const owned = sims.find(s => s.udid === ownedUdid());
    expect(defined(owned)).toBe(true);
    expect(owned.name).toBe(state.name);
    expect(owned.state).toBe('Booted');
    await expectOwnedOnlyBeforeReturn();
  });

  async function expectOwnedOnlyBeforeReturn() {
    const devices = await listSimulators();
    const before = new Map(state.beforeInventory.map(d => [d.udid, d.state]));
    for (const device of devices) {
      const beforeState = before.get(device.udid);
      if (device.udid !== ownedUdid() && beforeState === 'Shutdown') {
        expect(device.state).toBe('Shutdown');
      }
    }
  }

  it('lists booted simulators exactly as the owned device', async () => {
    ({ client, transport } = await startMcpServer());
    const { structured } = await processInstruction(client, 'list booted simulators');
    expect(structured.success).toBe(true);
    const booted = structured.data;
    expect(Array.isArray(booted)).toBe(true);
    for (const sim of booted) {
      expect(sim.udid).toBe(ownedUdid());
    }
  });
});

describe('session lifecycle on the owned simulator', () => {
  it('creates a session bound to the owned UDID and ends it', async () => {
    ({ client, transport } = await startMcpServer());
    const created = await processInstruction(client, `create session with ${state.name}`);
    expect(created.structured.success).toBe(true);
    const sessionId = created.structured.data;
    expect(typeof sessionId).toBe('string');

    // The session must resolve to OUR udid: end session succeeding proves
    // session->udid resolution without printing third-party devices.
    const ended = await processInstruction(client, 'end session');
    expect(ended.structured.success).toBe(true);
  });
});

describe('screenshot has a real PNG signature', () => {
  it('captures a screenshot whose bytes are a genuine PNG', async () => {
    ({ client, transport } = await startMcpServer());
    const session = await processInstruction(client, `create session with ${state.name}`);
    expect(session.structured.success).toBe(true);
    const outPath = path.join(state.stateDir, `screenshot-${Date.now()}.png`);
    const { structured, text } = await processInstruction(client, `take screenshot to ${outPath}`);
    if (!structured.success) {
      // Surface the server-side error verbatim; do not mask a backend defect.
      throw new Error(`Screenshot instruction failed: ${text}`);
    }
    expect(fs.existsSync(outPath)).toBe(true);
    const header = fs.readFileSync(outPath).subarray(0, 8);
    expect([...header]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  });
});

describe('built-in app behavior', () => {
  it('launches, lists, and terminates Safari', async () => {
    ({ client, transport } = await startMcpServer());
    await processInstruction(client, `create session with ${state.name}`);

    const launched = await processInstruction(client, 'launch app com.apple.mobilesafari');
    expect(launched.structured.success).toBe(true);

    const listed = await processInstruction(client, 'list apps');
    expect(listed.structured.success).toBe(true);
    const bundleIds = listed.structured.data.map(app => app.bundleId);
    expect(bundleIds).toContain('com.apple.mobilesafari');

    const terminated = await processInstruction(client, 'terminate app com.apple.mobilesafari');
    expect(terminated.structured.success).toBe(true);
  });

  it('opens a deep-link URL without error', async () => {
    ({ client, transport } = await startMcpServer());
    await processInstruction(client, `create session with ${state.name}`);
    const opened = await processInstruction(client, 'open url https://example.com/mcp-integration');
    expect(opened.structured.success).toBe(true);
  });
});

describe('unsupported commands must fail honestly through MCP', () => {
  it.each([
    ['record video /tmp/mcp-it-video.mp4', 'startVideoRecording'],
    ['stop recording', 'stopVideoRecording'],
    ['describe all elements', 'describeAllElements'],
    ['start debug com.example.app', 'startDebugServer']
  ])('"%s" reports the unsupported manager method', async (instruction, method) => {
    ({ client, transport } = await startMcpServer());
    const { structured } = await processInstruction(client, instruction);
    expect(structured.success).toBe(false);
    expect(structured.error).toBe(`Command not supported by the IDB manager: ${method}`);
  });
});

describe('fixture app install/uninstall with the real bundle ID', () => {
  it('installs the fixture and reports ITS REAL bundle id, not a synthesized one', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
    const appPath = await buildFixtureApp(tmp);

    await processInstruction(client, `create session with ${state.name}`);
    const installed = await processInstruction(client, `install app ${appPath}`);
    expect(installed.structured.success).toBe(true);

    const listed = await processInstruction(client, 'list apps');
    expect(listed.structured.success).toBe(true);
    const fixture = listed.structured.data.find(app => app.bundleId === FIXTURE_BUNDLE_ID);
    // issue #76 concern: installApp reported bundle IDs are synthesized as
    // com.example.<name> today. The REAL installed bundle must be asserted;
    // if the synthesized value leaks into any user-visible response, this is
    // a demonstrated defect, not a tolerated mismatch.
    expect(defined(fixture)).toBe(true);

    // The documented synthesized bundle id must NOT correspond to a real app.
    const synthesized = listed.structured.data.find(app => app.bundleId === 'com.example.FixtureApp');
    expect(defined(synthesized)).toBe(false);

    // 'verify app' has no parser pattern (README documents "is app … installed",
    // a known PR #71 follow-up gap): assert real presence through list apps
    // instead of an unparseable instruction.
    const afterInstallList = await processInstruction(client, 'list apps');
    expect(afterInstallList.structured.success).toBe(true);
    expect(afterInstallList.structured.data.some(app => app.bundleId === FIXTURE_BUNDLE_ID)).toBe(true);

    const uninstalled = await processInstruction(client, `uninstall app ${FIXTURE_BUNDLE_ID}`);
    expect(uninstalled.structured.success).toBe(true);

    const afterUninstallList = await processInstruction(client, 'list apps');
    expect(afterUninstallList.structured.success).toBe(true);
    expect(afterUninstallList.structured.data.some(app => app.bundleId === FIXTURE_BUNDLE_ID)).toBe(false);
  });
});

function defined(x) {
  return x !== undefined && x !== null;
}
