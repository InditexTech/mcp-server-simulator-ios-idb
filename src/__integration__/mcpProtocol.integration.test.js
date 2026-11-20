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
import { resolveSimPlatform } from './support/simulatorHarness.js';
import { startMcpServer, stopMcpServer, processInstruction } from './support/mcpClient.js';
import { FIXTURE_BUNDLE_ID, buildFixtureApp } from './support/fixtureApp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

jest.setTimeout(420_000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function screenshotDigest(mcpClient, label) {
  const outPath = path.join(state.stateDir, `tvos-${label}-${Date.now()}.png`);
  const shot = await processInstruction(mcpClient, `take screenshot to ${outPath}`);
  expect(shot.structured.success).toBe(true);
  return createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
}

// Waits (bounded) for the screen to differ from `previous`, then lets the
// focus animation settle and returns the settled digest as the next baseline.
async function settledScreenChange(mcpClient, previous, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await screenshotDigest(mcpClient, label)) !== previous) {
      await sleep(1500);
      return screenshotDigest(mcpClient, `${label}-settled`);
    }
    await sleep(1000);
  }
  return previous;
}

const ACTIVE_PLATFORM = resolveSimPlatform();
const describeIosOnly = ACTIVE_PLATFORM === 'ios' ? describe : describe.skip;
const describeTvosOnly = ACTIVE_PLATFORM === 'tvos' ? describe : describe.skip;

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

async function expectOwnedOnlyInInventory() {
  const devices = await listSimulators();
  const before = new Map(state.beforeInventory.map(d => [d.udid, d.state]));
  for (const device of devices) {
    const beforeState = before.get(device.udid);
    if (device.udid !== ownedUdid() && beforeState === 'Shutdown') {
      expect(device.state).toBe('Shutdown');
    }
  }
}

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
    await expectOwnedOnlyInInventory();
  });

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

