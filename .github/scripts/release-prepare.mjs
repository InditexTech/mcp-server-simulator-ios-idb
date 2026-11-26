#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025 Industria de Diseño Textil S.A. INDITEX
//
// SPDX-License-Identifier: Apache-2.0

// Prepares a release locally, so the maintainer reviews and signs the commit:
//
//   GH_TOKEN=$(gh auth token) npm run release:prepare -- 2.2.0
//
// 1. Fills `## [Unreleased]` of CHANGELOG.md from the PRs merged since the
//    last release tag (changelog-from-prs.mjs, range mode).
// 2. Turns it into `## [2.2.0] - <today>`.
// 3. Sets the version in package.json and package-lock.json.
// 4. For minor and major releases, seeds docs/release-notes/2.2.0.md.
//
// It refuses to run on a dirty working tree, so the resulting diff is only
// the release. Every file is computed first and written only if all of them
// could be, so a failure leaves the tree untouched. Nothing is committed,
// tagged or published.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clientFromEnv, cutRelease, defaultRepo, generateRange, lastReleaseTag, renderRangeReport } from './changelog-from-prs.mjs';
import { parseRelease, planReleaseNotes } from './release-notes-seed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) {
    throw new Error(`Expected a version like 1.2.3, got "${version}".`);
  }
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

// Minor and major releases get release notes; patch releases do not.
export function needsReleaseNotes(version) {
  return parseVersion(version)[2] === 0;
}

// Sets `version` in package.json or package-lock.json text, keeping the
// formatting (two-space indent, trailing newline).
export function setPackageVersion(text, version, { lockfile = false } = {}) {
  const json = JSON.parse(text);
  json.version = version;
  if (lockfile) {
    if (!json.packages?.['']) {
      throw new Error('package-lock.json has no root package entry.');
    }
    json.packages[''].version = version;
  }
  return `${JSON.stringify(json, null, 2)}\n`;
}

// Local date of the maintainer, not UTC.
export function today(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      from: { type: 'string' },
      repo: { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const [version] = positionals;
  parseVersion(version);
  const date = values.date ?? today();

  if (!values['allow-dirty'] && git(['status', '--porcelain']) !== '') {
    throw new Error('The working tree has changes; commit or stash them first (or pass --allow-dirty).');
  }
  const from = values.from ?? lastReleaseTag('HEAD');
  if (compareVersions(version, from) <= 0) {
    throw new Error(`${version} is not newer than the last release, ${from}.`);
  }

  const changelog = resolve(ROOT, 'CHANGELOG.md');
  const repo = values.repo ?? defaultRepo();
  // dryRun: the entries are applied in memory only; see the writes below.
  const range = await generateRange({ client: clientFromEnv(repo), repo, from, changelog, dryRun: true });
  console.log(renderRangeReport(range));

  const writes = [[changelog, cutRelease(range.applied.text, version, date)]];
  for (const [file, lockfile] of [
    ['package.json', false],
    ['package-lock.json', true],
  ]) {
    const path = resolve(ROOT, file);
    writes.push([path, setPackageVersion(readFileSync(path, 'utf8'), version, { lockfile })]);
  }
  const steps = [`CHANGELOG.md: [Unreleased] is now [${version}] - ${date}.`, `package.json, package-lock.json: ${version}.`];
  if (needsReleaseNotes(version)) {
    const notes = planReleaseNotes(parseRelease(writes[0][1], version));
    if (notes) {
      writes.push([notes.path, notes.text], [notes.indexPath, notes.indexText]);
      steps.push(`docs/release-notes/${version}.md: seeded and listed in the index; replace every TODO.`);
    } else {
      steps.push(`docs/release-notes/${version}.md already exists; left as is.`);
    }
  }
  for (const [path, text] of writes) {
    writeFileSync(path, text);
  }

  console.log(
    [
      '',
      `Prepared ${version}:`,
      ...steps.map((step) => `- ${step}`),
      '',
      'Next:',
      `1. Review the diff, then commit it signed on a release branch: git switch -c chore/release-${version} && git commit -S -s -am "chore(release): ${version}"`,
      '2. Open the release PR. Merge it only if nothing else was merged into main since you ran this; otherwise run it again on the updated branch.',
      `3. Tag the merge commit of the release PR and publish: gh release create ${version} --target <merge-sha> --title ${version} --notes-file <(node .github/scripts/changelog-from-prs.mjs --section ${version})`,
    ].join('\n')
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
