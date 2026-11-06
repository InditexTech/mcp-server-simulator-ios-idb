// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface SimDeviceType {
  identifier: string;
  name: string;
  productFamily?: string;
}

interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  isAvailable: boolean;
  supportedDeviceTypes?: SimDeviceType[];
}

const BOOT_TIMEOUT_MS = 10 * 60 * 1000;
const SIMULATOR_NAME_PREFIX = 'mcp-integration-';

async function simctl(args: string[], timeout = 60000): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Picks the newest available iOS runtime and an iPhone it supports, unless
 * IOS_SIM_RUNTIME / IOS_SIM_DEVICE_TYPE name them explicitly. Choosing at run
 * time keeps the tests working as runner images change their Xcode versions.
 */
async function pickRuntimeAndDeviceType(): Promise<{ runtime: string; deviceType: string }> {
  const { runtimes } = JSON.parse(await simctl(['list', '--json', 'runtimes'])) as { runtimes: SimRuntime[] };
  const iosRuntimes = runtimes
    .filter(runtime => runtime.isAvailable && runtime.identifier.includes('.SimRuntime.iOS-'))
    .sort((a, b) => compareVersions(b.version, a.version));

  const runtime = process.env.IOS_SIM_RUNTIME
    ? iosRuntimes.find(candidate => candidate.identifier === process.env.IOS_SIM_RUNTIME)
    : iosRuntimes[0];
  if (!runtime) {
    throw new Error('No available iOS Simulator runtime found (xcrun simctl list runtimes)');
  }

  if (process.env.IOS_SIM_DEVICE_TYPE) {
    return { runtime: runtime.identifier, deviceType: process.env.IOS_SIM_DEVICE_TYPE };
  }
  const iPhones = (runtime.supportedDeviceTypes ?? []).filter(device => device.productFamily === 'iPhone');
  if (iPhones.length === 0) {
    throw new Error(`No iPhone device type supported by ${runtime.name}; set IOS_SIM_DEVICE_TYPE`);
  }
  // The list order is not chronological: prefer the newest base model
  // ("iPhone 17" over "iPhone 17 Pro" or "iPhone 11"), else the first iPhone.
  const baseModels = iPhones
    .map(device => ({ device, model: /^iPhone (\d+)$/.exec(device.name)?.[1] }))
    .filter((entry): entry is { device: SimDeviceType; model: string } => entry.model !== undefined)
    .sort((a, b) => Number(b.model) - Number(a.model));
  return { runtime: runtime.identifier, deviceType: (baseModels[0]?.device ?? iPhones[0]).identifier };
}

/**
 * Shuts down and deletes a simulator, reporting failures instead of throwing
 */
async function deleteSimulator(udid: string): Promise<void> {
  // Shutdown fails if the simulator is already off; deleting is what matters
  await simctl(['shutdown', udid], 120000).catch(() => undefined);
  try {
    await simctl(['delete', udid], 120000);
  } catch (error) {
    process.stderr.write(`Could not delete simulator ${udid}: ${error}\n`);
  }
}

/**
 * Deletes simulators left behind by earlier runs that never reached
 * globalTeardown (e.g. interrupted with Ctrl-C)
 */
async function deleteLeftoverSimulators(): Promise<void> {
  const { devices } = JSON.parse(await simctl(['list', '--json', 'devices'])) as {
    devices: Record<string, Array<{ udid: string; name: string }>>;
  };
  const leftovers = Object.values(devices)
    .flat()
    .filter(device => device.name.startsWith(SIMULATOR_NAME_PREFIX));
  for (const device of leftovers) {
    process.stderr.write(`Deleting leftover simulator ${device.name} (${device.udid})\n`);
    await deleteSimulator(device.udid);
  }
}

/**
 * Creates and boots a disposable simulator for the integration tests and
 * exposes its UDID through IOS_SIM_INTEGRATION_UDID. Only simulators named
 * mcp-integration-* are created or deleted; globalTeardown deletes this one.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.IOS_SIM_INTEGRATION !== '1') {
    process.stderr.write('\nSkipping simulator integration tests: set IOS_SIM_INTEGRATION=1 to run them.\n');
    return;
  }

  await deleteLeftoverSimulators();
  const { runtime, deviceType } = await pickRuntimeAndDeviceType();
  const name = `${SIMULATOR_NAME_PREFIX}${Date.now()}`;
  process.stderr.write(`\nCreating simulator ${name} (${deviceType}, ${runtime})\n`);
  const udid = await simctl(['create', name, deviceType, runtime]);
  process.env.IOS_SIM_INTEGRATION_UDID = udid;

  try {
    // Boots the device if needed and waits until it has finished booting
    await simctl(['bootstatus', udid, '-b'], BOOT_TIMEOUT_MS);
  } catch (error) {
    process.stderr.write(`Simulator ${udid} failed to boot: ${error}\n`);
    await deleteSimulator(udid);
    delete process.env.IOS_SIM_INTEGRATION_UDID;
    throw error;
  }
  process.stderr.write(`Simulator ${udid} booted\n`);
}
