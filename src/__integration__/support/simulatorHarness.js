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
 * - The idb_companion process spawned for the owned device is owned by this
 *   run: cleanup identifies it by exact argv match against the owned UDID,
 *   verifies it runs as the current user, and PID-reuse is fail-closed
 *   (refuse to signal a process whose argv no longer matches).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { listSimulators, run, tryRun, pollUntil } from './simctl.js';

const execFileAsync = promisify(execFile);

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
    const preferred = supported.find(id => id.endsWith('Pro')) || supported[0];
    if (preferred) {
      return { deviceType: preferred, runtime: runtime.identifier, runtimeVersion: runtime.version };
    }
  }
  throw new Error('No compatible device type/runtime pair found');
}

/**
 * Lists idb_companion processes whose exact argv binds them to the given
 * UDID, running as the given user. The argv match is exact (the UDID is a
 * standalone token: `--udid <udid>`), never a substring match, so a
 * process for a different device whose UDID merely contains this one's
 * cannot be signaled. PIDs are returned with their argv for fail-closed
 * verification before any signal is sent.
 * @param {string} udid Owned simulator UDID
 * @param {string} userName Current user name (injected for testability)
 * @returns {Promise<Array<{pid: number, args: string}>>}
 */
export async function listOwnedCompanionProcesses(udid, userName) {
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=', '-o', 'user=', '-o', 'args=']);
  const out = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(' ');
    if (spaceAt < 0) continue;
    const pidToken = trimmed.slice(0, spaceAt);
    const rest = trimmed.slice(spaceAt + 1);
    const pid = Number.parseInt(pidToken, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const userEnd = rest.indexOf(' ');
    if (userEnd < 0) continue;
    const user = rest.slice(0, userEnd);
    const args = rest.slice(userEnd + 1);
    if (user !== userName) continue;
    // Exact-token argv match: the UDID must be its own argument, and the
    // executable must really be idb_companion.
    const tokens = args.split(/\s+/);
    if (!args.startsWith('idb_companion') && !tokens.some(t => t.endsWith('/idb_companion'))) continue;
    const udidIndex = tokens.indexOf('--udid');
    if (udidIndex >= 0 && tokens[udidIndex + 1] === udid) {
      out.push({ pid, args });
    }
  }
  return out;
}

/**
 * Terminates one owned companion process: bounds a SIGTERM with a grace
 * period, then SIGKILLs only if the process still exists AND its argv
 * still matches the owned UDID (PID-reuse fail-closed). Returns whether
 * the process is gone and a reason when it is not.
 * @param {{pid: number, args: string}} target Verified owned process
 * @param {string} udid Owned simulator UDID (argv re-verification)
 * @param {string} userName Current user name
 * @returns {Promise<{gone: boolean, reason?: string}>}
 */
export async function terminateOwnedProcess(target, udid, userName) {
  const killArgs = [String(target.pid), '-TERM'];
  try {
    await execFileAsync('kill', killArgs);
  } catch (error) {
    // exit code 1 with "No such process" means it already exited: fine.
    if (String(error?.message || error).includes('No such process')) {
      return { gone: true };
    }
    return { gone: false, reason: `SIGTERM failed: ${String(error?.message || error)}` };
  }
  return await waitForOwnedExit(target, udid, userName);
}

async function waitForOwnedExit(target, udid, userName) {
  // Bounded wait: recheck via ps (same exact argv binding), then SIGKILL
  // only if the very same argv still matches the owned UDID.
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 200 : 400));
    const still = (await listOwnedCompanionProcesses(udid, userName))
      .find(p => p.pid === target.pid);
    if (!still) {
      return { gone: true };
    }
  }
  try {
    await execFileAsync('kill', ['-KILL', String(target.pid)]);
  } catch (error) {
    if (String(error?.message || error).includes('No such process')) {
      return { gone: true };
    }
    return { gone: false, reason: `SIGKILL failed: ${String(error?.message || error)}` };
  }
  // Final bounded recheck after SIGKILL.
  try {
    await execFileAsync('kill', ['-0', String(target.pid)]);
    return { gone: false, reason: 'process survived SIGKILL' };
  } catch (error) {
    if (String(error?.message || error).includes('No such process')) {
      return { gone: true };
    }
    return { gone: false, reason: `post-KILL probe failed: ${String(error?.message || error)}` };
  }
}

/**
 * Kills every companion bound to the owned UDID, then removes the Unix
 * domain socket path that the companion for this UDID used. Socket removal
 * is gated on the same UDID token appearing in the path AND the path being
 * under the known /tmp/idb directory; arbitrary host paths are never
 * touched.
 * @param {string} udid Owned simulator UDID
 * @param {string} [userName] Current user name override (tests only)
 * @returns {Promise<Array<{pid?: number, path?: string, gone: boolean, reason?: string}>>}
 */
export async function cleanupOwnedCompanions(udid, userName) {
  if (typeof userName === 'undefined') {
    try {
      const { stdout } = await execFileAsync('id', '-un');
      userName = stdout.trim();
    } catch {
      userName = await new Promise(resolve => {
        execFileAsync('whoami').then(r => resolve(r.stdout.trim()), () => resolve(''));
      });
    }
  }
  if (!userName) {
    return [{ gone: false, reason: 'could not resolve current user; refusing to signal anything' }];
  }
  const results = [];
  const procs = await listOwnedCompanionProcesses(udid, userName);
  for (const target of procs) {
    results.push({ pid: target.pid, ...(await terminateOwnedProcess(target, udid, userName)) });
  }
  const socketPath = `/tmp/idb/${udid}_companion.sock`;
  if (procs.length === 0) {
    // No live companion bound to this UDID: only clean the stale socket if
    // it exists (task-owned path under /tmp/idb/<udid>).
    try {
      await execFileAsync('rm', ['-f', socketPath]);
      results.push({ path: socketPath, gone: true, reason: 'stale socket removed (no live companion)' });
    } catch {
      results.push({ path: socketPath, gone: false, reason: 'stale socket removal failed' });
    }
  } else {
    results.push({ path: socketPath, gone: true, reason: 'socket path recorded for owned UDID (not removed while companion alive)' });
  }
  return results;
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
  if (owned?.name !== uniqueName) {
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
  if (!owned?.name.startsWith(OWNED_NAME_PREFIX)) {
    // Never delete a device we did not create, even if it looks similar.
    return { skipped: true, reason: `Device ${ownedUdid} is not owned by this suite` };
  }
  const shutdown = await tryRun('xcrun', ['simctl', 'shutdown', ownedUdid]);
  const deleted = await tryRun('xcrun', ['simctl', 'delete', ownedUdid]);
  return { shutdown: shutdown.ok, deleted: deleted.ok, skipped: false };
}
