// SPDX-FileCopyrightText: 2025 Industria de Diseño Textil S.A. INDITEX
//
// SPDX-License-Identifier: Apache-2.0

// Run with: npm run test:scripts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyEntries,
  buildEntries,
  compareWithReleased,
  createGitHubClient,
  cutRelease,
  dropReleased,
  formatEntry,
  formatPullRequestEntry,
  issueEntryTitle,
  normalizeInvisibleWhitespace,
  normalizeTitle,
  parseConventionalTitle,
  pullRequestsForCommits,
  releasedSection,
  releasedUrls,
  renderPullRequestReport,
  sectionFor,
  sectionText,
  INTERNAL_TYPES,
  TYPE_SECTIONS,
  wrapTitle,
  wrapTitles,
} from './changelog-from-prs.mjs';

const REPO = 'InditexTech/mcp-server-simulator-ios-idb';

function issue(number, title, labels = []) {
  return { number, title, labels, repo: REPO, url: `https://github.com/${REPO}/issues/${number}` };
}

function pr(
  number,
  issues,
  { title = 'feat: something', labels = [], author = 'someone', mergedAt = '2026-10-01T00:00:00Z', base = 'main' } = {}
) {
  return {
    number,
    title,
    url: `https://github.com/${REPO}/pull/${number}`,
    merged: true,
    mergedAt,
    baseRefName: base,
    headRefOid: 'abc123',
    author,
    labels,
    issues,
  };
}

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

## [5.7.1] - 2026-10-27

### Fixed

- [#1246](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1246) Old entry

[Unreleased]: https://github.com/InditexTech/mcp-server-simulator-ios-idb/compare/5.7.1...HEAD
`;

describe('sectionFor', () => {
  it('applies the rules in order, first match wins', () => {
    assert.deepEqual(sectionFor(['bug', 'security']), { section: 'Security', guessed: false });
    assert.deepEqual(sectionFor(['enhancement', 'bug']), { section: 'Fixed', guessed: false });
    assert.deepEqual(sectionFor(['kind/feature']), { section: 'Added', guessed: false });
    assert.deepEqual(sectionFor(['Enhancement']), { section: 'Added', guessed: false });
  });

  it('falls back to Changed and flags the guess', () => {
    assert.deepEqual(sectionFor([]), { section: 'Changed', guessed: true });
    assert.deepEqual(sectionFor(['documentation']), { section: 'Changed', guessed: true });
    assert.deepEqual(sectionFor([], 'docs'), { section: 'Changed', guessed: true });
    assert.deepEqual(sectionFor([], null), { section: 'Changed', guessed: true });
  });

  it('falls back to the Conventional Commit type, after the label rules', () => {
    assert.deepEqual(sectionFor([], 'feat'), { section: 'Added', guessed: false });
    assert.deepEqual(sectionFor([], 'fix'), { section: 'Fixed', guessed: false });
    assert.deepEqual(sectionFor([], 'perf'), { section: 'Changed', guessed: false });
    assert.deepEqual(sectionFor(['bug'], 'feat'), { section: 'Fixed', guessed: false });
  });
});

describe('parseConventionalTitle', () => {
  it('strips the type, with or without scope and breaking mark, and capitalises', () => {
    assert.deepEqual(parseConventionalTitle('fix(idb): report failures'), { type: 'fix', subject: 'Report failures' });
    assert.deepEqual(parseConventionalTitle('feat!: drop Node 18'), { type: 'feat', subject: 'Drop Node 18' });
    assert.deepEqual(parseConventionalTitle('Feat(parser)!: new thing'), { type: 'feat', subject: 'New thing' });
  });

  it('returns no type for a title without prefix, normalising whitespace', () => {
    assert.deepEqual(parseConventionalTitle('  Plain   title\u00A0here '), { type: null, subject: 'Plain title here' });
  });
});

describe('issueEntryTitle', () => {
  it('drops a Proposal: or Conventional Commit prefix', () => {
    assert.equal(issueEntryTitle('Proposal: support tvOS'), 'Support tvOS');
    assert.equal(issueEntryTitle('perf(idb): cache the UDID lookup'), 'Cache the UDID lookup');
    assert.equal(issueEntryTitle('chore: tidy'), 'Tidy');
  });

  it('leaves other titles verbatim apart from whitespace', () => {
    assert.equal(issueEntryTitle('Tap fails  on foldables'), 'Tap fails on foldables');
    assert.equal(issueEntryTitle('Note: tap fails'), 'Note: tap fails');
  });
});

describe('formatPullRequestEntry / normalizeInvisibleWhitespace', () => {
  it('links the PR', () => {
    assert.equal(
      formatPullRequestEntry(pr(8, []), 'Add thing'),
      `- [#8](https://github.com/${REPO}/pull/8) Add thing`
    );
  });

  it('drops zero-width characters and turns Unicode spaces into plain ones', () => {
    assert.equal(normalizeInvisibleWhitespace('a\u200Bb\u00A0c'), 'ab c');
  });
});

