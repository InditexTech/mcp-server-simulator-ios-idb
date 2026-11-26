#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025 Industria de Diseño Textil S.A. INDITEX
//
// SPDX-License-Identifier: Apache-2.0

// Seeds a release-notes page from the `## [X.Y.Z]` section of CHANGELOG.md,
// so writing the notes starts from an edit, not a blank page. Adapted from
// InditexTech/weavejs (.github/scripts/release-notes-seed.mjs), in Markdown.
//
//   node .github/scripts/release-notes-seed.mjs 2.2.0            # print to stdout
//   node .github/scripts/release-notes-seed.mjs 2.2.0 --write    # write the page
//
// Added and Changed entries become `###` sections under `## Changes`; Fixed
// and Security entries become bullet lists. Every `TODO` is a place for a
// human to write. `--write` refuses to overwrite an existing page and adds the
// page to docs/release-notes/README.md.
//
// Release notes are written for minor and major releases; patch releases only
// get the changelog.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');
export const PAGES_DIR = resolve(ROOT, 'docs/release-notes');
export const INDEX_MARKER = '<!-- release-notes-index -->';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ENTRY = /^- \[([^\]]+)\]\(([^)]+)\) (.*)$/;

export function parseRelease(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    return null;
  }

  const date = /- (\d{4})-(\d{2})-(\d{2})/.exec(lines[start]);
  const sections = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (line.startsWith('### ')) {
      current = line.slice(4).trim();
      sections[current] = [];
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry && current) {
      sections[current].push({ ref: entry[1], url: entry[2], title: entry[3] });
    }
  }

  return {
    version,
    date: date ? { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) } : null,
    sections,
  };
}

export function formatDate(date) {
  if (!date) {
    return 'TODO';
  }
  return `${MONTHS[date.month - 1]} ${date.day}, ${date.year}`;
}

function link(entry) {
  return `[${entry.ref}](${entry.url})`;
}

export function renderSkeleton(release) {
  const { version, date, sections } = release;
  const out = [];

  out.push(`# v${version}`);
  out.push('');
  out.push(`_Released ${formatDate(date)}._`);
  out.push('');
  out.push('TODO short paragraph: what this release is about and who should care.');
  out.push('');

  const featured = [...(sections.Added ?? []), ...(sections.Changed ?? [])];
  if (featured.length > 0) {
    out.push('## Changes');
    out.push('');
    for (const entry of featured) {
      out.push(`### ${entry.title}`);
      out.push('');
      out.push('TODO what changed for users, with a short example if it helps.');
      out.push('');
      out.push(`See ${link(entry)}.`);
      out.push('');
    }
  }

  for (const [name, heading] of [
    ['Fixed', 'Fixes'],
    ['Security', 'Security'],
    ['Deprecated', 'Deprecated'],
    ['Removed', 'Removed'],
  ]) {
    const entries = sections[name] ?? [];
    if (entries.length === 0) {
      continue;
    }
    out.push(`## ${heading}`);
    out.push('');
    for (const entry of entries) {
      out.push(`- ${entry.title} (${link(entry)})`);
    }
    out.push('');
  }

  out.push('## Migration steps');
  out.push('');
  out.push('TODO list upgrade steps, or delete this section if there are none.');

  return `${out.join('\n')}\n`;
}

// Adds `- [vX.Y.Z](X.Y.Z.md) - <date>` right after the index marker, newest
// first. Does nothing if the page is already listed.
export function addToIndex(index, release) {
  const line = `- [v${release.version}](${release.version}.md) - ${formatDate(release.date)}`;
  if (index.includes(`](${release.version}.md)`)) {
    return index;
  }
  if (!index.includes(INDEX_MARKER)) {
    throw new Error(`docs/release-notes/README.md has no "${INDEX_MARKER}" line.`);
  }
  return index.replace(INDEX_MARKER, `${INDEX_MARKER}\n${line}`);
}

// The page and the updated index, without writing anything. Returns null if
// the page already exists (it is never overwritten). Throws if the index has
// no marker, before anything is written.
export function planReleaseNotes(release, { pagesDir = PAGES_DIR } = {}) {
  const path = resolve(pagesDir, `${release.version}.md`);
  if (existsSync(path)) {
    return null;
  }
  const indexPath = resolve(pagesDir, 'README.md');
  return {
    path,
    text: renderSkeleton(release),
    indexPath,
    indexText: addToIndex(readFileSync(indexPath, 'utf8'), release),
  };
}

// Writes the page and lists it in the index. Returns the page path, or null
// if the page already exists.
export function writeReleaseNotes(release, options) {
  const plan = planReleaseNotes(release, options);
  if (!plan) {
    return null;
  }
  writeFileSync(plan.path, plan.text);
  writeFileSync(plan.indexPath, plan.indexText);
  return plan.path;
}

export function main(argv) {
  const [version] = argv.filter((arg) => !arg.startsWith('--'));
  const write = argv.includes('--write');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: release-notes-seed.mjs <X.Y.Z> [--write]');
    return 2;
  }

  const release = parseRelease(readFileSync(CHANGELOG, 'utf8'), version);
  if (!release) {
    console.error(`No "## [${version}]" section in CHANGELOG.md`);
    return 1;
  }

  if (!write) {
    process.stdout.write(renderSkeleton(release));
    return 0;
  }

  const target = writeReleaseNotes(release);
  if (!target) {
    console.error(`docs/release-notes/${version}.md already exists; not overwriting`);
    return 1;
  }
  console.log(`Wrote ${target}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
