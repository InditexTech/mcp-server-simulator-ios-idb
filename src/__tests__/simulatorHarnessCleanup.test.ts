// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Mocked regression tests for the owned-resource cleanup of the integration
 * harness. These tests exercise ONLY the helper logic (argv matching, user
 * scoping, fail-closed signaling paths, state privacy) against synthetic
 * fixtures; they never spawn real processes, never touch real simulators,
 * and never signal any real PID.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OWNED = 'AAAA1111-2222-4333-8444-555566667777';
const OTHER = 'BBBB2222-3333-4444-8555-666677778888';
const USER = 'fakeuser';

/**
 * The harness lives under src/__integration__ as ESM JavaScript, so Jest (CJ
 * pipeline) cannot import it statically here. Loading it through dynamic
 * import() keeps the unit suite CommonJS-compatible while exercising the
 * real module. This mirrors what the helpers do, without spawning real
 * processes.
 */
/**
 * The harness lives under src/__integration__ as ESM JavaScript; Jest's CVM
 * (CommonJS VM) cannot require it and the unit suite runs without
 * --experimental-vm-modules. A child Node process with that flag loads the
 * real module and returns only the observable outputs this suite needs —
 * a deliberate "spawn one node, import ESM" pattern, with no simulator or
 * real-process side effects.
 */
let probeEnv: NodeJS.ProcessEnv | undefined = undefined;

const runHarnessProbe = (spec: string, call: string, ...args: unknown[]): Promise<any> => {
  const script = `
    const mod = await import(${JSON.stringify(spec)});
    const fn = mod[${JSON.stringify(call)}] ?? null;
    let result = null;
    if (typeof fn === 'function') result = await fn(...${JSON.stringify(args)});
    else result = mod[${JSON.stringify(call)}];
    process.stdout.write(JSON.stringify({ result }));
  `;
  const probe = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--input-type=module', '-e', script
  ], { encoding: 'utf8', env: probeEnv });
  if (probe.status !== 0) {
    throw new Error(`harness probe failed: ${probe.stderr}`);
  }
  return JSON.parse(probe.stdout).result;
};

const listOwnedCompanionProcesses = (udid: string, user: string) =>
  runHarnessProbe(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href, 'listOwnedCompanionProcesses', udid, user);

const terminateOwnedProcess = (target: unknown, udid: string, user: string) =>
  runHarnessProbe(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href, 'terminateOwnedProcess', target, udid, user);

const stateWriteAndReadPath = () => {
  const script = `
    const mod = await import(${JSON.stringify(new URL('../__integration__/support/state.js', import.meta.url).href)});
    delete process.env[mod.STATE_FILE_ENV];
    mod.writeState({ probe: true });
    process.stdout.write(JSON.stringify({ file: process.env[mod.STATE_FILE_ENV] }));
  `;
  const probe = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--input-type=module', '-e', script
  ], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`state probe failed: ${probe.stderr}`);
  }
  return JSON.parse(probe.stdout);
};

/** Builds a ps-style line compatible with the harness parser. */
const line = (pid, user, executable, udid, extra = '') =>
  `${pid} ${user} ${executable} --udid ${udid} --grpc-domain-sock /tmp/idb/${udid}_companion.sock --only simulator${extra}`;

