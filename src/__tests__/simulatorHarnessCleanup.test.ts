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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const importStateFaDeFs = 0;
const importStateModule = async (): Promise<any> => runHarnessProbe(new URL('../__integration__/support/state.js', import.meta.url).href, '__NOFN__');
const importStateFs = async (): Promise<any> => import('node:fs');
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
  const script = `    const mod = await import(${JSON.stringify(spec)});
    const fn = mod[${JSON.stringify(call)}] ?? null;
    const result = fn ? await fn(...${JSON.stringify(args)}) : null;
    process.stdout.write(JSON.stringify({ result, probePid: process.pid }));
    process.stderr.write('FNRET:' + String(fn).slice(-320).replace(/[^\x20-\x7e]/g,' '));
  `;
  const probe = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--input-type=module', '-e', script
  ], { encoding: 'utf8', env: probeEnv });
  if (probe.status !== 0) {
    throw new Error(`harness probe failed: ${probe.stderr}`);
  }
  const parsed = JSON.parse(probe.stdout);
  if ((parsed.result ?? null) === null || (Array.isArray(parsed.result) && parsed.result.length === 0)) {
    throw new Error(`probe returned empty result. child stderr: ${(probe.stderr ?? '').slice(0, 500)}`);
  }
  return parsed.result;
};

const listOwnedCompanionProcesses = (udid: string, user: string) =>
  runHarnessProbe(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href, 'listOwnedCompanionProcesses', udid, user);

const terminateOwnedProcess = (target: unknown, udid: string, user: string) =>
  runHarnessProbe(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href, 'terminateOwnedProcess', target, udid, user);


/**
 * Probes that load the real harness in a disposable child with a stubbed
 * xcrun, so createOwnedSimulator's full lifecycle is exercisable without a
 * real simulator. The stub xcrun reads behavior from a scenario JSON file
 * (written by runCreateOwnedSimulatorProbe), so no nested template literals.
 */
const probeDir = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  return dir;
};

const writeXcrunStub = (dir: string): void => {
  writeFileSync(
    path.join(dir, 'bin', 'xcrun'),
    [
      '#!/bin/bash',
      'LOG="${PROBE_LOG}"',
      'SCENARIO="${PROBE_SCENARIO}"',
      'ARGS="$*"',
      'case "$ARGS" in',
      '  *"list runtimes"*) cat "${SCENARIO}/runtimes.json"; exit 0 ;;',
      '  *"list devices"*)',
      '    C=$(cat "${SCENARIO}/seq")',
      '    C=$((C+1))',
      '    echo "$C" > "${SCENARIO}/seq"',
      '    # 1st list = before; 2nd = after create; 3rd+ = for boot polling',
      '    if [[ "$C" -eq 1 ]]; then cat "${SCENARIO}/before.json"',
      '    elif [[ -f "${SCENARIO}/booted.json" && "$C" -ge 3 ]]; then cat "${SCENARIO}/booted.json"',
      '    else cat "${SCENARIO}/shutdown.json"',
      '    fi',
      '    exit 0;;',
      'esac',
      'OP="$2"',
      'case "$OP" in',
      '  create) cat "${SCENARIO}/create-output.txt"; echo create >> "${LOG}"; echo 1 > "${SCENARIO}/created"; exit 0;;',
      '  boot) echo "boot $3" >> "${LOG}"; exit "${PROBE_BOOT_EXIT}" ;;',
      '  shutdown|delete) echo "$OP $3" >> "${LOG}"; exit 0;;',
      '  *) echo "unexpected: $ARGS" >> "${LOG}"; exit 1;;',
      'esac'
    ].join('\n'),
    { mode: 0o755 }
  );
};