describe('normalizeTitle / formatEntry', () => {
  it('keeps the title verbatim apart from whitespace', () => {
    assert.equal(normalizeTitle('  Feature request: Shift  and\tAlt​ '), 'Feature request: Shift and Alt');
    assert.equal(normalizeTitle('Use `require()` on Node 20.19+'), 'Use `require()` on Node 20.19+');
  });

  it('formats the line, qualifying issues from other repositories', () => {
    assert.equal(
      formatEntry(issue(12, 'Title'), REPO),
      '- [#12](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/12) Title'
    );
    assert.equal(
      formatEntry(issue(13, 'Proposal: add thing'), REPO),
      '- [#13](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/13) Add thing'
    );
    assert.equal(
      formatEntry({ ...issue(3, 'Other'), repo: 'InditexTech/docouture', url: 'https://github.com/InditexTech/docouture/issues/3' }, REPO),
      '- [InditexTech/docouture#3](https://github.com/InditexTech/docouture/issues/3) Other'
    );
  });
});

describe('buildEntries', () => {
  it('gives one line per closed issue, deduplicated across PRs', () => {
    const { entries, warnings } = buildEntries(
      [pr(2, [issue(10, 'Ten', ['bug']), issue(11, 'Eleven', ['enhancement'])]), pr(1, [issue(10, 'Ten', ['bug'])])],
      { repo: REPO }
    );
    assert.deepEqual(
      entries.map((entry) => [entry.section, entry.pr, entry.line]),
      [
        ['Fixed', 2, '- [#10](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/10) Ten'],
        ['Added', 2, '- [#11](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/11) Eleven'],
      ]
    );
    assert.deepEqual(warnings, []);
  });

  it('warns about guessed sections', () => {
    const { entries, warnings } = buildEntries([pr(2, [issue(5, 'Five')], { title: 'untyped title' })], { repo: REPO });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].section, 'Changed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Section guessed for #5/);
  });

  it('files an issue under the type of the closing PR title when its labels pick none', () => {
    const { entries, warnings } = buildEntries([pr(2, [issue(5, 'Five')], { title: 'fix(idb): five' })], { repo: REPO });
    assert.equal(entries[0].section, 'Fixed');
    assert.deepEqual(warnings, []);
  });

  it('uses the PR title as the entry when no issue is closed (feat -> Added)', () => {
    const { entries, warnings, excluded } = buildEntries([pr(1, [], { title: 'feat(parser): add swipe' })], { repo: REPO });
    assert.deepEqual(
      entries.map((entry) => [entry.section, entry.guessed, entry.pr, entry.url, entry.line]),
      [['Added', false, 1, `https://github.com/${REPO}/pull/1`, `- [#1](https://github.com/${REPO}/pull/1) Add swipe`]]
    );
    assert.deepEqual(warnings, ['PR #1 has no linked issue, so its own title is used as the changelog entry.']);
    assert.deepEqual(excluded, []);
  });

  it('uses fix/perf types and PR labels to section a PR without an issue', () => {
    const { entries } = buildEntries(
      [pr(1, [], { title: 'fix: crash' }), pr(2, [], { title: 'perf: faster' }), pr(3, [], { title: 'feat: x', labels: ['security'] })],
      { repo: REPO }
    );
    assert.deepEqual(entries.map((entry) => entry.section), ['Fixed', 'Changed', 'Security']);
  });

  it('excludes an internal-type PR without an issue', () => {
    const { entries, excluded, warnings } = buildEntries([pr(1, [], { title: 'ci: pin action' })], { repo: REPO });
    assert.deepEqual(entries, []);
    assert.deepEqual(excluded, [{ ref: '#1', pr: 1, reason: '`ci:` PR without an issue' }]);
    assert.deepEqual(warnings, []);
  });

  it('files an untyped PR without an issue under Changed, with a guessed warning', () => {
    const { entries, warnings } = buildEntries([pr(1, [], { title: 'Update the thing' })], { repo: REPO });
    assert.deepEqual(entries.map((entry) => [entry.section, entry.guessed]), [['Changed', true]]);
    assert.equal(entries[0].line, `- [#1](https://github.com/${REPO}/pull/1) Update the thing`);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /PR #1 has no linked issue/);
    assert.match(warnings[1], /Section guessed for #1/);
  });

  it('skip-changelog gives no entries at all, even when the PR closes issues', () => {
    const { entries, warnings, bypassed } = buildEntries(
      [pr(1, [], { labels: ['skip-changelog'] }), pr(2, [issue(7, 'Seven', ['bug'])], { labels: ['skip-changelog'] })],
      { repo: REPO }
    );
    assert.deepEqual(entries, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(bypassed.map((item) => item.pr), [1, 2]);
  });

  it('lists internal issues as out of scope instead of writing them', () => {
    const { entries, excluded, warnings } = buildEntries(
      [pr(1, [issue(40, 'Release docs 5.7.0', ['internal']), issue(41, 'Tracking', ['kind/internal', 'bug']), issue(42, 'Real', ['bug'])])],
      { repo: REPO }
    );
    assert.deepEqual(entries.map((entry) => entry.ref), ['#42']);
    assert.deepEqual(excluded, [
      { ref: '#40', pr: 1, reason: '`internal`' },
      { ref: '#41', pr: 1, reason: '`kind/internal`' },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('exempts Dependabot, even when the PR closes an issue', () => {
    for (const author of ['dependabot', 'dependabot[bot]']) {
      const { entries, warnings, bypassed } = buildEntries([pr(1, [], { author })], { repo: REPO });
      assert.deepEqual(warnings, []);
      assert.equal(bypassed.length, 1);
      assert.deepEqual(entries, []);

      const linked = buildEntries([pr(2, [issue(9, 'Nine', ['bug'])], { author })], { repo: REPO });
      assert.deepEqual(linked.entries, []);
      assert.equal(linked.bypassed.length, 1);
    }
  });

  it('exports the type tables', () => {
    assert.deepEqual(TYPE_SECTIONS, { feat: 'Added', fix: 'Fixed', perf: 'Changed' });
    assert.deepEqual(INTERNAL_TYPES, ['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test']);
  });
});

describe('applyEntries', () => {
  const entries = buildEntries(
    [pr(2, [issue(20, 'Twenty', ['bug']), issue(21, 'Twenty-one', ['security'])]), pr(1, [issue(19, 'Nineteen', ['enhancement'])])],
    { repo: REPO }
  ).entries;

  it('writes only the [Unreleased] section, in Keep a Changelog order', () => {
    const { text, added } = applyEntries(CHANGELOG, entries);
    assert.equal(added.length, 3);
    assert.equal(
      text,
      CHANGELOG.replace(
        '## [Unreleased]\n\n',
        `## [Unreleased]

### Added

- [#19](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/19) Nineteen

### Fixed

- [#20](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/20) Twenty

### Security

- [#21](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/21) Twenty-one

`
      )
    );
  });

  it('is idempotent', () => {
    const once = applyEntries(CHANGELOG, entries).text;
    const twice = applyEntries(once, entries);
    assert.equal(twice.text, once);
    assert.equal(twice.added.length, 0);
    assert.equal(twice.alreadyListed.length, 3);
  });

  it('keeps manual lines and does not repeat an issue already listed', () => {
    const manual = CHANGELOG.replace(
      '## [Unreleased]\n',
      `## [Unreleased]

### Fixed

- [#20](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/20) Hand-written wording
- Manual line without an issue
`
    );
    const { text, added, alreadyListed } = applyEntries(manual, entries);
    assert.deepEqual(alreadyListed.map((entry) => entry.url), ['https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/20']);
    assert.equal(added.length, 2);
    assert.match(
      text,
      /### Added\n\n- \[#19\].*\n\n### Fixed\n\n- \[#20\]\(.*\) Hand-written wording\n- Manual line without an issue\n\n### Security\n\n- \[#21\]/
    );
    assert.ok(text.endsWith(manual.slice(manual.indexOf('## [5.7.1]'))));
  });

  it('works when [Unreleased] is the last section', () => {
    const { text } = applyEntries('# Changelog\n\n## [Unreleased]\n', entries.slice(0, 1));
    assert.equal(text, '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- [#20](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/20) Twenty\n');
  });

  it('leaves the text untouched when there is nothing to add', () => {
    assert.equal(applyEntries(CHANGELOG, []).text, CHANGELOG);
  });

  it('only counts the leading link of a list item as an issue entry', () => {
    const mentioned = CHANGELOG.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Changed\n\n- Refactor X (see [#20](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/20))\n'
    );
    const { added } = applyEntries(mentioned, entries);
    assert.ok(added.some((entry) => entry.url.endsWith('/issues/20')));

    const sneaky = buildEntries(
      [pr(1, [issue(30, 'Breaks [#31](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/31)', ['bug']), issue(31, 'Real', ['bug'])])],
      { repo: REPO }
    ).entries;
    const { text } = applyEntries(CHANGELOG, sneaky);
    assert.match(text, /- \[#31\]\(https:\/\/github.com\/InditexTech\/mcp-server-simulator-ios-idb\/issues\/31\) Real/);
  });

  it('refuses CRLF changelogs', () => {
    assert.throws(() => applyEntries(CHANGELOG.replace(/\n/g, '\r\n'), entries), /CRLF/);
  });

  it('fails without an [Unreleased] heading', () => {
    assert.throws(() => applyEntries('# Changelog\n\n## [1.0.0]\n', entries), /no "## \[Unreleased\]" heading/);
  });
});

describe('releasedUrls / dropReleased', () => {
  const history = `${CHANGELOG.replace('[Unreleased]: ', '')}
## [5.7.0] - 2026-10-26

### Fixed

- [#1147](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1147) Fixed earlier
`;

  it('skips an issue that an earlier release already lists, with a warning', () => {
    const result = buildEntries([pr(1, [issue(1147, 'Fixed earlier', ['bug']), issue(1300, 'New', ['bug'])])], { repo: REPO });
    const kept = dropReleased(result, releasedUrls(history));
    assert.deepEqual(kept.entries.map((entry) => entry.ref), ['#1300']);
    assert.deepEqual(kept.warnings, ['#1147 is already listed in the [5.7.0] release, so it is not listed again.']);
  });

  it('maps each issue to the newest release listing it and ignores [Unreleased]', () => {
    const urls = releasedUrls(
      history.replace('## [Unreleased]\n', '## [Unreleased]\n\n- [#1300](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1300) Pending\n')
    );
    assert.equal(urls.get('https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1246'), '5.7.1');
    assert.equal(urls.get('https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1147'), '5.7.0');
    assert.equal(urls.has('https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1300'), false);
  });

  it('with olderThan, only counts the releases below that version', () => {
    const urls = releasedUrls(history, { olderThan: '5.7.1' });
    assert.equal(urls.has('https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1246'), false);
    assert.equal(urls.get('https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/1147'), '5.7.0');
  });
});

describe('releasedSection / compareWithReleased', () => {
  it('reports differences with a hand-written section', () => {
    const released = releasedSection(CHANGELOG, '5.7.1');
    const generated = buildEntries(
      [pr(1, [issue(1246, 'Old entry', ['enhancement']), issue(1247, 'New', ['bug'])])],
      { repo: REPO }
    ).entries;
    const comparison = compareWithReleased(generated, released, '5.7.1');
    assert.equal(comparison.onlyGenerated.length, 1);
    assert.equal(comparison.onlyWritten.length, 0);
    assert.equal(comparison.moved.length, 1);
    assert.match(comparison.moved[0], /\(Added vs Fixed\)$/);
  });
});

describe('renderPullRequestReport', () => {
  it('explains how to link an issue, with the sidebar hint off the default branch', () => {
    const report = renderPullRequestReport({ pr: pr(1, [], { base: 'main-5' }), result: buildEntries([pr(1, [])], { repo: REPO }), enforce: true });
    assert.match(report, /:x: This PR is not linked to an issue/);
    assert.match(report, /use the Development sidebar/);
    assert.match(report, /_As of abc123._/);
  });

  it('says a bypassed PR gets no changelog entry, even when it closes issues', () => {
    const bare = pr(1, [], { labels: ['skip-changelog'] });
    assert.match(
      renderPullRequestReport({ pr: bare, result: buildEntries([bare], { repo: REPO }), enforce: true }),
      /This PR has the `skip-changelog` label, so it gets no changelog entry\./
    );
    const linked = pr(2, [issue(9, 'Nine', ['bug'])], { author: 'dependabot[bot]' });
    const report = renderPullRequestReport({ pr: linked, result: buildEntries([linked], { repo: REPO }), enforce: true });
    assert.match(report, /This PR was opened by Dependabot, so it gets no changelog entry\./);
    assert.doesNotMatch(report, /:x:|\*\*Fixed\*\*/);
  });

  it('previews the entry from the PR title when no issue is linked', () => {
    const unlinked = pr(4, [], { title: 'feat(idb): add thing' });
    const report = renderPullRequestReport({ pr: unlinked, result: buildEntries([unlinked], { repo: REPO }), enforce: false });
    assert.match(report, /:warning: This PR is not linked to an issue/);
    assert.match(report, /`CHANGELOG.md` gets:/);
    assert.match(report, /\*\*Added\*\*\n\n- \[#4\]\(.*\/pull\/4\) `Add thing`/);
    assert.match(report, /PR title without its `type\(scope\):` prefix/);
    assert.doesNotMatch(report, /has no linked issue/);
  });

  it('says why a linked PR gets no entry when its issues are internal', () => {
    const tracking = pr(3, [issue(40, 'Release docs 5.7.0', ['internal'])]);
    const report = renderPullRequestReport({ pr: tracking, result: buildEntries([tracking], { repo: REPO }), enforce: true });
    assert.match(report, /gets no changelog entry \(see below\)/);
    assert.match(report, /\*\*Out of scope\*\* \(no entry\)\n\n- #40 \(`internal`, PR #3\)/);
    assert.doesNotMatch(report, /:x:/);
  });
});

describe('wrapTitle / preview', () => {
  const link = '[#9](https://github.com/InditexTech/mcp-server-simulator-ios-idb/issues/9)';

  it('puts the title in a code span so mentions do not notify', () => {
    assert.equal(
      wrapTitle(`- ${link} Fix @InditexTech/mcp-server-simulator-ios-idb-admins crash`),
      `- ${link} \`Fix @InditexTech/mcp-server-simulator-ios-idb-admins crash\``
    );
  });

  it('uses a longer fence when the title has backticks', () => {
    assert.equal(wrapTitle(`- ${link} Fix \`a\` bug`), `- ${link} \`\`Fix \`a\` bug\`\``);
    assert.equal(wrapTitle(`- ${link} \`a\``), `- ${link} \`\` \`a\` \`\``);
  });

  it('leaves headings, references and manual bullets alone', () => {
    const text = '## [5.8.0] - 2026-11-11\n### Added\n- Manual @someone line\n[Unreleased]: https://x/compare/a...b';
    assert.equal(wrapTitles(text), text);
  });

  it('wraps only in the PR report; the changelog line stays verbatim', () => {
    const linked = pr(5, [issue(9, 'Fix @InditexTech/mcp-server-simulator-ios-idb-admins crash', ['bug'])]);
    const result = buildEntries([linked], { repo: REPO });
    assert.match(
      renderPullRequestReport({ pr: linked, result, enforce: false }),
      /- \[#9\]\(.*\) `Fix @InditexTech\/mcp-server-simulator-ios-idb-admins crash`/
    );
    assert.equal(result.entries[0].line, `- ${link} Fix @InditexTech/mcp-server-simulator-ios-idb-admins crash`);
    assert.ok(applyEntries(CHANGELOG, result.entries).text.includes(`${link} Fix @InditexTech/mcp-server-simulator-ios-idb-admins crash\n`));
  });
});

describe('createGitHubClient', () => {
  const prNode = {
    number: 4,
    title: 'feat: four',
    url: 'u',
    merged: true,
    mergedAt: '2026-10-01T00:00:00Z',
    baseRefName: 'main',
    headRefOid: 'sha',
    author: { login: 'dev' },
    labels: { nodes: [{ name: 'skip-release' }] },
    closingIssuesReferences: {
      nodes: [{ number: 3, title: 'T', url: 'i', repository: { nameWithOwner: REPO }, labels: { nodes: [{ name: 'bug' }] } }],
    },
  };

  function response(status, body, headers = {}) {
    return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), json: async () => body, text: async () => JSON.stringify(body) };
  }

  it('retries transient failures with backoff', async () => {
    const delays = [];
    const replies = [
      () => Promise.reject(new TypeError('socket hang up')),
      () => response(502, {}),
      () => response(200, { errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] }),
      () => response(200, { data: { repository: { pullRequest: prNode } } }),
    ];
    const client = createGitHubClient({
      token: 't',
      repo: REPO,
      fetchImpl: async () => replies.shift()(),
      sleep: async (ms) => delays.push(ms),
      baseDelayMs: 10,
    });
    const result = await client.pullRequest(4);
    assert.deepEqual(delays, [10, 20, 40]);
    assert.equal(result.title, 'feat: four');
    assert.deepEqual(result.labels, ['skip-release']);
    assert.deepEqual(result.issues, [{ number: 3, title: 'T', url: 'i', repo: REPO, labels: ['bug'] }]);
  });

  it('gives up after the last retry and does not retry real errors', async () => {
    const flaky = createGitHubClient({ token: 't', repo: REPO, fetchImpl: async () => response(503, {}), sleep: async () => {}, retries: 2 });
    await assert.rejects(flaky.pullRequest(4), /responded 503/);

    let calls = 0;
    const broken = createGitHubClient({
      token: 't',
      repo: REPO,
      fetchImpl: async () => {
        calls++;
        return response(200, { errors: [{ message: 'Field does not exist' }] });
      },
      sleep: async () => {},
    });
    await assert.rejects(broken.pullRequest(4), /Field does not exist/);
    assert.equal(calls, 1);
  });

  it('fails instead of truncating a paginated list', async () => {
    const client = createGitHubClient({
      token: 't',
      repo: REPO,
      fetchImpl: async () =>
        response(200, {
          data: {
            repository: {
              pullRequest: { ...prNode, closingIssuesReferences: { ...prNode.closingIssuesReferences, pageInfo: { hasNextPage: true } } },
            },
          },
        }),
    });
    await assert.rejects(
      client.pullRequest(4),
      /Too many issues closed by PR #4 .*Nothing was written and no release was prepared\. Raise the `first:` limit of `closingIssuesReferences`/
    );
  });

  it('requires a token', () => {
    assert.throws(() => createGitHubClient({ token: '', repo: REPO }), /GITHUB_TOKEN/);
  });
});

describe('pullRequestsForCommits', () => {
  it('keeps merged PRs into the branch, newest first, and reports commits without one', async () => {
    const byCommit = {
      a: [pr(1, [], { mergedAt: '2026-10-01T00:00:00Z' })],
      b: [pr(2, [], { mergedAt: '2026-10-03T00:00:00Z' }), { ...pr(3, []), merged: false }],
      c: [pr(4, [], { base: 'main-5' })],
      d: [pr(2, [], { mergedAt: '2026-10-03T00:00:00Z' })],
    };
    const client = { commitPullRequests: async (sha) => byCommit[sha] };
    const commits = ['a', 'b', 'c', 'd'].map((sha) => ({ sha, subject: sha }));
    const { prs, orphanCommits } = await pullRequestsForCommits(client, commits, { branch: 'main' });
    assert.deepEqual(prs.map((item) => item.number), [2, 1]);
    assert.deepEqual(orphanCommits.map((commit) => commit.sha), ['c']);
  });
});

describe('cutRelease', () => {
  const unreleased = `# Changelog

## [Unreleased]

### Added

- [#2](https://github.com/o/r/issues/2) New

## [1.0.0] - 2026-01-01

### Fixed

- [#1](https://github.com/o/r/issues/1) Old

[Unreleased]: https://github.com/o/r/compare/1.0.0...HEAD
`;

  it('moves the Unreleased body under the new version and leaves an empty Unreleased', () => {
    assert.equal(
      cutRelease(unreleased, '1.1.0', '2026-02-02'),
      unreleased.replace(
        '## [Unreleased]\n\n### Added\n\n- [#2](https://github.com/o/r/issues/2) New\n\n',
        '## [Unreleased]\n\n## [1.1.0] - 2026-02-02\n\n### Added\n\n- [#2](https://github.com/o/r/issues/2) New\n\n'
      )
    );
  });

  it('works when Unreleased is the last section', () => {
    assert.equal(
      cutRelease('# C\n\n## [Unreleased]\n\n### Fixed\n\n- x\n', '1.0.0', '2026-01-01'),
      '# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- x\n'
    );
  });

  it('throws on an existing version, empty Unreleased, bad version or date, and CRLF', () => {
    assert.throws(() => cutRelease(unreleased, '1.0.0', '2026-02-02'), /already has a "## \[1\.0\.0\]" section/);
    assert.throws(() => cutRelease('# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n', '1.1.0', '2026-02-02'), /no entries/);
    assert.throws(() => cutRelease(unreleased, 'v1.1', '2026-02-02'), /Expected a version/);
    assert.throws(() => cutRelease(unreleased, '1.1.0', '02/02/2026'), /Expected a date/);
    assert.throws(() => cutRelease(unreleased.replace(/\n/g, '\r\n'), '1.1.0', '2026-02-02'), /CRLF/);
  });
});

describe('sectionText', () => {
  const text = '# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- x\n\n## [0.9.0] - 2025-12-01\n\n- y\n';

  it('returns the body without the heading', () => {
    assert.equal(sectionText(text, '1.0.0'), '### Fixed\n\n- x\n');
  });

  it('returns null when the section is missing', () => {
    assert.equal(sectionText(text, '2.0.0'), null);
  });
});

describe('parseConventionalTitle with unknown prefixes', () => {
  it('keeps a prefix that is not a Conventional Commit type', () => {
    assert.deepEqual(parseConventionalTitle('tvOS: support the Siri Remote'), { type: null, subject: 'tvOS: support the Siri Remote' });
    assert.deepEqual(parseConventionalTitle('README: document tvOS'), { type: null, subject: 'README: document tvOS' });
  });
});
