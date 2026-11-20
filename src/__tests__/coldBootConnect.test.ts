// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';

const OWNED = 'AAAA1111-2222-4333-8444-555566667777';

// Load the actual ESM harness in a child, replacing native child_process
// exports BEFORE import. No simulator, companion, socket or signal is real.
function probe(scenario = 'ready', setup = false): {
  error: string | null;
  calls: Array<{ command: string; args: string[]; timeout?: number; hasSignal?: boolean; detached?: boolean }>;
  diagnostics: Array<{ stage: string; ready: boolean; budgetMs?: number; failure?: { kind: string; exitCode?: number; signal?: string } }>;
} {
  const script = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const calls = [];
const diagnostics = [];
const scenario = ${JSON.stringify(scenario)};
const udid = ${JSON.stringify(OWNED)};
let bootReady = false;
let spawned = false;
let created = false;
let name;
let currentCompanion;
let clockOffset = 0;
const now = Date.now;
if (scenario === 'slow-handshake') Date.now = () => now() + clockOffset;
cp.execFile = (command, args, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  calls.push({ command, args, timeout: options?.timeout, hasSignal: Boolean(options?.signal) });
  let stdout = '';
  let error;
  if (command === 'xcrun') {
    const op = args[1];
    if (op === 'list' && args[2] === 'runtimes') {
      stdout = JSON.stringify({ runtimes: [{ isAvailable: true, version: '27.0', identifier: 'rt', supportedDeviceTypes: [{ identifier: 'iPhone-Pro' }] }] });
    } else if (op === 'list') {
      stdout = JSON.stringify({ devices: { rt: created ? [{ udid, name, state: 'Booted' }] : [] } });
    } else if (op === 'create') { created = true; name = args[2]; stdout = udid; }
    else if (op === 'bootstatus') {
      if (scenario === 'boot-fails') error = new Error('migration unavailable');
      else bootReady = true;
    } else if (!['boot', 'shutdown', 'delete'].includes(op)) error = new Error('unexpected simctl');
  } else if (command === 'idb') {
    if (!bootReady || !spawned) error = new Error('lazy connect raced incomplete boot');
    else if (args.includes('describe')) {
      stdout = JSON.stringify({ udid: scenario === 'wrong-target' ? 'foreign' : udid });
      if (scenario === 'grpc-fails') error = new Error('gRPC not responding');
      if (scenario === 'slow-handshake') clockOffset = 850;
    } else if (args[0] === 'connect') {
      if (scenario === 'register-timeout' && options?.signal) {
        options.signal.addEventListener('abort', () => callback(Object.assign(new Error('aborted'), {
          code: 'ABORT_ERR', cause: options.signal.reason,
        }), '', 'private diagnostic'), { once: true });
        return new EventEmitter();
      }
      stdout = scenario === 'register-invalid' ? 'not JSON' : JSON.stringify({ udid: scenario === 'register-wrong-target' ? 'foreign' : udid });
      if (scenario === 'register-fails') error = Object.assign(new Error('private registry error'), { code: 7 });
      if (scenario === 'register-signalled') error = Object.assign(new Error('signal'), { signal: 'SIGTERM' });
      if (scenario === 'companion-exits-during-registration') currentCompanion.emit('exit', 42, null);
      if (scenario === 'slow-handshake' && options?.timeout < 300) error = new Error('registration inherited a depleted budget');
    } else error = new Error('unexpected idb');
  } else if (command === 'id') stdout = 'fakeuser';
  else if (command === 'stat') error = new Error('absent');
  else if (command !== 'ps') error = new Error('unexpected native command: ' + command);
  const child = new EventEmitter();
  queueMicrotask(() => callback(error, stdout, ''));
  return child;
};
cp.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
  cp.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
cp.spawn = (command, args, options) => {
  calls.push({ command, args, detached: options.detached });
  spawned = true;
  const child = new EventEmitter();
  currentCompanion = child;
  child.stdout = new PassThrough();
  child.pid = 999999;
  child.unref = () => {};
  setImmediate(() => {
    if (scenario === 'spawn-error') return child.emit('error', new Error('ENOENT'));
    if (scenario === 'exits') return child.emit('exit', 42, null);
    if (scenario === 'never-ready') return;
    const report = JSON.stringify({ grpc_path: scenario === 'wrong-socket' ? '/foreign.sock' : '/tmp/idb/' + udid + '_companion.sock' });
    child.stdout.write(report.slice(0, 9));
    child.stdout.write(report.slice(9) + '\\n');
  });
  return child;
};
syncBuiltinESMExports();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-boot-probe-'));
let error = null;
try {
  if (${setup}) {
    const sut = (await import(${JSON.stringify(new URL('../__integration__/support/globalSetup.js', import.meta.url).href)})).default;
    await sut();
  } else {
    const { connectOwnedSimulator: sut } = await import(${JSON.stringify(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href)});
    await sut(udid, dir, { timeoutMs: scenario === 'slow-handshake' ? 1000 : 200, registrationTimeoutMs: 30, diagnostics });
  }
} catch (e) { error = e.message; }
finally {
  const stateFile = process.env.MCP_INTEGRATION_STATE;
  if (stateFile) fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ error, calls, diagnostics }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
  if (result.status !== 0) throw new Error(`Cold-boot probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('owned cold-boot connection', () => {
  it('given Booted but unfinished services, global setup waits before starting and registering the companion', () => {
    // GIVEN / WHEN: Booted is visible immediately; native boot services are not.
    const outcome = probe('ready', true);
    // THEN: the real setup must cross both boot and gRPC barriers.
    expect(outcome.error).toBeNull();
    const commands = outcome.calls.filter(c => c.command === 'idb' || c.command === 'idb_companion' || c.args[1] === 'bootstatus');
    expect(commands.map(c => c.command)).toEqual(['xcrun', 'idb_companion', 'idb', 'idb']);
    expect(commands[0].args).toEqual(['simctl', 'bootstatus', OWNED]);
    expect(commands[1].args).toEqual(['--udid', OWNED, '--grpc-domain-sock', `/tmp/idb/${OWNED}_companion.sock`, '--only', 'simulator']);
    expect(commands[2].args).toEqual(['--companion', `/tmp/idb/${OWNED}_companion.sock`, 'describe', '--json']);
    expect(commands[3].args).toEqual(['connect', OWNED, '--json']);
    expect(commands[3]).toMatchObject({ hasSignal: true });
  });

  it('gives verified registration its own deadline after slow startup', () => {
    const outcome = probe('slow-handshake');
    expect(outcome.error).toBeNull();
    expect(outcome.diagnostics[outcome.diagnostics.length - 1])
      .toMatchObject({ stage: 'registration', budgetMs: 30, ready: true });
    expect(outcome.calls.filter(c => c.command === 'idb' && c.args[0] === 'connect')).toHaveLength(1);
  });

  it.each([
    ['register-timeout', { kind: 'timeout' }],
    ['register-fails', { kind: 'exit', exitCode: 7 }],
    ['register-signalled', { kind: 'signal', signal: 'SIGTERM' }],
    ['register-invalid', { kind: 'invalid-response' }],
    ['register-wrong-target', { kind: 'wrong-target' }],
    ['companion-exits-during-registration', { kind: 'companion-exited' }],
  ] as const)('classifies %s without retrying startup or exposing raw child output', (scenario, failure) => {
    const outcome = probe(scenario);
    expect(outcome.error).toContain('cold-start registration failed');
    expect(outcome.error).not.toContain('private');
    expect(outcome.diagnostics[outcome.diagnostics.length - 1])
      .toMatchObject({ stage: 'registration', budgetMs: 30, ready: false, failure });
    expect(outcome.calls.filter(c => c.command === 'idb_companion')).toHaveLength(1);
  });

  it.each([
    ['boot-fails', 'boot-services'],
    ['spawn-error', 'companion-start'],
    ['exits', 'companion-start'],
    ['never-ready', 'companion-start'],
    ['wrong-socket', 'companion-start'],
    ['grpc-fails', 'grpc-handshake'],
    ['wrong-target', 'grpc-handshake'],
    ['register-fails', 'registration'],
  ])('given %s, fails closed with the startup stage instead of a generic exit code', (scenario, stage) => {
    // GIVEN / WHEN
    const outcome = probe(scenario);
    // THEN: never register a companion whose readiness/identity is unproven.
    expect(outcome.error).toContain(`cold-start ${stage} failed`);
    expect(outcome.calls.filter(c => c.command === 'idb' && c.args[0] === 'connect')).toHaveLength(stage === 'registration' ? 1 : 0);
  });

  it.each([['grpc-fails', 'grpc-handshake', 0], ['register-fails', 'registration', 1]] as const)(
    'given %s, global setup removes the owned simulator', (scenario, stage, attempts) => {
      const outcome = probe(scenario, true);
      expect(outcome.error).toContain(`cold-start ${stage} failed`);
      expect(outcome.calls.filter(c => c.command === 'xcrun' && ['shutdown', 'delete'].includes(c.args[1])).map(c => c.args))
        .toEqual([['simctl', 'shutdown', OWNED], ['simctl', 'delete', OWNED]]);
      expect(outcome.calls.filter(c => c.command === 'idb' && c.args[0] === 'connect')).toHaveLength(attempts);
    },
  );
});