describeIosOnly('built-in app behavior', () => {
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

  // Network-independent open-url: the fixture registers the mcpfixture://
  // scheme in CFBundleURLTypes and renders whatever it receives via
  // onOpenURL, so the test observes the real routing effect (fixture label)
  // instead of trusting the response echo. No external network involved.
  it('opens a fixture-registered URL and the app renders it on screen', async () => {
    ({ client, transport } = await startMcpServer());
    // Install and launch the fixture first: the custom scheme only routes
    // to the app that registered it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
    const appPath = await buildFixtureApp(tmp);
    await processInstruction(client, `create session with ${state.name}`);
    const installed = await processInstruction(client, `install app ${appPath}`);
    expect(installed.structured.success).toBe(true);
    const launched = await processInstruction(client, `launch app ${FIXTURE_BUNDLE_ID}`);
    expect(launched.structured.success).toBe(true);

    // Bounded readiness: poll the onOpenURL marker via a real accessibility
    // read; no fixed long sleep, no network dependency. The 180 s window
    // is sized for loaded hosts: a single `idb ui describe-all` call is
    // allowed up to 120 s per attempt, so a 60 s window could be consumed
    // by one slow attempt (observed on a 2.6-3.2x degraded host in PR #78
    // validation) before any repeat. Still bounded well within the 420 s
    // per-test budget.
    let lastObserved = null;
    const deadline = Date.now() + 180_000;
    let sawLaunchedAppMarker = false;
    while (Date.now() < deadline && !sawLaunchedAppMarker) {
      const elements = JSON.parse(await describeOwnedElements());
      // Bookkeeping for honest diagnostics: record the last observation so
      // a failure reports what the accessibility view actually contained
      // instead of an invariant null.
      lastObserved = {
        elements: Array.isArray(elements) ? elements.length : 'non-array',
        fixtureEchoLabelPresent: Array.isArray(elements) && elements.some(
          el => el.AXUniqueId === 'fixtureEchoLabel'
        )
      };
      sawLaunchedAppMarker = lastObserved.fixtureEchoLabelPresent === true;
      if (!sawLaunchedAppMarker) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    if (!sawLaunchedAppMarker) {
      // Honest failure: ready-state couldn't be established; report the last
      // observation (or its absence), never a canned pass.
      throw new Error(`fixture readiness failed: fixtureEchoLabel never observed (last: ${JSON.stringify(lastObserved)})`);
    }

    const requestedUrl = 'mcpfixture://open/round-validation';
    const opened = await processInstruction(client, `open url ${requestedUrl}`);
    expect(opened.structured.success).toBe(true);

    // Real side effect: the fixture's onOpenURL reproduces the URL it got.
    // On the first open of a custom scheme on a fresh device, iOS shows a
    // system confirmation dialog ("open in <app>?"); the bounded poll taps
    // its confirm button (frame from the same accessibility view) so the
    // flow is deterministic without weakening the observation. The button
    // label is locale-dependent ("Abrir" on Spanish-locale simulators,
    // "Open" on English-locale ones such as fresh CI VMs), so both system
    // localizations are matched. The echo poll gets its own full window:
    // reusing the readiness deadline would leave it whatever budget was
    // left after the launch wait (the deterministic null-echo failure seen
    // on CI).
    let observed = null;
    const echoDeadline = Date.now() + 180_000;
    while (Date.now() < echoDeadline && observed !== requestedUrl) {
      const elements = JSON.parse(await describeOwnedElements());
      const confirm = Array.isArray(elements)
        ? elements.find(el => el.type === 'Button' && ['Abrir', 'Open'].includes(el.AXLabel))
        : null;
      if (confirm) {
        const frame = confirm.frame || {};
        const x = Math.round((frame.x ?? 0) + (frame.width ?? 0) / 2);
        const y = Math.round((frame.y ?? 0) + (frame.height ?? 0) / 2);
        await new Promise((resolve, reject) => {
          import('node:child_process').then(({ execFile }) => {
            execFile('idb', ['ui', 'tap', '--udid', state.udid, String(x), String(y)], { timeout: 60_000 }, error => (error ? reject(error) : resolve()));
          });
        });
        await new Promise(resolve => setTimeout(resolve, 4000));
        continue;
      }
      const label = Array.isArray(elements)
        ? elements.find(el => el.AXUniqueId === 'fixtureOpenUrlLabel')
        : null;
      if (label && typeof label.AXLabel === 'string') observed = label.AXLabel;
      if (observed !== requestedUrl) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    expect(observed).toBe(requestedUrl);
  });

  // Scenario shape from PR #77 (Rodrigo Bustamante), adapted to this
  // suite's harness and response assert style.
  it('sets the location and reports the requested coordinates back', async () => {
    ({ client, transport } = await startMcpServer());
    await processInstruction(client, `create session with ${state.name}`);
    const set = await processInstruction(client, 'set location 40.4168, -3.7038');
    expect(set.structured.success).toBe(true);
    // Smoke assertion only: this proves the adapter reports the requested
    // coordinates; it does not independently verify GPS effects.
    expect(set.structured.data).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });
});

describe('unrecognized instructions fail honestly through MCP', () => {
  it('rejects an unparseable instruction without executing simulator actions', async () => {
    ({ client, transport } = await startMcpServer());
    const { structured } = await processInstruction(client, 'fly me to the moon');
    expect(structured.success).toBe(false);
    expect(structured.error).toMatch(/Could not understand the instruction/i);
  });
});

describe('accessibility describe, platform UI controls, video, and debug server', () => {
  if (ACTIVE_PLATFORM === 'ios') {
    it('verifies unfocused no-op and focused exact preservation of leading zeros, case, and consecutive spaces', async () => {
      ({ client, transport } = await startMcpServer());
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
      const appPath = await buildFixtureApp(tmp, { platform: 'ios' });

      await processInstruction(client, `create session with ${state.name}`);
      const installed = await processInstruction(client, `install app ${appPath}`);
      expect(installed.structured.success).toBe(true);
      const launched = await processInstruction(client, `launch app ${FIXTURE_BUNDLE_ID}`);
      expect(launched.structured.success).toBe(true);

      // Poll MCP `describe all elements` until both fixtureEchoLabel and fixtureTextField are visible.
      const readinessDeadline = Date.now() + 180_000;
      let textField = null;
      let echoLabel = null;
      while (Date.now() < readinessDeadline && (!textField || !echoLabel)) {
        const described = await processInstruction(client, 'describe all elements');
        if (described.structured?.success && Array.isArray(described.structured.data)) {
          const flat = flattenElements(described.structured.data);
          textField = flat.find(el => el.identifier === 'fixtureTextField') || null;
          echoLabel = flat.find(el => el.identifier === 'fixtureEchoLabel') || null;
        }
        if (!textField || !echoLabel) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      expect(defined(textField)).toBe(true);
      expect(defined(echoLabel)).toBe(true);
      expect(echoLabel.label).toBe('Value: ');

      const centerX = Math.round(textField.frame.x + textField.frame.width / 2);
      const centerY = Math.round(textField.frame.y + textField.frame.height / 2);

      // Verify `describe point` through MCP at the text field's coordinates.
      const pointDescribed = await processInstruction(client, `describe point ${centerX}, ${centerY}`);
      expect(pointDescribed.structured.success).toBe(true);
      expect(defined(pointDescribed.structured.data)).toBe(true);
      expect(typeof pointDescribed.structured.data.frame?.width).toBe('number');

      // 1. Typing BEFORE focusing the text field returns success: true (HID events sent)
      // while leaving the unfocused field unchanged.
      const unfocusedTyped = await processInstruction(client, 'input text unfocused999');
      expect(unfocusedTyped.structured.success).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const afterUnfocused = await processInstruction(client, 'describe all elements');
      expect(afterUnfocused.structured.success).toBe(true);
      const unfocusedEcho = flattenElements(afterUnfocused.structured.data)
        .find(el => el.identifier === 'fixtureEchoLabel');
      expect(unfocusedEcho?.label).toBe('Value: ');

      // 2. Focus the text field via MCP `tap`, wait for the software keyboard / responder,
      // and verify exact preservation of leading zeros ("0123"), mixed case ("AbC"), and
      // consecutive spaces ("[   ]"), plus iOS's documented system double-space "."
      // shortcut after word characters ("left   space" -> "left.  space") even when
      // UITextField disables autocorrection and smart punctuation.
      const tapped = await processInstruction(client, `tap at ${centerX}, ${centerY}`);
      expect(tapped.structured.success).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const targetSample = '0123 AbC left   space';
      const expectedUiValue = 'Value: 0123 AbC left.  space';
      const focusedTyped = await processInstruction(client, `input text ${targetSample}`);
      expect(focusedTyped.structured.success).toBe(true);

      const echoDeadline = Date.now() + 60_000;
      let observedLabel = null;
      while (Date.now() < echoDeadline && observedLabel !== expectedUiValue) {
        const described = await processInstruction(client, 'describe all elements');
        if (described.structured?.success && Array.isArray(described.structured.data)) {
          const currentEcho = flattenElements(described.structured.data)
            .find(el => el.identifier === 'fixtureEchoLabel');
          observedLabel = currentEcho?.label ?? null;
        }
        if (observedLabel !== expectedUiValue) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      expect(observedLabel).toBe(expectedUiValue);

      await processInstruction(client, `terminate app ${FIXTURE_BUNDLE_ID}`);
    });
  }

  it('records an MP4 video file and manages debug server start/status/stop', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
    const appPath = await buildFixtureApp(tmp, { platform: ACTIVE_PLATFORM });
    const videoPath = path.join(state.stateDir, `recording-${Date.now()}.mp4`);

    await processInstruction(client, `create session with ${state.name}`);
    const installed = await processInstruction(client, `install app ${appPath}`);
    expect(installed.structured.success).toBe(true);

    // Video recording start -> brief frame window -> stop -> valid MP4 container ('ftyp').
    const startedVideo = await processInstruction(client, `record video ${videoPath}`);
    expect(startedVideo.structured.success).toBe(true);
    expect(typeof startedVideo.structured.data).toBe('string');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const stoppedVideo = await processInstruction(client, 'stop recording');
    expect(stoppedVideo.structured.success).toBe(true);
    expect(fs.existsSync(videoPath)).toBe(true);
    const videoBytes = fs.readFileSync(videoPath);
    expect(videoBytes.byteLength).toBeGreaterThan(32);
    expect(videoBytes.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // Debug server start -> status running -> stop -> status not running.
    const startedDebug = await processInstruction(client, `start debug ${FIXTURE_BUNDLE_ID}`);
    expect(startedDebug.structured.success).toBe(true);
    expect(typeof startedDebug.structured.data?.port).toBe('number');
    expect(startedDebug.structured.data.port).toBeGreaterThan(0);

    const activeStatus = await processInstruction(client, 'debug status');
    expect(activeStatus.structured.success).toBe(true);
    expect(activeStatus.structured.data?.running).toBe(true);

    const stoppedDebug = await processInstruction(client, 'stop debug');
    expect(stoppedDebug.structured.success).toBe(true);

    const stoppedStatus = await processInstruction(client, 'debug status');
    expect(stoppedStatus.structured.success).toBe(true);
    expect(stoppedStatus.structured.data?.running).toBe(false);
  });
});

describeTvosOnly('tvOS Siri Remote navigation, hardware buttons, and touch/posture guardrails', () => {
  // The always-on tvOS journey proves behavior from the pixels a user would see:
  // accessibility reads on an Apple TV need an idb build that routes to its TV
  // output (upstream facebook/idb 81d0f6416, after v1.7.8), so they are covered
  // by the opt-in scenario below instead of gating the whole tvOS pass.
  it('moves focus and activates controls with the Siri Remote, accepts media buttons, and rejects touch/posture commands', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-tvos-fixture-'));
    const appPath = await buildFixtureApp(tmp, { platform: 'tvos' });

    await processInstruction(client, `create session with ${state.name}`);
    const installed = await processInstruction(client, `install app ${appPath}`);
    expect(installed.structured.success).toBe(true);
    const launched = await processInstruction(client, `launch app ${FIXTURE_BUNDLE_ID}`);
    expect(launched.structured.success).toBe(true);
    await sleep(4000);
    const baseline = await screenshotDigest(client, 'initial');

    // Touch and mobile-posture commands fail honestly with actionable guidance.
    for (const instruction of ['tap at 100, 200', 'swipe from 100, 100 to 300, 300', 'set orientation to landscape left']) {
      const rejected = await processInstruction(client, instruction);
      expect(rejected.structured.success).toBe(false);
      expect(rejected.structured.error).toMatch(/not supported on tvOS simulators/i);
    }

    // Focus moves from Primary Action to Secondary Action.
    const movedDown = await processInstruction(client, 'press remote down');
    expect(movedDown.structured.success).toBe(true);
    const afterDown = await settledScreenChange(client, baseline, 'after-down');
    expect(afterDown).not.toBe(baseline);

    // Selecting the focused control updates the fixture's status label.
    const selected = await processInstruction(client, 'press remote select');
    expect(selected.structured.success).toBe(true);
    const afterSelect = await settledScreenChange(client, afterDown, 'after-select');
    expect(afterSelect).not.toBe(afterDown);

    // Spanish phrasing moves focus back up.
    const movedUp = await processInstruction(client, 'pulsar mando arriba');
    expect(movedUp.structured.success).toBe(true);
    const afterUp = await settledScreenChange(client, afterSelect, 'after-up');
    expect(afterUp).not.toBe(afterSelect);

    const playPause = await processInstruction(client, 'press device button PLAY_PAUSE');
    expect(playPause.structured.success).toBe(true);
    const menu = await processInstruction(client, 'press remote menu');
    expect(menu.structured.success).toBe(true);

    await processInstruction(client, `terminate app ${FIXTURE_BUNDLE_ID}`);
  });
});

// Opt-in: requires an idb build that routes accessibility to an Apple TV's TV
// output. idb 1.7.8 fails these reads with "no active integrated display".
const itTvosAccessibility = process.env.SIM_TVOS_ACCESSIBILITY === '1' ? it : it.skip;
describeTvosOnly('tvOS accessibility focus state and element tap (needs idb with tvOS display routing)', () => {
  itTvosAccessibility('reports focused state, follows Siri Remote focus, and activates elements by label', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-tvos-fixture-'));
    const appPath = await buildFixtureApp(tmp, { platform: 'tvos' });
    await processInstruction(client, `create session with ${state.name}`);
    expect((await processInstruction(client, `install app ${appPath}`)).structured.success).toBe(true);
    expect((await processInstruction(client, `launch app ${FIXTURE_BUNDLE_ID}`)).structured.success).toBe(true);

    const find = async predicate => {
      const described = await processInstruction(client, 'describe all elements');
      return described.structured?.success ? flattenElements(described.structured.data).find(predicate) ?? null : null;
    };
    const waitFor = async (predicate, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      let found = null;
      while (Date.now() < deadline && !found) {
        found = await find(predicate);
        if (!found) await sleep(1500);
      }
      return found;
    };

    const primary = await waitFor(el => el.identifier === 'fixturePrimaryButton');
    expect(defined(primary)).toBe(true);
    expect(primary.focused).toBe(true);

    expect((await processInstruction(client, 'press remote down')).structured.success).toBe(true);
    expect(defined(await waitFor(el => el.identifier === 'fixtureSecondaryButton' && el.focused === true))).toBe(true);

    expect((await processInstruction(client, 'tap element "Primary Action"')).structured.success).toBe(true);
    expect(defined(await waitFor(el => el.identifier === 'fixtureStatusLabel' && el.label === 'Status: primary'))).toBe(true);

    expect((await processInstruction(client, 'tap element with id "fixtureSecondaryButton"')).structured.success).toBe(true);
    expect(defined(await waitFor(el => el.identifier === 'fixtureStatusLabel' && el.label === 'Status: secondary'))).toBe(true);

    await processInstruction(client, `terminate app ${FIXTURE_BUNDLE_ID}`);
  });
});

describeIosOnly('element-targeted tap on iOS', () => {
  it('focuses the fixture text field by accessibility id (no coordinates) and types into it', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
    const appPath = await buildFixtureApp(tmp, { platform: 'ios' });
    await processInstruction(client, `create session with ${state.name}`);
    expect((await processInstruction(client, `install app ${appPath}`)).structured.success).toBe(true);
    expect((await processInstruction(client, `launch app ${FIXTURE_BUNDLE_ID}`)).structured.success).toBe(true);

    const readyDeadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < readyDeadline && !ready) {
      const described = await processInstruction(client, 'describe all elements');
      ready = Boolean(described.structured?.success &&
        flattenElements(described.structured.data).some(el => el.identifier === 'fixtureTextField'));
      if (!ready) await sleep(2000);
    }
    expect(ready).toBe(true);

    const tapped = await processInstruction(client, 'tap element with id "fixtureTextField"');
    expect(tapped.structured.success).toBe(true);
    expect(tapped.structured.data).toEqual({ marker: 'fixtureTextField', matchKey: 'AXUniqueId' });
    await sleep(2000);

    expect((await processInstruction(client, 'input text abc')).structured.success).toBe(true);
    const echoDeadline = Date.now() + 60_000;
    let echo = null;
    while (Date.now() < echoDeadline && echo !== 'Value: abc') {
      const described = await processInstruction(client, 'describe all elements');
      if (described.structured?.success) {
        echo = flattenElements(described.structured.data).find(el => el.identifier === 'fixtureEchoLabel')?.label ?? null;
      }
      if (echo !== 'Value: abc') await sleep(1500);
    }
    expect(echo).toBe('Value: abc');

    await processInstruction(client, `terminate app ${FIXTURE_BUNDLE_ID}`);
  });
});

