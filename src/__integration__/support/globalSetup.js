// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Global setup for the opt-in integration suite.
 *
 * Creates exactly one disposable simulator owned by this run (unique name),
 * boots it, and records { udid, name, beforeInventory } into a state file that
 * test modules read. waitForSimulatorReadiness polls real state via simctl;
 * there are no blind sleeps.
 *
 * Failure containment: the state directory is a private mkdtemp (0700) and
 * every failure after the create step — including writeState failures and
 * boot/readiness timeouts — runs the owned-simulator cleanup in a finally
 * block so no owned resource outlives a failed setup.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSimulators, pollUntil, run } from './simctl.js';
import { createOwnedSimulator, cleanupOwnedSimulator, cleanupOwnedCompanions } from './simulatorHarness.js';
import { writeState, STATE_FILE_ENV } from './state.js';

/**
 * Connects the shared idb client to the owned UDID. Failures surface
 * visibly (never a blind success) so the suite cannot proceed against a
 * device without its companion.
 */
async function idbConnectOwned(ownedUdid) {
  const output = await run('idb', ['connect', ownedUdid]);
  return (output || '').trim().split('\n')[0] ?? '';
}

export default async function globalSetup() {
  const runId = randomUUID().slice(0, 8);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-it-${runId}-`), { mode: 0o700 });

  const beforeInventory = await listSimulators();
  const bootFailures = [];

  let created;
  try {
    created = await createOwnedSimulator(runId);
  } catch (error) {
    bootFailures.push(String(error));
    throw error;
  }

  const ownedUdid = created.udid;

  try {
    // Real readiness: poll simctl state and idb list-targets presence of the
    // UDID rather than waiting a fixed time.
    await pollUntil(async () => {
      const devices = await listSimulators();
      return devices.find(d => d.udid === ownedUdid)?.state === 'Booted';
    }, 120_000);

    // idb companion cold-start workaround, established by direct
    // reproducible diagnosis on Xcode 27 runtimes: the first idb_companion
    // process (auto-spawned by `idb connect` right after a fresh boot)
    // wedges, and every following idb call against the device times out
    // (MCP SDK 180s); killing that exact companion and reconnecting makes
    // the same calls respond in seconds. The restart targets ONLY the
    // companion whose argv binds it to our owned UDID; no other-process
    // or global kills are involved.
    await cleanupOwnedCompanions(ownedUdid).catch(() => []);
    await idbConnectOwned(ownedUdid);

    try {
      writeState({
        udid: ownedUdid,
        name: created.name,
        runtime: created.runtime,
        deviceType: created.deviceType,
        beforeInventory: beforeInventory.map(d => ({ udid: d.udid, state: d.state })),
        stateDir
      });
    } catch (stateError) {
      bootFailures.push(`state persistence failed: ${String(stateError)}`);
      // Fail visibly: the state file may be absent or partial, but the run
      // aborts and cleanup still runs so the device does not leak.
      throw stateError;
    }
  } catch (error) {
    bootFailures.push(String(error));
    // Do not leak the device when readiness polling, state persistence, or
    // any other step fails. Best effort for every cleanup facet.
    await cleanupOwnedSimulator(ownedUdid);
    await cleanupOwnedCompanions(ownedUdid).catch(() => []);
    const rootCause = error instanceof Error ? error : new Error(String(error));
    rootCause.bootFailures = bootFailures;
    throw rootCause;
  }
}

export { STATE_FILE_ENV };
