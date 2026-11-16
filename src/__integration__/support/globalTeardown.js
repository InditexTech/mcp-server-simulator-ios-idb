// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Global teardown for the opt-in integration suite.
 *
 * Shuts down and deletes ONLY the simulator recorded in the run state
 * (exact UDID match, and only if its name still carries the suite's prefix).
 * Terminates the idb_companion process spawned for the owned UDID with an
 * exact argv match, then removes the solely owned companion socket path.
 * Runs even when tests failed, never touches any other device or process,
 * and reports leftover resources without masking the test outcome.
 */

import { readState, STATE_FILE_ENV } from './state.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupOwnedSimulator, cleanupOwnedCompanions } from './simulatorHarness.js';

/**
 * Writes a sanitized run summary into IOS_SIM_ARTIFACTS_DIR (or nothing, if
 * unset). Content is strictly owned-run metadata: UDID, device name, cleanup
 * outcome and pre-existing device inventory states. Never host crash data,
 * host logs, user files, or anything not produced by this run's own harness.
 */
function writeRunSummary(state, simResult, companionResults) {
  const artifactsDir = process.env.IOS_SIM_ARTIFACTS_DIR;
  if (!artifactsDir) return;
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const summary = {
      run: 'mcp-integration',
      udid: state.udid,
      deviceName: state.name,
      simCleanup: {
        shutdown: simResult?.shutdown ?? null,
        deleted: simResult?.deleted ?? null,
        skipped: simResult?.skipped ?? false,
        reason: simResult?.reason ?? null
      },
      companionCleanup: companionResults.map(result => ({
        pid: result.pid ?? null,
        path: result.path ?? null,
        gone: result.gone ?? false,
        reason: result.reason ?? null
      })),
      preExistingInventory: (state.beforeInventory || []).map(d => ({ udid: d.udid, state: d.state }))
    };
    fs.writeFileSync(path.join(artifactsDir, 'mcp-integration-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  } catch (error) {
    // Summary write must never break the teardown (a missing summary is not
    // a test failure; a leaked resource is reported separately).
    process.stderr.write(`WARNING: could not write run summary: ${String(error)}\n`);
  }
}

export default async function globalTeardown() {
  let udid;
  let state;
  try {
    state = readState();
    ({ udid } = state);
  } catch {
    // Setup failed before recording state; nothing owned to clean.
    return;
  }
  const simResult = await cleanupOwnedSimulator(udid);
  const companionResults = await cleanupOwnedCompanions(udid).catch(error => ([{ gone: false, reason: String(error) }]));

  writeRunSummary(state, simResult, companionResults);

  if (simResult && simResult.skipped !== true && !simResult.deleted) {
    // Make the leak visible in CI logs without crashing teardown.
    process.stderr.write(`WARNING: owned simulator ${udid} could not be deleted\n`);
  }
  for (const result of companionResults) {
    if (!result.gone) {
      process.stderr.write(`WARNING: owned companion resource not confirmed removed: ${result.reason || 'unknown'}\n`);
    }
  }
  delete process.env[STATE_FILE_ENV];
}
