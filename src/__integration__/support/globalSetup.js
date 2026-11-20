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
import { listSimulators } from './simctl.js';
import { createOwnedSimulator, cleanupOwnedSimulator, cleanupOwnedCompanions, connectOwnedSimulator } from './simulatorHarness.js';
import { writeState, STATE_FILE_ENV } from './state.js';

function saveStartupReport(stages, ready) {
  const directory = process.env.IOS_SIM_ARTIFACTS_DIR;
  if (!directory) return;
  try {
    fs.mkdirSync(directory, { recursive: true });
    // Stages contain only fixed labels, timings and process/socket status.
    // Never publish the private command output or the companion log.
    fs.writeFileSync(path.join(directory, 'mcp-integration-startup.json'),
      JSON.stringify({ ready, stages }, null, 2), { mode: 0o600 });
  } catch {
    process.stderr.write('[integration] could not save startup diagnostics\n');
  }
}

export default async function globalSetup() {
  const runId = randomUUID().slice(0, 8);
  // node:fs.mkdtempSync enforces 0700 on the fresh directory by default
  // (the "mode" argument only ORs in, so it is not used here).
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-it-${runId}-`));
  // The canonical state file LIVES INSIDE this run's private directory and
  // is handed to test modules through the dedicated env var BEFORE any
  // state content is written — writes always land in the owned directory
  // that teardown will remove.
  const stateFile = path.join(stateDir, 'state.json');
  process.env[STATE_FILE_ENV] = stateFile;
  const bootFailures = [];
  const startupStages = [];
  let created;

  try {
    const beforeInventory = await listSimulators();

    try {
      created = await createOwnedSimulator(runId);
    } catch (error) {
      bootFailures.push(String(error));
      throw error;
    }

    const ownedUdid = created.udid;

    // A pre-connect cleanup is not a restart on a fresh VM. Never ignore a
    // failed cleanup, and do not spawn until boot services have completed.
    const cleanup = await cleanupOwnedCompanions(ownedUdid);
    if (cleanup.some(result => !result.gone)) {
      throw new Error('Owned companion cleanup failed before cold-start; refusing competing companions');
    }
    await connectOwnedSimulator(ownedUdid, stateDir, { diagnostics: startupStages });

    try {
      writeState({
        udid: ownedUdid,
        name: created.name,
        runtime: created.runtime,
        deviceType: created.deviceType,
        platform: created.platform,
        beforeInventory: beforeInventory.map(d => ({ udid: d.udid, state: d.state })),
        stateDir
      });
    } catch (stateError) {
      bootFailures.push(`state persistence failed: ${String(stateError)}`);
      throw stateError;
    }
    saveStartupReport(startupStages, true);
  } catch (error) {
    saveStartupReport(startupStages, false);
    // Do not leak the device when readiness polling, state persistence, or
    // any other step fails. Best effort for every cleanup facet; failures
    // are reported without masking the original error.
    const ownedUdid = typeof created?.udid === 'string' ? created.udid : null;
    if (ownedUdid) {
      const [simOutcome, companionOutcome] = await Promise.allSettled([
        cleanupOwnedSimulator(ownedUdid),
        cleanupOwnedCompanions(ownedUdid)
      ]);
      if (simOutcome.status === 'rejected') {
        bootFailures.push(`owned-simulator cleanup threw: ${String(simOutcome.reason)}`);
      }
      if (companionOutcome.status === 'rejected') {
        bootFailures.push(`owned-companion cleanup threw: ${String(companionOutcome.reason)}`);
      }
      const simResult = simOutcome.status === 'fulfilled' ? simOutcome.value : null;
      if (simResult && simResult.skipped !== true && simResult.deleted !== true) {
        bootFailures.push(`owned simulator ${ownedUdid} NOT confirmed deleted`);
      }
    }
    // Remove this run's private state directory AND its canonical state
    // file, and clear the env hand-off: nothing must survive a failed setup.
    try {
      if (fs.existsSync(process.env[STATE_FILE_ENV] || '')) {
        fs.rmSync(process.env[STATE_FILE_ENV], { force: true });
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (cleanupError) {
      bootFailures.push(`private state cleanup failed: ${String(cleanupError)}`);
    }
    delete process.env[STATE_FILE_ENV];
    const rootCause = error instanceof Error ? error : new Error(String(error));
    rootCause.bootFailures = bootFailures;
    throw rootCause;
  }
}
