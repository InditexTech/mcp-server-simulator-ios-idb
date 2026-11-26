// SPDX-FileCopyrightText: 2025 Industria de Diseño Textil S.A. INDITEX
//
// SPDX-License-Identifier: Apache-2.0

// Run with: npm run test:scripts

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { addToIndex, INDEX_MARKER, parseRelease, planReleaseNotes, renderSkeleton, writeReleaseNotes } from './release-notes-seed.mjs';
import { compareVersions, needsReleaseNotes, parseVersion, setPackageVersion, today } from './release-prepare.mjs';

const URL = 'https://github.com/InditexTech/mcp-server-simulator-ios-idb';

const CHANGELOG = `# Changelog

## [Unreleased]

## [2.2.0] - 2026-12-03

### Added

- [#19](${URL}/issues/19) Support tvOS simulators

### Fixed

- [#95](${URL}/pull/95) Return screenshots as image content

## [2.1.0] - 2026-11-24

### Added

- [#7](${URL}/issues/7) Older entry
`;

describe('parseRelease', () => {
  it('reads the date and the entries of one section only', () => {
    const release = parseRelease(CHANGELOG, '2.2.0');

    assert.deepEqual(release.date, { year: 2026, month: 12, day: 3 });
    assert.deepEqual(release.sections.Added, [{ ref: '#19', url: `${URL}/issues/19`, title: 'Support tvOS simulators' }]);
    assert.deepEqual(release.sections.Fixed, [{ ref: '#95', url: `${URL}/pull/95`, title: 'Return screenshots as image content' }]);
  });

  it('returns null for a missing version', () => {
    assert.equal(parseRelease(CHANGELOG, '9.9.9'), null);
  });
});

describe('renderSkeleton', () => {
  it('gives Added/Changed their own section and lists fixes', () => {
    const page = renderSkeleton(parseRelease(CHANGELOG, '2.2.0'));

    assert.match(page, /^# v2\.2\.0\n\n_Released December 3, 2026\._\n/);
    assert.match(page, /## Changes\n\n### Support tvOS simulators\n\nTODO .*\n\nSee \[#19\]\(.*\/issues\/19\)\.\n/);
    assert.match(page, /## Fixes\n\n- Return screenshots as image content \(\[#95\]\(.*\/pull\/95\)\)\n/);
    assert.match(page, /## Migration steps\n\nTODO/);
    assert.doesNotMatch(page, /Older entry/);
  });
});

describe('addToIndex / writeReleaseNotes', () => {
  const release = parseRelease(CHANGELOG, '2.2.0');

  it('adds the page right after the marker, once', () => {
    const index = `# Release notes\n\n${INDEX_MARKER}\n- [v2.1.0](2.1.0.md) - November 24, 2026\n`;

    const updated = addToIndex(index, release);

    assert.equal(
      updated,
      `# Release notes\n\n${INDEX_MARKER}\n- [v2.2.0](2.2.0.md) - December 3, 2026\n- [v2.1.0](2.1.0.md) - November 24, 2026\n`
    );
    assert.equal(addToIndex(updated, release), updated);
  });

  it('fails without the marker', () => {
    assert.throws(() => addToIndex('# Release notes\n', release), /release-notes-index/);
  });

  it('writes the page and the index, and never overwrites a page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
    writeFileSync(join(dir, 'README.md'), `# Release notes\n\n${INDEX_MARKER}\n`);

    assert.equal(writeReleaseNotes(release, { pagesDir: dir }), join(dir, '2.2.0.md'));
    assert.match(readFileSync(join(dir, '2.2.0.md'), 'utf8'), /^# v2\.2\.0/);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /\[v2\.2\.0\]\(2\.2\.0\.md\)/);

    writeFileSync(join(dir, '2.2.0.md'), 'edited by hand\n');
    assert.equal(writeReleaseNotes(release, { pagesDir: dir }), null);
    assert.equal(readFileSync(join(dir, '2.2.0.md'), 'utf8'), 'edited by hand\n');
  });
});

describe('release-prepare helpers', () => {
  it('parses and compares versions numerically', () => {
    assert.deepEqual(parseVersion('2.10.0'), [2, 10, 0]);
    assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
    assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
    assert.throws(() => parseVersion('v2.1.0'), /like 1\.2\.3/);
    assert.throws(() => parseVersion(undefined), /like 1\.2\.3/);
  });

  it('asks for release notes on minor and major releases only', () => {
    assert.equal(needsReleaseNotes('3.0.0'), true);
    assert.equal(needsReleaseNotes('2.2.0'), true);
    assert.equal(needsReleaseNotes('2.2.1'), false);
  });

  it('sets the version in package.json and in both places of the lockfile', () => {
    const pkg = setPackageVersion('{\n  "name": "x",\n  "version": "1.0.1"\n}\n', '2.2.0');
    assert.equal(pkg, '{\n  "name": "x",\n  "version": "2.2.0"\n}\n');

    const lock = JSON.parse(
      setPackageVersion(JSON.stringify({ name: 'x', version: '1.0.1', packages: { '': { version: '1.0.1' } } }), '2.2.0', {
        lockfile: true,
      })
    );
    assert.equal(lock.version, '2.2.0');
    assert.equal(lock.packages[''].version, '2.2.0');
    assert.throws(() => setPackageVersion('{"version":"1.0.0"}', '2.2.0', { lockfile: true }), /root package/);
  });

  it('dates the release with the local day, not UTC', () => {
    assert.equal(today(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
    assert.equal(today(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  });
});

describe('planReleaseNotes', () => {
  it('fails on an index without the marker before writing anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
    writeFileSync(join(dir, 'README.md'), '# Release notes\n');

    assert.throws(() => planReleaseNotes(parseRelease(CHANGELOG, '2.2.0'), { pagesDir: dir }), /release-notes-index/);
    assert.equal(existsSync(join(dir, '2.2.0.md')), false);
  });
});