describe('fixture app install/uninstall and verification commands', () => {
  it('installs the fixture, reports its real bundle id, and answers natural-language verification checks', async () => {
    ({ client, transport } = await startMcpServer());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-fixture-'));
    const appPath = await buildFixtureApp(tmp, { platform: ACTIVE_PLATFORM });

    await processInstruction(client, `create session with ${state.name}`);

    const simBooted = await processInstruction(client, 'is simulator booted');
    expect(simBooted.structured.success).toBe(true);
    expect(simBooted.structured.data).toBe(true);

    // Ensure clean pre-install baseline if an earlier spec left the fixture installed.
    await processInstruction(client, `uninstall app ${FIXTURE_BUNDLE_ID}`);
    const beforeInstallCheck = await processInstruction(client, `is app ${FIXTURE_BUNDLE_ID} installed`);
    expect(beforeInstallCheck.structured.success).toBe(true);
    expect(beforeInstallCheck.structured.data).toBe(false);

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

    // Natural-language verification commands (English and Spanish, #92 / PR #93).
    const afterInstallEn = await processInstruction(client, `is app ${FIXTURE_BUNDLE_ID} installed`);
    expect(afterInstallEn.structured.success).toBe(true);
    expect(afterInstallEn.structured.data).toBe(true);

    const afterInstallEs = await processInstruction(client, `verificar app ${FIXTURE_BUNDLE_ID}`);
    expect(afterInstallEs.structured.success).toBe(true);
    expect(afterInstallEs.structured.data).toBe(true);

    const uninstalled = await processInstruction(client, `uninstall app ${FIXTURE_BUNDLE_ID}`);
    expect(uninstalled.structured.success).toBe(true);

    const afterUninstallCheck = await processInstruction(client, `is app ${FIXTURE_BUNDLE_ID} installed`);
    expect(afterUninstallCheck.structured.success).toBe(true);
    expect(afterUninstallCheck.structured.data).toBe(false);
  });
});

function flattenElements(elements) {
  const out = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    out.push(el);
    if (Array.isArray(el.children) && el.children.length > 0) {
      out.push(...flattenElements(el.children));
    }
  }
  return out;
}

function defined(x) {
  return x !== undefined && x !== null;
}

/**
 * Reads real UI accessibility elements from the owned disposable device.
 * Used to verify observable side effects of open-url instructions without
 * trusting the server response alone. Retries transient idb accessibility
 * failures (e.g. "no frontmost application" right after launch) inside the
 * caller's bounded polling — never unbounded.
 */
async function describeOwnedElements() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('idb', [
      'ui', 'describe-all', '--udid', state.udid, '--json'
    ], { timeout: 120_000 });
    return stdout;
  } catch (error) {
    // Transient accessibility-service unavailability: surface as an empty
    // element list so the caller's bounded poll can retry later.
    return '[]';
  }
}
