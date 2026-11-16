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
import { cleanupOwnedSimulator, cleanupOwnedCompanions } from './simulatorHarness.js';

export default async function globalTeardown() {
  let udid;
  try {
    ({ udid } = readState());
  } catch {
    // Setup failed before recording state; nothing owned to clean.
    return;
  }
  const simResult = await cleanupOwnedSimulator(udid);
  const companionResults = await cleanupOwnedCompanions(udid).catch(error => ([{ gone: false, reason: String(error) }]));

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
