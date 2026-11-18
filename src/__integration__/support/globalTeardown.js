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
 * unset). Content is strictly OWNED-RUN metadata: this run's UDID, device
 * name, and cleanup outcome — deliberately NOT the pre-existing device
 * inventory and no host paths, so nothing user-identifiable or
 * environment-revealing is published with failure artifacts.
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
        shutdown: simResult?.shutdown === true,
        deleted: simResult?.deleted === true,
        skipped: simResult?.skipped === true
      },
      // Privacy: only a safe enum category per companion facet, plus the
      // pid when present. Raw paths/reasons can embed host users/paths and
      // must not be published with failure artifacts.
      companionCleanup: companionResults.map(result => ({
        pid: typeof result.pid === 'number' ? result.pid : null,
        kind: result.path ? 'socket' : 'process',
        gone: result.gone === true
      }))
    };
    fs.writeFileSync(path.join(artifactsDir, 'mcp-integration-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  } catch (error) {
    // Summary write must never break the teardown (a missing summary is not
    // a test failure; a leaked resource is reported separately).
    process.stderr.write(`WARNING: could not write run summary: ${String(error)}\n`);
  }
}

/**
 * Global teardown. Independently runs EVERY cleanup facet (simulator,
 * companions, summary) via allSettled so one failure cannot skip the
 * others, and THROWS an aggregated error when owned resources could not be
 * removed — the run must not exit 0 with leaked resources.
 */
export default async function globalTeardown() {
  let state;
  let readStateFailed = false;
  try {
    state = readState();
  } catch {
    // Setup failed before recording state; nothing owned is known, and the
    // owned UDID is required for the fail-closed cleanup — no sweep is
    // performed.
    readStateFailed = true;
  }
  const errors = [];
  if (!readStateFailed && state?.udid) {
    const [simOutcome, companionOutcome] = await Promise.allSettled([
      cleanupOwnedSimulator(state.udid),
      cleanupOwnedCompanions(state.udid)
    ]);
    const simResult = simOutcome.status === 'fulfilled' ? simOutcome.value : null;
    if (simOutcome.status === 'rejected') {
      errors.push(`simulator cleanup failed: ${String(simOutcome.reason)}`);
    }
    let companionResults = [];
    if (companionOutcome.status === 'fulfilled') {
      companionResults = companionOutcome.value;
    } else {
      errors.push(`companion cleanup failed: ${String(companionOutcome.reason)}`);
    }
    writeRunSummary(state, simResult, companionResults);

    if (simResult && simResult.skipped !== true && simResult.deleted !== true) {
      errors.push(`owned simulator ${state.udid} could not be deleted`);
    }
    for (const result of companionResults) {
      if (!result.gone) {
        errors.push(`owned companion resource not confirmed removed: ${result.reason || 'unknown'}`);
      }
    }
    const stateDir = state.stateDir;
    if (stateDir && typeof stateDir === 'string' && path.basename(stateDir).startsWith('mcp-it-')) {
      // Remove ONLY this run's own private state directory (created by
      // globalSetup); never an arbitrary or shared path.
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(`private state dir removal failed: ${String(error)}`);
      }
    }
  }
  delete process.env[STATE_FILE_ENV];
  if (errors.length > 0) {
    // Fail visibly: a run must never exit 0 while owned resources leaked.
    throw new Error(`teardown incomplete: ${errors.join('; ')}`);
  }
}
