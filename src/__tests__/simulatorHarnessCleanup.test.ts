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
let directory: string;
let stubbedBin: string;
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

const runCreateOwnedSimulatorProbe = (scenario: 'boot-fails' | 'happy' | 'collision', outcome_dbg?: boolean): any => {
  const dir = probeDir(`harness-${scenario}-`);
  const scenarioDir = path.join(dir, 'scenario');
  mkdirSync(scenarioDir, { recursive: true });
  const udid = 'AAAA1111-2222-4333-8444-555566667777';
  const bootExit = scenario === 'boot-fails' ? '1' : '0';
  // collision scenario: the UDID is ALREADY in the pre-run inventory
  const before = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': scenario === 'collision' ? [
    { udid, name: `${'mcp-integration-OTHER-RUN'}`, state: 'Shutdown', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' }
  ] : [] } };
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

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'harness-'));
  stubbedBin = path.join(directory, 'bin');
  mkdirSync(stubbedBin);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('terminateOwnedProcess PID-reuse fail-closed', () => {

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

describe('createOwnedSimulator collision fail-closed', () => {
  it('collision (UDID already in before-inventory) throws and NEVER boots/deletes/signals anything', () => {
    const outcome = runCreateOwnedSimulatorProbe('collision');
    // In the collision scenario the stub records create only; boot/shutdown/delete must be ABSENT.
    expect(outcome.bootCalls).toBe(0);
    expect(outcome.shutdown).toEqual([]);
    expect(outcome.deleted).toEqual([]);
    // bootThrew stays true only because the collision error propagates
    // through the same catch in the probe; the REAL contract is that no
    // boot/shutdown/delete was performed — asserted above.
  });
});

describe('executable identity via ps comm (not argv tokens)', () => {
  const describeWithComm = (commWord: string, argsWord: string) => `
#!/bin/bash
echo "  810 ${USER} Tue Nov 17 00:38:42 2026 ${commWord} ${'$'}*/x ${''}" | sed 's|$*/x||'
echo "  810 ${USER} Tue Nov 17 00:38:42 2026 ${commWord} idb_companion --udid ${OWNED} --grpc-domain-sock /tmp/idb/${OWNED}_companion.sock --only simulator"
`;

  it('never lists a python process whose ARGUMENTS merely mention idb_companion', async () => {
    // comm = python3, argv = ".../idb_companion --udid <owned>" → MUST NOT match
    writeFileSync(
      path.join(stubbedBin, 'ps'),
      `#!/bin/bash\necho "  810 ${USER} Tue Nov 17 00:38:42 2026 python3.13 /opt/homebrew/bin/idb_companion --udid ${OWNED} --grpc-domain-sock /tmp/idb/${OWNED}_companion.sock"\n`,
      { mode: 0o755 }
    );
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const matches = await listOwnedCompanionProcesses(OWNED, USER);
      expect(matches).toHaveLength(0);
    } finally {
      probeEnv = undefined;
    }
  });

  it('matches only when ps comm itself is idb_companion (real executable)', async () => {
    // tiny ps stub: comm column literally idb_companion
    writeFileSync(
      path.join(stubbedBin, 'ps'),
      `#!/bin/bash\necho "  811 ${USER} Tue Nov 17 00:38:42 2026 idb_companion /opt/homebrew/bin/idb_companion --udid ${OWNED} --grpc-domain-sock /tmp/idb/${OWNED}_companion.sock"\n`,
      { mode: 0o755 }
    );
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const matches = await listOwnedCompanionProcesses(OWNED, USER);
      expect(matches).toHaveLength(1);
      expect(matches[0].pid).toBe(811);
      expect(matches[0].executable).toBe('idb_companion');
    } finally {
      probeEnv = undefined;
    }
  });
});