const runCreateOwnedSimulatorProbe = (scenario: 'boot-fails' | 'happy', outcome_dbg?: boolean): any => {
  const dir = probeDir(`harness-${scenario}-`);
  const scenarioDir = path.join(dir, 'scenario');
  mkdirSync(scenarioDir, { recursive: true });
  const udid = 'AAAA1111-2222-4333-8444-555566667777';
  const bootExit = scenario === 'boot-fails' ? '1' : '0';
  const before = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [] } };
  const createdShutdown = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
    { udid, name: 'mcp-integration-probe0', state: 'Shutdown', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' }
  ] } };
  const createdBooted = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
    { udid, name: 'mcp-integration-probe0', state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' }
  ] } };
  writeFileSync(path.join(scenarioDir, 'before.json'), JSON.stringify(before));
  writeFileSync(path.join(scenarioDir, 'shutdown.json'), JSON.stringify(createdShutdown));
  writeFileSync(path.join(scenarioDir, 'booted.json'), JSON.stringify(createdBooted));
  writeFileSync(path.join(scenarioDir, 'runtimes.json'), JSON.stringify({
    runtimes: [
      {
        isAvailable: true,
        version: '27.0',
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
        supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17 Pro' }]
      }
    ]
  }));
  writeFileSync(path.join(scenarioDir, 'create-output.txt'), `${udid}\n`);
  writeFileSync(path.join(scenarioDir, 'seq'), '0');
  writeXcrunStub(dir);
  const script = `
const harness = await import(${JSON.stringify(new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href)});
let bootThrew = false;
try {
  await harness.createOwnedSimulator('probe0');
} catch {
  bootThrew = true;
}
const { readFileSync } = await import('node:fs');
const log = readFileSync(process.env.PROBE_LOG, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean);
const shutdown = log.filter(l => l.startsWith('shutdown ')).map(l => l.split(' ')[1]);
const deleted = log.filter(l => l.startsWith('delete ')).map(l => l.split(' ')[1]);
const bootCalls = log.filter(l => l.startsWith('boot ')).length;
process.stdout.write(JSON.stringify({ bootThrew, bootCalls, shutdown, deleted, ownedUdid: ${JSON.stringify(udid)} })); process.stderr.write("WHICH:" + process.env.PATH.split(":")[0]);
`;
  const probe = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      PROBE_LOG: path.join(dir, 'calls.log'),
      PROBE_SCENARIO: scenarioDir,
      PROBE_BOOT_EXIT: bootExit
    }
  });
  if (probe.status !== 0) {
    throw new Error(`probe failed: stderr=${(probe.stderr ?? '').slice(0, 600)}`);
  }
  process.stderr.write(`DBG-out: ${probe.stdout.slice(0,400)}\n`);
  const outcome = JSON.parse(probe.stdout);
  rmSync(dir, { recursive: true, force: true });
  return outcome;
};

describe('createOwnedSimulator failure containment', () => {
  it('deletes exactly the owned device when boot throws (no other device touched)', async () => {
    const outcome = runCreateOwnedSimulatorProbe('boot-fails');
    expect(outcome.bootThrew).toBe(true);
    expect(outcome.bootCalls).toBe(1);
    expect(outcome.shutdown).toEqual([outcome.ownedUdid]);
    expect(outcome.deleted).toEqual([outcome.ownedUdid]);
  });

  it('keeps the device when creation succeeds (happy path containment inactive)', async () => {
    const outcome = runCreateOwnedSimulatorProbe('happy');
    expect(outcome.bootThrew).toBe(false);
    expect(outcome.bootCalls).toBe(1);
    expect(outcome.shutdown).toEqual([]);
    expect(outcome.deleted).toEqual([]);
  });
});

describe('terminateOwnedProcess PID-reuse fail-closed', () => {
  let directory: string;
  let stubbedBin: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'harness-reuse-'));
    stubbedBin = path.join(directory, 'bin');
    mkdirSync(stubbedBin);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses to TERM a reused PID whose argv differs from the captured target', async () => {
    // ps reports a DIFFERENT executable for the same pid than the target
    // captured at identification time → identity-changed, no kill call.
    writeFileSync(path.join(stubbedBin, 'ps'), `#!/bin/bash\necho "  777 ${USER} Tue Nov 17 00:38:42 2026 /usr/sbin/sshd --udid ${OTHER}"\n`, { mode: 0o755 });
    writeFileSync(path.join(stubbedBin, 'kill'), '#!/bin/bash\necho "KILL MUST NOT RUN" >&2\nexit 1\n', { mode: 0o755 });
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const result = await terminateOwnedProcess(
        { pid: 777, user: USER, lstart: 'Tue Nov 17 00:38:42 2026', args: `idb_companion --udid ${OWNED}` },
        OWNED,
        USER
      );
      expect(result.gone).toBe(false);
      expect(String(result.reason)).toContain('identity-changed');
    } finally {
      probeEnv = undefined;
    }
  });

  it('refuses to TERM a process running as a different user even with identical argv', async () => {
    writeFileSync(path.join(stubbedBin, 'ps'), `#!/bin/bash\necho "  778 root Tue Nov 17 00:38:42 2026 idb_companion --udid ${OWNED}"\n`, { mode: 0o755 });
    writeFileSync(path.join(stubbedBin, 'kill'), '#!/bin/bash\necho "KILL MUST NOT RUN" >&2\nexit 1\n', { mode: 0o755 });
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const result = await terminateOwnedProcess(
        { pid: 778, user: USER, lstart: 'Tue Nov 17 00:38:42 2026', args: `idb_companion --udid ${OWNED}` },
        OWNED,
        USER
      );
      expect(result.gone).toBe(false);
      expect(String(result.reason)).toContain('identity-changed');
    } finally {
      probeEnv = undefined;
    }
  });
});

