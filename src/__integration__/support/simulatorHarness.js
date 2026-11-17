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

import { execFile } from 'node:child_process';
import * as path from 'node:path';
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
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=', '-o', 'user=', '-o', 'lstart=', '-o', 'ucomm=', '-o', 'args=']);
  const out = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // ps columns: pid, user, lstart (5 words), ucomm (single word — the
    // real executable NAME/argv[0] basename, immune to argv spoofing; comm=
    // is truncated to 16 chars when combined with other columns on macOS),
    // args. Positional: pid + user + 5 lstart tokens + ucomm + rest.
    const columns = trimmed.split(/\s+/);
    if (columns.length < 10) continue;
    const pid = Number.parseInt(columns[0], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const user = columns[1];
    const lstart = columns.slice(2, 7).join(' ');
    const executable = path.basename(columns[7]);
    const args = columns.slice(8).join(' ');
    if (user !== userName) continue;
    // OWNERSHIP by the REAL executable from ps comm (argv[0]), not by any
    // argument token: a python process whose ARGUMENTS merely mention
    // idb_companion can never pass. The owned UDID must additionally be a
    // standalone argv token following --udid exactly.
    if (executable !== 'idb_companion') continue;
    const tokens = args.split(/\s+/);
    const udidIndex = tokens.indexOf('--udid');
    if (udidIndex >= 0 && tokens[udidIndex + 1] === udid) {
      out.push({ pid, user, lstart, executable, args });
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
  // PID-reuse fail-closed gates, applied FRESH immediately before every
  // signal (TERM and KILL alike): the live process must still exist, run
  // as the expected user, carry the EXACT same argv and lstart as the
  // captured target, and be the idb_companion executable. Anything else
  // means the original owned process is gone (or was never ours) and we
  // must NOT signal the current PID holder.
  const verifyStillTarget = async () => {
    // Raw process lookup by PID: distinguishes 'exited' from 'reused' (a
    // live process with different identity must never be signaled).
    const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=', '-o', 'user=', '-o', 'lstart=', '-o', 'args=']);
    const liveLine = stdout.split('\n').find(line => line.trim().startsWith(`${target.pid} `));
    if (!liveLine) {
      return { ok: false, verdict: 'exited' };
    }
    const live = (await listOwnedCompanionProcesses(udid, userName)).find(p => p.pid === target.pid);
    if (!live) {
      return { ok: false, verdict: 'identity-changed: pid alive but no longer our owned companion executable/user' };
    }
    if (live.executable !== target.executable) {
      return { ok: false, verdict: 'identity-changed: refusing to signal a reused or mutated PID' };
    }
    if (live.executable !== 'idb_companion') {
      return { ok: false, verdict: 'identity-changed: pid no longer runs idb_companion' };
    }
    if (live.args !== target.args || live.lstart !== target.lstart || live.user !== target.user) {
      return { ok: false, verdict: 'identity-changed: refusing to signal a reused or mutated PID' };
    }
    return { ok: true };
  };

  const pre = await verifyStillTarget();
  if (!pre.ok) {
    if (pre.verdict === 'exited') {
      return { gone: true };
    }
    return { gone: false, reason: pre.verdict };
  }

  try {
    await execFileAsync('kill', ['-TERM', String(target.pid)]);
  } catch (error) {
    if (String(error?.message || error).includes('No such process')) {
      return { gone: true };
    }
    return { gone: false, reason: `SIGTERM failed: ${String(error?.message || error)}` };
  }

  // Bounded recheck; the LAST iteration must re-verify identity before
  // escalating to SIGKILL, so a PID reused between TERM and KILL is never
  // signaled. Residual TOCTOU between the last check and the kill syscall
  // is inherent to userspace and documented here rather than overclaimed.
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 200 : 400));
    const verdict = await verifyStillTarget();
    if (verdict.ok) {
      if (attempt < 9) continue;
      // Still the same owned process after the whole grace budget: KILL.
      try {
        await execFileAsync('kill', ['-KILL', String(target.pid)]);
      } catch (error) {
        if (String(error?.message || error).includes('No such process')) {
          return { gone: true };
        }
        return { gone: false, reason: `SIGKILL failed: ${String(error?.message || error)}` };
      }
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
    if (verdict.verdict === 'exited') {
      return { gone: true };
    }
    return { gone: false, reason: verdict.verdict };
  }
  return { gone: false, reason: 'termination budget exhausted without confirmation' };
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
  // Ownership guard: refuse an absent/invalid UDID instead of leaving an
  // exported helper that could signal or sweep on undefined inputs.
  if (typeof udid !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(udid)) {
    return [{ gone: false, reason: 'cleanup refused: no valid owned UDID' }];
  }
  if (typeof userName === 'undefined') {
    try {
      const { stdout } = await execFileAsync('id', ['-un']);
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
  const terminatePass = async () => {
    const procs = await listOwnedCompanionProcesses(udid, userName);
    for (const target of procs) {
      results.push({ pid: target.pid, ...(await terminateOwnedProcess(target, udid, userName)) });
    }
    // Fail closed against RESPAWNS: re-list and treat ANY live process
    // matching the owned UDID + current user as a still-owned live
    // companion, whether or not it was in the first pass.
    const stillAlive = await listOwnedCompanionProcesses(udid, userName);
    if (stillAlive.length > 0) {
      results.push({ path: `/tmp/idb/${udid}_companion.sock`, gone: false, reason: `owned companion(s) still alive after termination pass (${stillAlive.map(p => p.pid).join(',')}); socket not touched` });
      return false;
    }
    return true;
  };

  // Two bounded passes: the first terminates what exists, the re-list in
  // terminatePass catches same-identity survivors AND newly respawned
  // companions. If anything is still alive after both passes, cleanup is
  // REPORTED failed (fail closed) instead of looping forever against an
  // active respawner.
  const passOneOk = await terminatePass();
  const allGone = passOneOk ? true : await terminatePass();
  if (!allGone) {
    return results;
  }

  // Socket handling: removal is claimed only when every owned companion
  // for this UDID is confirmed gone, and only after verifying the path is
  // a real socket file (never a symlink/directory) at the exact expected
  // location.
  const socketPath = `/tmp/idb/${udid}_companion.sock`;
  const survivors = await listOwnedCompanionProcesses(udid, userName);
  if (survivors.length > 0) {
    results.push({ path: socketPath, gone: false, reason: 'owned companion(s) still alive; socket not touched' });
    return results;
  }
  let fileType = null;
  try {
    const { stdout } = await execFileAsync('stat', ['-f', '%HT', socketPath]);
    fileType = stdout.trim();
  } catch {
    fileType = null; // path absent: acceptable end state, nothing to remove
  }
  if (fileType && fileType !== 'Socket') {
    results.push({ path: socketPath, gone: false, reason: `socket path exists but is not a socket (${fileType}); refusing to touch` });
    return results;
  }
  if (fileType === 'Socket') {
    try {
      await execFileAsync('rm', [socketPath]);
      results.push({ path: socketPath, gone: true, reason: 'socket removed after all owned companions confirmed gone' });
    } catch (error) {
      results.push({ path: socketPath, gone: false, reason: `socket removal failed: ${String(error?.message || error)}` });
    }
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

  // Pre-existing-collision guard, BEFORE any cleanup scope: if the
  // returned UDID was already in the pre-run inventory, the device was
  // never ours to mutate and no finally below may touch it. simctl create
  // silently reuses an existing device name→UDID, so a collision can make
  // `create` "succeed" on someone else's device; the createdNew proof
  // (returned UDID absent from `before`) is the only accepted acquisition
  // evidence.
  const collision = before.some(d => d.udid === udid);
  const createdNew = !collision;
  if (!createdNew) {
    throw new Error(`UDID collision with a pre-existing simulator: ${udid}`);
  }

  // From here on the device exists AND was provably created by this call:
  // EVERY subsequent step lives inside try/finally so a boot throw, a
  // verification throw, or a readiness timeout can never leak it. The
  // globalSetup catch alone cannot provide this: it only runs when
  // createOwnedSimulator RETURNS, so a mid-function throw must be
  // contained here.
  let succeeded = false;
  try {
    // The created device must exist with exactly our name.
    const afterCreate = await listSimulators();
    const owned = afterCreate.find(d => d.udid === udid);
    if (owned?.name !== uniqueName) {
      throw new Error(`Created simulator not found or renamed: ${udid}`);
    }

    await run('xcrun', ['simctl', 'boot', udid]);
    await pollUntil(async () => {
      const devices = await listSimulators();
      const target = devices.find(d => d.udid === udid);
      return target?.state === 'Booted';
    }, 120_000);

    succeeded = true;
    return { udid, name: uniqueName, deviceType, runtime };
  } finally {
    if (!succeeded) {
      // Failure containment: shut down and delete exactly the device this
      // call created (createdNew proof); a collision never reaches this
      // finally because the throw happens outside the guarded block.
      await tryRun('xcrun', ['simctl', 'shutdown', udid]);
      await tryRun('xcrun', ['simctl', 'delete', udid]);
    }
  }
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