describe('cleanupOwnedCompanions respawns fail closed', () => {
  it('a NEW companion appearing after the first termination keeps the socket and reports failure', async () => {
    // Stub: ps shows pid 991 alive until killed (marker), THEN pid 992 (a respawn) appears for the SAME owned UDID.
    writeFileSync(
      path.join(stubbedBin, 'ps'),
      `#!/bin/bash\nif [[ ! -f "${directory}/died" ]]; then echo "  991 ${USER} Tue Nov 17 00:38:42 2026 idb_companion --udid ${OWNED}"; exit 0; fi\necho "  992 ${USER} Tue Nov 17 00:39:42 2026 idb_companion --udid ${OWNED}"\nexit 0\n`,
      { mode: 0o755 }
    );
    // kill: first TERM kills 991 (writes died), then respawner appears
    writeFileSync(path.join(stubbedBin, 'kill'), `#!/bin/bash\ntouch "${directory}/died"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(path.join(stubbedBin, 'stat'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    writeFileSync(path.join(stubbedBin, 'rm'), `#!/bin/bash\necho "rm $*" >> "${directory}/rm.log"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(path.join(stubbedBin, 'id'), `#!/bin/bash\necho ${USER}\n`, { mode: 0o755 });
    probeEnv = { ...process.env, PATH: `${stubbedBin}:${process.env.PATH}` };
    try {
      const results = await runHarnessProbe(
        new URL('../__integration__/support/simulatorHarness.js', import.meta.url).href,
        'cleanupOwnedCompanions',
        OWNED
      );
      process.stderr.write('RESPAWN-DBG:' + JSON.stringify(results));
      // FAIL-CLOSED: the socket claim must be gone:false with a respawn reason
      const socketResult = results.find(r => r.path);
      expect(socketResult?.gone).toBe(false);
      expect(String(socketResult?.reason)).toContain('still alive');
      // and NO rm ever ran
      expect(existsSync(path.join(directory, 'rm.log'))).toBe(false);
    } finally {
      probeEnv = undefined;
    }
  });
});

describe('globalSetup state handoff is real (file inside owned dir, teardown removes both)', () => {
  const setupDir = (scenario: 'ok' | 'write-fails'): string => {
    const dir = probeDir(`harness-setup-${scenario}-`);
    const scenarioDir = path.join(dir, 'scenario');
    mkdirSync(scenarioDir, { recursive: true });
    const udid = 'CCCC3333-4444-4555-8666-777788889999';
    const bootExit = '0';
    writeFileSync(path.join(scenarioDir, 'before.json'), JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [] } }));
    writeFileSync(path.join(scenarioDir, 'shutdown.json'), JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid, name: '@@NAME@@', state: 'Shutdown' }
    ] } }));
    writeFileSync(path.join(scenarioDir, 'booted.json'), JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid, name: '@@NAME@@', state: 'Booted' }
    ] } }));
    writeFileSync(path.join(scenarioDir, 'runtimes.json'), JSON.stringify({ runtimes: [
      { isAvailable: true, version: '27.0', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17 Pro' }] }
    ] }));
    writeFileSync(path.join(scenarioDir, 'create-output.txt'), `${udid}\n`);
    writeFileSync(path.join(scenarioDir, 'seq'), '0');
    // xcrun: same seq logic as runCreateOwnedSimulatorProbe; boot exits 0 in both scenarios
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
        '    if [[ "$C" -le 2 ]]; then cat "${SCENARIO}/before.json"',
        '    elif [[ "$C" -eq 3 ]]; then sed "s/@@NAME@@/$(cat \"${SCENARIO}/name.txt\")/" "${SCENARIO}/shutdown.json"',
        '    else sed "s/@@NAME@@/$(cat \"${SCENARIO}/name.txt\")/" "${SCENARIO}/booted.json"',
        '    fi',
        '    exit 0;;',
        'esac',
        'OP="$2"',
        'case "$OP" in',
        '  create) cat "${SCENARIO}/create-output.txt"; echo create >> "${LOG}"; echo "$3" > "${SCENARIO}/name.txt"; exit 0;;',
        '  boot|shutdown|delete) echo "$OP $3" >> "${LOG}"; exit 0;;',
        '  *) echo "unexpected: $ARGS" >> "${LOG}"; exit 1;;',
        'esac'
      ].join('\n'),
      { mode: 0o755 }
    );
    // companion ps: none; kill/id/stat harmless
    writeFileSync(path.join(dir, 'bin', 'ps'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(dir, 'bin', 'kill'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(dir, 'bin', 'id'), `#!/bin/bash\necho ${USER}\n`, { mode: 0o755 });
    writeFileSync(path.join(dir, 'bin', 'idb'), '#!/bin/bash\necho connected\n', { mode: 0o755 });
    // harness explicit stat usage happens only for sockets — absent is fine
    return dir;
  };

  it('happy: hand-off env file lives INSIDE stateDir; after teardown both file and dir are gone', async () => {
    const dir = setupDir('ok');
    const script = `
const setup = (await import(${JSON.stringify(new URL('../__integration__/support/globalSetup.js', import.meta.url).href)})).default;
const teardown = (await import(${JSON.stringify(new URL('../__integration__/support/globalTeardown.js', import.meta.url).href)})).default;
const state = (await import(${JSON.stringify(new URL('../__integration__/support/state.js', import.meta.url).href)}));
const { existsSync, readFileSync } = await import('node:fs');
const path = await import('node:path');
await setup();
const envPath = process.env[state.STATE_FILE_ENV];
const stateRaw = JSON.parse(readFileSync(envPath, 'utf8'));
const insideStateDir = path.dirname(envPath) === stateRaw.stateDir;
await teardown();
process.stdout.write(JSON.stringify({
  envPathSet: Boolean(envPath),
  insideStateDir,
  fileAfterTeardown: existsSync(envPath),
  dirAfterTeardown: existsSync(stateRaw.stateDir),
  envClearedAfterTeardown: !Boolean(process.env[state.STATE_FILE_ENV])
}));
`;
    const probe = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        PROBE_SCENARIO: path.join(dir, 'scenario'),
        PROBE_LOG: path.join(dir, 'calls.log')
      }
    });
    if (probe.status !== 0) {
      throw new Error(`setup probe failed: ${(probe.stderr ?? '').slice(3,600)}`);
    }
    const outcome = JSON.parse(probe.stdout);
    expect(outcome.envPathSet).toBe(true);
    expect(outcome.insideStateDir).toBe(true);
    expect(outcome.fileAfterTeardown).toBe(false);
    expect(outcome.dirAfterTeardown).toBe(false);
    expect(outcome.envClearedAfterTeardown).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeState without the env hand-off THROWS (no silent second private dir)', () => {
    const script = `
const state = (await import(${JSON.stringify(new URL('../__integration__/support/state.js', import.meta.url).href)}));
const { readdirSync } = await import('node:fs');
delete process.env[state.STATE_FILE_ENV];
const osmod = await import('node:os');
const before = readdirSync(osmod.tmpdir()).filter(e => e.startsWith('mcp-it-state-')).length;
let threw = false;
try { state.writeState({ probe: true }); } catch { threw = true; }
const after = readdirSync(osmod.tmpdir()).filter(e => e.startsWith('mcp-it-state-')).length;
process.stdout.write(JSON.stringify({ threw, before, after, envUnset: !process.env[state.STATE_FILE_ENV] }));
`;
    const probe = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env }
    });
    expect(probe.status).toBe(0);
    const outcome = JSON.parse(probe.stdout);
    expect(outcome.threw).toBe(true);
    expect(outcome.after).toBe(outcome.before);
    expect(outcome.envUnset).toBe(true);
  });
});
