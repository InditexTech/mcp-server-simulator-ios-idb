// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Global setup for the opt-in integration suite.
 *
 * Creates exactly one disposable simulator owned by this run (unique name),
 * boots it, and records { udid, name, beforeInventory } into a state file that
 * test modules read. waitForSimulatorReadiness polls real state via simctl;
 * there are no blind sleeps.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listSimulators, pollUntil } from './simctl.js';
import { createOwnedSimulator, cleanupOwnedSimulator } from './simulatorHarness.js';
import { writeState, statePath } from './state.js';

export default async function globalSetup() {
  const runId = randomUUID().slice(0, 8);
  const stateDir = fs.mkdtempSync(path.join('/private/var/folders/7d/grtmgp2j6dg22_zkk0dt5clw0000gq/T/opencode', `mcp-it-${runId}-`));

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

    writeState({
      udid: ownedUdid,
      name: created.name,
      runtime: created.runtime,
      deviceType: created.deviceType,
      beforeInventory: beforeInventory.map(d => ({ udid: d.udid, state: d.state })),
      stateDir
    });
  } catch (error) {
    bootFailures.push(String(error));
    // Do not leak the device when readiness polling fails.
    await cleanupOwnedSimulator(ownedUdid);
    throw new Error(`Owned simulator ${ownedUdid} failed to reach Booted state: ${bootFailures.join('; ')}`);
  }
}

export { statePath };
