// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Owns the single disposable simulator used by the integration suite.
 *
 * Safety contract:
 * - Only ONE simulator is created, with a unique name prefix owned by the
 *   suite. No pre-existing simulator is booted, shutdown, or deleted.
 * - Every mutation is keyed by the exact UDID recorded at creation; helper
 *   functions refuse to act on any other UDID.
 * - Cleanup is best-effort and runs even when setup or tests fail.
 */

import { listSimulators, run, tryRun, pollUntil } from './simctl.js';

const OWNED_NAME_PREFIX = 'mcp-integration-';

/** @returns {boolean} True when the UDID belongs to the simulator this suite created. */
export function isOwned(name, udid, ownedUdid) {
  return Boolean(ownedUdid) && udid === ownedUdid && name.startsWith(OWNED_NAME_PREFIX);
}

/**
 * Picks an available (non-create-required) deviceType/runtime pair. Trusts
 * xcrun's availability flags and each runtime's supportedDeviceTypes instead
 * of hardcoding a device that changes with Xcode releases. When simulated
 * creation is incompatible (some shipping device types reject specific
 * runtimes), it keeps trying candidate pairs from the supported lists.
 */
export async function selectCompatibleDevice() {
  const runtimesOutput = await run('xcrun', ['simctl', 'list', 'runtimes', '--json']);
  const runtimes = JSON.parse(runtimesOutput).runtimes
    .filter(rt => rt.isAvailable)
    .sort((a, b) => String(b.version).localeCompare(String(a.version)));
  if (runtimes.length === 0) {
    throw new Error('No available iOS simulator runtime found');
  }
  for (const runtime of runtimes) {
    const supported = (runtime.supportedDeviceTypes || [])
      .map(dt => dt.identifier || dt)
      .filter(id => /iPhone/.test(id) && !/SE/.test(id));
    const preferred = supported.find(id => /Pro$/.test(id)) || supported[0];
    if (preferred) {
      return { deviceType: preferred, runtime: runtime.identifier, runtimeVersion: runtime.version };
    }
  }
  throw new Error('No compatible device type/runtime pair found');
}

/**
 * Creates, boots, and waits for the suite's own simulator. Fails the whole run
 * if any step escapes the owned UDID.
 * @param {string} runId Unique per-run suffix
 */
export async function createOwnedSimulator(runId) {
  const uniqueName = `${OWNED_NAME_PREFIX}${runId}`;
  const before = await listSimulators();

  const { deviceType, runtime } = await selectCompatibleDevice();
  const created = await run('xcrun', ['simctl', 'create', uniqueName, deviceType, runtime]);
  const udid = created.trim();
  if (!/^[0-9A-Fa-f-]{36}$/.test(udid)) {
    throw new Error(`Unexpected simctl create output: ${created}`);
  }

  // The created device must exist with exactly our name.
  const afterCreate = await listSimulators();
  const owned = afterCreate.find(d => d.udid === udid);
  if (!owned || owned.name !== uniqueName) {
    await tryRun('xcrun', ['simctl', 'delete', udid]);
    throw new Error(`Created simulator not found or renamed: ${udid}`);
  }
  if (before.some(d => d.udid === udid)) {
    await tryRun('xcrun', ['simctl', 'delete', udid]);
    throw new Error(` UDID collision with a pre-existing simulator: ${udid}`);
  }

  await run('xcrun', ['simctl', 'boot', udid]);
  await pollUntil(async () => {
    const devices = await listSimulators();
    const target = devices.find(d => d.udid === udid);
    return target?.state === 'Booted';
  }, 120_000);

  return { udid, name: uniqueName, deviceType, runtime };
}

/**
 * Best-effort shutdown+delete of the owned simulator; refuses anything that is
 * not the recorded owned UDID.
 * @param {string} ownedUdid UDID recorded at creation
 */
export async function cleanupOwnedSimulator(ownedUdid) {
  if (!ownedUdid) {
    return;
  }
  const owned = (await listSimulators()).find(d => d.udid === ownedUdid);
  if (!owned || !owned.name.startsWith(OWNED_NAME_PREFIX)) {
    // Never delete a device we did not create, even if it looks similar.
    return { skipped: true, reason: `Device ${ownedUdid} is not owned by this suite` };
  }
  const shutdown = await tryRun('xcrun', ['simctl', 'shutdown', ownedUdid]);
  const deleted = await tryRun('xcrun', ['simctl', 'delete', ownedUdid]);
  return { shutdown: shutdown.ok, deleted: deleted.ok, skipped: false };
}
