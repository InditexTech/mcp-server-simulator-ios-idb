// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('native dependency installer', () => {
  let directory: string;
  let bin: string;

  const executable = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  };

  const execute = (command: string, args: string[], overrides: Record<string, string> = {}) => spawnSync(
    command, args, {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_ROOT: directory,
        TEST_OS: 'Darwin',
        TEST_ARCH: 'arm64',
        TEST_MACOS: '15.0',
        TEST_XCODE: '26.0',
        TEST_CLIENT: '1.7.6',
        TEST_INSTALLED_COMPANIONS: '1.7.6',
        TEST_TRUST_SUPPORTED: '1',
        TEST_BREW_FAIL: '',
        TEST_INITIAL_TAP: '',
        ...overrides,
      },
    }
  );

  const run = (overrides: Record<string, string> = {}) => execute(
    'bash', [path.resolve('scripts/install_dependencies.sh')], overrides
  );

  const writeReceipts = (tap: string) => {
    for (const prefix of ['kegs/idb', 'cli', 'companion']) {
      mkdirSync(path.join(directory, prefix), { recursive: true });
      writeFileSync(path.join(directory, prefix, 'INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap } }, null, 2));
    }
  };

  const selectCompanion = (version: string) => {
    const keg = path.join(directory, 'Cellar/idb-companion', version);
    mkdirSync(path.join(keg, 'bin'), { recursive: true });
    symlinkSync(path.join(bin, 'idb_companion'), path.join(keg, 'bin/idb_companion'));
    const prefix = path.join(directory, 'companion');
    if (existsSync(prefix)) unlinkSync(prefix);
    symlinkSync(keg, prefix);
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'idb-installer-'));
    bin = path.join(directory, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(directory, 'cli/libexec/bin'), { recursive: true });
    mkdirSync(path.join(directory, 'cli/bin'), { recursive: true });
    executable('uname', 'if [[ "$1" == "-s" ]]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi');
    executable('sw_vers', 'echo "$TEST_MACOS"');
    executable('xcodebuild', 'if [[ "$TEST_XCODE" == "missing" ]]; then exit 1; fi\necho "Xcode $TEST_XCODE"');
    executable('xcrun', '[[ "$*" == "--find simctl" ]]\nif [[ "${TEST_SIMCTL_MISSING:-}" == "1" ]]; then exit 1; fi\necho /mock/simctl');
    executable('brew', `
echo "$*" >> "$TEST_ROOT/brew.log"
if [[ "$1" == "$TEST_BREW_FAIL" ]]; then
  echo "Simulated Homebrew $1 failure" >&2
  exit 1
fi
STATE="$TEST_ROOT/tap_state"
[[ -f "$STATE" ]] || printf '%s' "\${TEST_INITIAL_TAP:-}" > "$STATE"
case "$*" in
  'tap') cat "$STATE"; [[ ! -s "$STATE" ]] || echo ;;
  'tap facebook/fb')
    if [[ "$(cat "$STATE")" == "facebook/fb" ]]; then
      if [[ -f "$TEST_ROOT/trusted" ]]; then
        echo 'Refusing automatic redirect: meta/fb formulae already trusted.' >&2
        exit 1
      fi
      printf 'meta/fb' > "$STATE"
    else
      printf 'facebook/fb' > "$STATE"
    fi ;;
  'tap meta/fb') printf 'meta/fb' > "$STATE" ;;
  'command trust') [[ "$TEST_TRUST_SUPPORTED" == "1" ]] ;;
  'trust --formula meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion')
    [[ "$TEST_TRUST_SUPPORTED" == "1" && "$(cat "$STATE")" == "meta/fb" ]]
    touch "$TEST_ROOT/trusted" ;;
  'install meta/fb/idb')
    [[ "$(cat "$STATE")" == "meta/fb" ]]
    if grep -q '"tap": "facebook/fb"' "$TEST_ROOT/kegs/idb/INSTALL_RECEIPT.json" 2> /dev/null; then
      printf 'Error: idb was installed from the facebook/fb tap\\nbut you are trying to install it from the meta/fb tap.\\n' >&2
      exit 1
    fi
    if [[ "$TEST_TRUST_SUPPORTED" == "1" && ! -f "$TEST_ROOT/trusted" ]]; then
      echo 'Refusing to load formula meta/fb/idb-cli from untrusted tap meta/fb.' >&2
      exit 1
    fi ;;
  '--prefix meta/fb/idb')
    if [[ "$TEST_TRUST_SUPPORTED" == "1" && ! -f "$TEST_ROOT/trusted" ]]; then
      echo 'Refusing to load formula meta/fb/idb from untrusted tap meta/fb.' >&2
      exit 1
    fi
    echo "$TEST_ROOT/kegs/idb" ;;
  '--prefix meta/fb/idb-cli') echo "$TEST_ROOT/cli" ;;
  '--prefix meta/fb/idb-companion') echo "$TEST_ROOT/companion" ;;
  'list --versions meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion')
    echo "idb 1.7.6"
    echo "idb-cli $TEST_CLIENT"
    echo "idb-companion $TEST_INSTALLED_COMPANIONS" ;;
  *) echo "Unexpected Homebrew command: $*" >&2; exit 2 ;;
esac`);
    executable('idb', '[[ "$*" == "--help" ]]\nif [[ "${TEST_IDB_FAIL:-}" == "1" ]]; then exit 1; fi\necho usage');
    executable('idb_companion', '[[ "$*" == "--version" ]]\nif [[ "${TEST_COMPANION_FAIL:-}" == "1" ]]; then exit 1; fi\necho build_date');
    symlinkSync(path.join(bin, 'idb'), path.join(directory, 'cli/bin/idb'));
    selectCompanion('1.7.6');
    writeFileSync(path.join(directory, 'cli/libexec/bin/python'), '#!/bin/bash\necho "$TEST_CLIENT"\n', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('installs the unified metapackage and verifies both managed executables without a project venv', () => {
    const result = run({ VIRTUAL_ENV: '' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('idb dependencies installed successfully');
    const calls = readFileSync(path.join(directory, 'brew.log'), 'utf8');
    expect(calls).toContain('install meta/fb/idb');
    expect(calls).toContain('trust --formula meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion');
    expect(calls).not.toContain('trust --tap');
    expect(calls.indexOf('trust --formula')).toBeLessThan(calls.indexOf('install meta/fb/idb'));
  });

  it('skips tapping when meta/fb is already tapped and restores formula trust', () => {
    const result = run({ TEST_INITIAL_TAP: 'meta/fb' });
    expect(result.status).toBe(0);
    const calls = readFileSync(path.join(directory, 'brew.log'), 'utf8');
    expect(calls).not.toContain('tap meta/fb');
    expect(calls).toContain('trust --formula meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion');
    expect(calls).toContain('install meta/fb/idb');
  });

  it('migrates a legacy facebook/fb tap to meta/fb before declaring trust', () => {
    const result = run({ TEST_INITIAL_TAP: 'facebook/fb' });
    expect(result.status).toBe(0);
    const calls = readFileSync(path.join(directory, 'brew.log'), 'utf8');
    expect(calls).toContain('tap facebook/fb');
    expect(calls.indexOf('tap facebook/fb')).toBeLessThan(calls.indexOf('trust --formula'));
    expect(calls.indexOf('trust --formula')).toBeLessThan(calls.indexOf('install meta/fb/idb'));
    expect(readFileSync(path.join(directory, 'tap_state'), 'utf8')).toBe('meta/fb');
  });

  it('installs when existing receipts already record the meta/fb tap', () => {
    writeReceipts('meta/fb');
    const result = run({ TEST_INITIAL_TAP: 'meta/fb' });
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(directory, 'brew.log'), 'utf8')).toContain('install meta/fb/idb');
  });

  it('models Homebrew refusing a formula whose receipt records the legacy tap', () => {
    writeReceipts('facebook/fb');
    expect(execute(path.join(bin, 'brew'), ['tap', 'meta/fb']).status).toBe(0);
    const result = execute(path.join(bin, 'brew'), ['install', 'meta/fb/idb']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('idb was installed from the facebook/fb tap');
  });

  it('fails fast with migration commands when installed receipts record the legacy facebook/fb tap', () => {
    writeReceipts('facebook/fb');
    const result = run({ TEST_INITIAL_TAP: 'meta/fb' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('idb is installed from the facebook/fb tap, not meta/fb');
    expect(result.stderr).toContain('brew uninstall idb idb-cli idb-companion');
    const calls = readFileSync(path.join(directory, 'brew.log'), 'utf8');
    expect(calls).not.toContain('uninstall');
    expect(calls).not.toContain('install meta/fb/idb');
    expect(result.stdout).not.toContain('installed successfully');
  });

  it('models the CI failure when installing before formula trust is declared', () => {
    expect(execute(path.join(bin, 'brew'), ['tap', 'meta/fb']).status).toBe(0);
    const result = execute(path.join(bin, 'brew'), ['install', 'meta/fb/idb']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('untrusted tap');
  });

  it('does not let unknown Homebrew commands silently succeed in the test double', () => {
    expect(execute(path.join(bin, 'brew'), ['unexpected-command']).status).toBe(2);
  });

  it('supports older Homebrew without the trust command', () => {
    const result = run({ TEST_TRUST_SUPPORTED: '0' });
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(directory, 'brew.log'), 'utf8')).not.toContain('trust --formula');
  });

  it('stops before installation when declaring formula trust fails', () => {
    const result = run({ TEST_BREW_FAIL: 'trust' });
    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(directory, 'brew.log'), 'utf8')).not.toContain('install meta/fb/idb');
  });

  it.each([
    [{ TEST_OS: 'Linux' }, 'Apple Silicon'],
    [{ TEST_ARCH: 'x86_64' }, 'Apple Silicon'],
    [{ TEST_MACOS: '14.7' }, 'macOS 15'],
    [{ TEST_XCODE: '25.0' }, 'Xcode 26'],
    [{ TEST_XCODE: 'missing' }, 'Select a full Xcode'],
  ])('rejects incompatible prerequisites: %j', (environment, message) => {
    const result = run(environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(path.join(directory, 'brew.log'))).toBe(false);
  });

  it.each(['tap', 'install', '--prefix', 'list'])('stops on a failed Homebrew %s command', (command) => {
    const result = run({ TEST_BREW_FAIL: command });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('installed successfully');
  });

  it('stops before installing if simctl cannot be found', () => {
    expect(run({ TEST_SIMCTL_MISSING: '1' }).status).not.toBe(0);
    expect(existsSync(path.join(directory, 'brew.log'))).toBe(false);
  });

  it.each(['idb', 'idb_companion'])('rejects a missing %s executable', (name) => {
    unlinkSync(path.join(bin, name));
    const result = run({ PATH: `${bin}:/usr/bin:/bin` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${name} is missing from PATH`);
  });

  it.each(['TEST_IDB_FAIL', 'TEST_COMPANION_FAIL'])('rejects an unusable installed binary: %s', (variable) => {
    const result = run({ [variable]: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('installed successfully');
  });

  it('rejects a shadowing executable from an older installation', () => {
    const shadow = path.join(directory, 'old-venv/bin');
    mkdirSync(shadow, { recursive: true });
    writeFileSync(path.join(shadow, 'idb'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const result = run({ PATH: `${shadow}:${bin}:${process.env.PATH}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('shadows Homebrew');
  });

  it('rejects mismatched client and companion releases', () => {
    selectCompanion('1.1.7');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('versions differ');
  });

  it('accepts a Homebrew formula revision of the same companion release', () => {
    selectCompanion('1.7.6_1');
    expect(run().status).toBe(0);
  });

  it('checks the active companion keg, not the last version in the installed inventory', () => {
    expect(run({ TEST_INSTALLED_COMPANIONS: '1.1.7 1.7.6 1.7.7' }).status).toBe(0);
  });
});