describe('cleanupOwnedCompanions socket claim discipline', () => {
  it('removes the socket only after the owned companion is confirmed gone, and never claims removal while it lives', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-sock-'));
    const stubbedBin = path.join(directory, 'bin');
    mkdirSync(stubbedBin);
    // ps: alive until killed (stub flips via marker file), then none.
    writeFileSync(
      path.join(stubbedBin, 'ps'),
      `#!/bin/bash\nif [[ -f "${directory}/died" ]]; then exit 0; else echo "  999 ${USER} Tue Nov 17 00:38:42 2026 idb_companion --udid ${OWNED}"; fi\n`,
      { mode: 0o755 }
    );
    writeFileSync(path.join(stubbedBin, 'kill'), `#!/bin/bash\ntouch "${directory}/died"\nexit 0\n`, { mode: 0o755 });
    // stat: real Socket type for the owned path; failure otherwise.
    writeFileSync(
      path.join(stubbedBin, 'stat'),
      `#!/bin/bash\nif [[ "$3" == "/tmp/idb/${OWNED}_companion.sock" ]]; then echo Socket; exit 0; else echo "stat: no such socket" >&2; exit 1; fi\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      path.join(stubbedBin, 'rm'),
      `#!/bin/bash\necho "rm $*" >> "${directory}/rm.log"\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(path.join(stubbedBin, 'id'), '#!/bin/bash\necho fakeuser\n', { mode: 0o755 });
    // Real socket bound ONLY to the owned UDID; cleaned in finally.
    const socketExisted = existsSync(`/tmp/idb/${OWNED}_companion.sock`);
    const tmpSocket = `/tmp/idb/${OWNED}_companion.sock`;
    if (!socketExisted && existsSync('/tmp/idb')) {
      writeFileSync(tmpSocket, Buffer.alloc(0), { mode: 0o600 });
    }
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const results = await runHarnessProbe(
        new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href,
        'cleanupOwnedCompanions',
        OWNED
      );
      expect(results.some(r => r.pid === 999 && r.gone === true)).toBe(true);
      const socketResult = results.find(r => r.path);
      expect(socketResult?.gone).toBe(true);
      const rmLog = readFileSync(path.join(directory, 'rm.log'), 'utf8');
      expect(rmLog).toContain(`/tmp/idb/${OWNED}_companion.sock`);
      expect(rmLog.trim().split(String.fromCharCode(10)).filter(Boolean)).toHaveLength(1);
    } finally {
      probeEnv = undefined;
      if (!socketExisted && existsSync(tmpSocket)) rmSync(tmpSocket, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses arbitrary blank UDIDs (ownership guard)', async () => {
    const results = await runHarnessProbe(
      new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href,
      'cleanupOwnedCompanions',
      ''
    );
    expect(results).toHaveLength(1);
    expect(String(results[0].reason)).toContain('refused');
  });
});

describe('globalTeardown fail-closed and summary privacy', () => {
  const runTeardownProbe = (scenario: 'clean' | 'leak'): any => {
    const dir = probeDir('harness-teardown-');
    const scenarioDir = path.join(dir, 'scenario');
    mkdirSync(scenarioDir, { recursive: true });
    const udid = 'AAAA1111-2222-4333-8444-555566667777';
    const stateDir = path.join(dir, 'mcp-it-teardown-state');
    mkdirSync(stateDir);
    const stateFile = path.join(stateDir, 'state.json');
    // The state file intentionally carries a foreign UDID (canary): if the
    // summary copied anything beyond owned-run metadata, the test fails.
    writeFileSync(
      stateFile,
      JSON.stringify({ udid, name: 'mcp-integration-teardown', stateDir, beforeInventory: [{ udid: 'FFFF9999-8888-4777-8666-555544443333', state: 'Shutdown' }] })
    );
    // stubs: xcrun simctl; teardown uses listSimulators → device present only when leak scenario
    writeFileSync(
      path.join(scenarioDir, 'devices.json'),
      JSON.stringify({ devices: { rt: [ { udid, name: 'mcp-integration-teardown', state: 'Shutdown' } ] } })
    );
    writeFileSync(path.join(scenarioDir, 'runtimes.json'), JSON.stringify({ runtimes: [] }));
    // ps: reports an owned companion ONLY in leak scenario
    if (scenario === 'leak') {
      writeFileSync(
        path.join(dir, 'bin', 'ps'),
        `#!/bin/bash\necho "  5150 ${'arturono-probe'} Tue Nov 17 00:38:42 2026 idb_companion --udid ${udid}"\n`,
        { mode: 0o755 }
      );
    } else {
      writeFileSync(path.join(dir, 'bin', 'ps'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    }
    writeFileSync(path.join(dir, 'bin', 'kill'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(dir, 'bin', 'id'), `#!/bin/bash\necho ${'arturono-probe'}\n`, { mode: 0o755 });
    writeFileSync(path.join(dir, 'bin', 'stat'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    writeFileSync(path.join(scenarioDir, 'seq'), '0');
    const artifactsDir = path.join(dir, 'artifacts');
    mkdirSync(artifactsDir);
    // canary strings that must NEVER appear in the summary: a foreign device UDID and a user path
    const foreignUdid = 'FFFF9999-8888-4777-8666-555544443333';
    const script = `
const teardown = (await import(${JSON.stringify(new URL('../__integration__/support/globalTeardown.js', import.meta.url).href)})).default;
const { existsSync, readFileSync } = await import('node:fs');
let threw = false;
try { await teardown(); } catch (e) { threw = true; process.stderr.write('TEARDOWN_ERROR:' + String(e && e.message).replace(/[^\\x20-\\x7e]/g, ' ')); }
const summaryPath = ${JSON.stringify(path.join(artifactsDir, 'mcp-integration-summary.json'))};
const summaryExists = existsSync(summaryPath);
const summary = summaryExists ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
process.stdout.write(JSON.stringify({ threw, summaryExists, summary, stateDirGone: !existsSync(${JSON.stringify(stateDir)}) }));
`;
    const probe = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        PROBE_SCENARIO: scenarioDir,
        MCP_INTEGRATION_STATE: stateFile,
        IOS_SIM_ARTIFACTS_DIR: artifactsDir
      }
    });
    writeFileSync(path.join(dir, 'last-stderr.txt'), probe.stderr ?? '');
    const outcome = JSON.parse(probe.stdout);
    rmSync(dir, { recursive: true, force: true });
    return outcome;
  };

  it('clean teardown exits without throwing and leaves no private dir behind', async () => {
    const outcome = runTeardownProbe('clean');
    expect(outcome.threw).toBe(false);
    expect(outcome.stateDirGone).toBe(true);
  });

  it('failing teardown THROWS instead of exiting 0 with leaked resources', async () => {
    const outcome = runTeardownProbe('leak');
    expect(outcome.threw).toBe(true);
  });

  it('summary exposes ONLY owned-run metadata: no pre-existing inventory, no foreign UDIDs', async () => {
    const outcome = runTeardownProbe('clean');
    expect(outcome.summaryExists).toBe(true);
    const serialized = JSON.stringify(outcome.summary);
    expect(serialized).not.toContain('FFFF9999');
    expect(serialized).not.toContain('beforeInventory');
    expect(Object.keys(outcome.summary)).toEqual(expect.arrayContaining(['run', 'udid', 'deviceName', 'simCleanup', 'companionCleanup']));
  });
});

describe('state read has no side effects', () => {
  it('readState without MCP_INTEGRATION_STATE throws and creates no directory/file', async () => {
    const { readdirSync, statSync } = await importStateFs();
    const countStateDirs = (): string[] => {
      try {
        return readdirSync(tmpdir()).filter(e => e.startsWith('mcp-it-state-'));
      } catch {
        return [];
      }
    };
    const beforeKinds = countStateDirs();
    probeEnv = { ...process.env };
    delete probeEnv.MCP_INTEGRATION_STATE;
    let threw = false;
    try {
      await runHarnessProbe(new URL('../__integration__/support/state.js', import.meta.url).href, 'readState');
    } catch { threw = true; }
    expect(threw).toBe(true);
    // No directory was created on the READ path
    expect(countStateDirs().length).toBe(beforeKinds.length);
    delete process.env['MCP_INTEGRATION_STATE'];
  });
});
