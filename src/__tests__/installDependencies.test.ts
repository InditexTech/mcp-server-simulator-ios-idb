// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('native dependency installer', () => {
  let directory: string;
  let bin: string;

  const executable = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  };

  const run = (overrides: Record<string, string> = {}) => spawnSync(
    'bash', [path.resolve('scripts/install_dependencies.sh')], {
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
        TEST_COMPANION: '1.7.6',
        TEST_BREW_FAIL: '',
        ...overrides,
      },
    }
  );

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'idb-installer-'));
    bin = path.join(directory, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(directory, 'cli/libexec/bin'), { recursive: true });
    mkdirSync(path.join(directory, 'cli/bin'), { recursive: true });
    mkdirSync(path.join(directory, 'companion/bin'), { recursive: true });
    executable('uname', 'if [[ "$1" == "-s" ]]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi');
    executable('sw_vers', 'echo "$TEST_MACOS"');
    executable('xcodebuild', 'echo "Xcode $TEST_XCODE"');
    executable('xcrun', 'echo /mock/simctl');
    executable('brew', `
echo "$*" >> "$TEST_ROOT/brew.log"
if [[ "$1" == "install" && -n "$TEST_BREW_FAIL" ]]; then exit 1; fi
case "$1" in
  --prefix)
    if [[ "$2" == "facebook/fb/idb-cli" ]]; then echo "$TEST_ROOT/cli";
    else echo "$TEST_ROOT/companion"; fi ;;
  list) echo "idb-companion $TEST_COMPANION" ;;
esac`);
    executable('idb', 'echo usage');
    executable('idb_companion', 'echo build_date');
    symlinkSync(path.join(bin, 'idb'), path.join(directory, 'cli/bin/idb'));
    symlinkSync(path.join(bin, 'idb_companion'), path.join(directory, 'companion/bin/idb_companion'));
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
    expect(calls).toContain('install facebook/fb/idb');
    expect(calls).toContain('list --versions facebook/fb/idb-companion');
  });

  it.each([
    [{ TEST_OS: 'Linux' }, 'Apple Silicon'],
    [{ TEST_ARCH: 'x86_64' }, 'Apple Silicon'],
    [{ TEST_MACOS: '14.7' }, 'macOS 15'],
    [{ TEST_XCODE: '25.0' }, 'Xcode 26'],
  ])('rejects incompatible prerequisites: %j', (environment, message) => {
    const result = run(environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('stops on a failed Homebrew installation', () => {
    const result = run({ TEST_BREW_FAIL: '1' });
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
    const result = run({ TEST_COMPANION: '1.1.7' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('versions differ');
  });

  it('accepts a Homebrew formula revision of the same companion release', () => {
    expect(run({ TEST_COMPANION: '1.7.6_1' }).status).toBe(0);
  });
});
