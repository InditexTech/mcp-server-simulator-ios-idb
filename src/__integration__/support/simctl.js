// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Runs a command with an argument list (never a shell string).
 * @param {string} command Executable
 * @param {string[]} args Argument array
 * @returns {Promise<string>} Trimmed stdout
 */
export async function run(command, args) {
  const { stdout } = await execFileAsync(command, args, { timeout: 120_000 });
  return stdout.trim();
}

/**
 * Best-effort command execution that never throws; failures are returned as
 * values so teardown can proceed regardless of the failure cause.
 * @param {string} command Executable
 * @param {string[]} args Argument array
 * @returns {Promise<{ok: boolean, stdout?: string, error?: Error}>}
 */
export async function tryRun(command, args) {
  try {
    const stdout = await run(command, args);
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error) };
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Lists simulators with xcrun simctl.
 * @returns {Promise<Array<{udid: string, name: string, state: string, runtime: string, deviceType: string}>>}
 */
export async function listSimulators() {
  const output = await run('xcrun', ['simctl', 'list', 'devices', '--json']);
  const data = JSON.parse(output);
  const devices = [];
  for (const [runtime, list] of Object.entries(data.devices)) {
    for (const device of /** @type {any[]} */ (list)) {
      devices.push({
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtime,
        deviceType: device.deviceTypeIdentifier || 'Unknown'
      });
    }
  }
  return devices;
}

/**
 * Polls until `predicate` returns true or the deadline expires. Never sleeps
 * blindly: each cycle re-evaluates real state.
 * @param {() => Promise<boolean>} predicate Awaitable condition
 * @param {number} timeoutMs Total budget
 * @param {number} intervalMs Poll interval
 */
export async function pollUntil(predicate, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error(`Condition not met within ${timeoutMs} ms`);
}