describe('owned companion process identification', () => {
  let directory;
  let psScript;

  const writePsListing = (lines) => {
    writeFileSync(psScript, `#!/bin/bash\nprintf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')}\n`, { mode: 0o755 });
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'harness-cleanup-'));
    // PATH shim: point ps to a controlled stub, everything else unused.
    mkdirSync(path.join(directory, 'bin'));
    psScript = path.join(directory, 'bin', 'ps');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const runWithStubs = async (listOwnedCompanionProcessesFn, listing) => {
    writePsListing(listing);
    const originalProbeEnv = probeEnv;
    probeEnv = { ...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}` };
    try {
      return await listOwnedCompanionProcessesFn(OWNED, USER);
    } finally {
      probeEnv = originalProbeEnv;
    }
  };

  it('matches the companion invoked with exactly the owned UDID', async () => {
        const matches = await runWithStubs(listOwnedCompanionProcesses as any, [
      `  101 ${USER} /opt/homebrew/bin/idb_companion --udid ${OWNED} --grpc-domain-sock /tmp/idb/${OWNED}_companion.sock --only simulator`,
      `  202 ${USER} /opt/homebrew/bin/idb_companion --udid ${OTHER} --grpc-domain-sock /tmp/idb/${OTHER}_companion.sock --only simulator`
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].pid).toBe(101);
    expect(matches[0].args).toContain(OWNED);
  });

  it('rejects a substring collision where the owned UDID is only a suffix of another', async () => {
        const matches = await runWithStubs(listOwnedCompanionProcesses as any, [
      `  303 ${USER} /opt/homebrew/bin/idb_companion --udid x${OWNED} --grpc-domain-sock /tmp/idb/x${OWNED}_companion.sock`
    ]);
    expect(matches).toHaveLength(0);
  });

  it('rejects a process owned by a different user even when the UDID matches', async () => {
        const matches = await runWithStubs(listOwnedCompanionProcesses as any, [
      `  404 root /opt/homebrew/bin/idb_companion --udid ${OWNED}`
    ]);
    expect(matches).toHaveLength(0);
  });

  it('rejects lines without a parseable pid or malformed fields', async () => {
        const matches = await runWithStubs(listOwnedCompanionProcesses as any, [
      '   not-a-pid junk field',
      `  505 ${USER} /usr/sbin/notrelated --udid ${OWNED}`
    ]);
    expect(matches).toHaveLength(0);
  });

  it('matches relative idb_companion invocations', async () => {
        const matches = await runWithStubs(listOwnedCompanionProcesses as any, [
      `  606 ${USER} idb_companion --udid ${OWNED}`
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].pid).toBe(606);
  });
});

describe('terminateOwnedProcess fail-closed behavior', () => {
  let directory;
  let stubbedBin;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'harness-kill-'));
    stubbedBin = path.join(directory, 'bin');
    mkdirSync(stubbedBin);
    // kill stub with scripted behaviors driven by instructions/log files.
    writeFileSync(path.join(stubbedBin, 'kill'), '#!/bin/bash\nif [[ "$3" == "0" ]]; then exit 0; fi\nexit 1\n', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reports SIGKILL failure instead of claiming success', async () => {
    // The stubbed kill always exits 1 without "No such process", so the
    // harness must report failure, never fake success, on a kill error.
      writeFileSync(path.join(stubbedBin, 'kill'), '#!/bin/bash\necho "kill: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    // The probe child must resolve ps/kill from the stub directory.
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const target = { pid: 4242, args: `idb_companion --udid ${OWNED}` };
      const result = await terminateOwnedProcess(target, OWNED, USER);
      expect(result.gone).toBe(false);
      expect(String(result.reason)).toContain('failed');
    } finally {
      probeEnv = undefined;
    }
  });
});

describe('state privacy', () => {
  it('keeps state writes out of shared, predictable temp paths', async () => {
    const { file } = stateWriteAndReadPath();
    expect(file).toBeTruthy();
    // The file must not live directly under tmpdir root with a predictable name.
    const parent = path.dirname(file);
    expect(parent).not.toBe(tmpdir());
    expect(path.basename(file)).not.toBe('mcp-integration-state.json');
    expect(existsSync(file)).toBe(true);
  });

  it('uses a randomly-named private directory instead of a predictable shared path', async () => {
    const { file } = stateWriteAndReadPath();
    const base = path.dirname(file);
    // mkdtemp directory with the suite prefix; not a constant shared dir.
    expect(path.basename(base)).toMatch(/^mcp-it-state-/);
    // A symlink planted on a predictable shared name would not be followed
    // since the file path is random per activation.
    expect(existsSync(path.join(path.dirname(base), 'mcp-integration-state.json'))).toBe(false);
  });
});
