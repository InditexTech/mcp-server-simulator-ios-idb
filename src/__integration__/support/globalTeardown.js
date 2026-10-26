// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Global teardown for the opt-in integration suite.
 *
 * Shuts down and deletes ONLY the simulator recorded in the run state
 * (exact UDID match, and only if its name still carries the suite's prefix).
 * Runs even when tests failed, and never touches any other device.
 */

import { readState } from './state.js';
import { cleanupOwnedSimulator } from './simulatorHarness.js';

export default async function globalTeardown() {
  let udid;
  try {
    ({ udid } = readState());
  } catch {
    // Setup failed before recording state; nothing owned to clean.
    return;
  }
  const result = await cleanupOwnedSimulator(udid);
  if (result && result.skipped !== true && !result.deleted) {
    // Make the leak visible in CI logs without crashing teardown.
    process.stderr.write(`WARNING: owned simulator ${udid} could not be deleted\n`);
  }
}
