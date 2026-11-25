<!--
SPDX-FileCopyrightText: 2024 Industria de Diseño Textil S.A. INDITEX

SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Contributing

Thank you for your interest in contributing to this project! We value and appreciate any contributions you can make.
To maintain a collaborative and respectful environment, please consider the following guidelines when contributing to
this project.

## Prerequisites

- Before starting to contribute to the code, you must first sign the Contributor License Agreement (CLA). Detailed
  instructions on how to proceed can be found in the
  [FOSS contributing guidelines](https://github.com/InditexTech/foss/blob/main/CONTRIBUTING.md).

## How to Contribute

1. Open an issue to discuss and gather feedback on the feature or fix you wish to address.
2. Fork the repository and clone it to your local machine.
3. Create a new branch to work on your contribution: `git checkout -b your-branch-name`.
4. Make the necessary changes in your local branch.
5. Ensure that your code follows the established project style and formatting guidelines.
6. Perform testing to ensure your changes do not introduce errors.
7. Make clear and descriptive commits that explain your changes.
8. Push your branch to the remote repository: `git push origin your-branch-name`.
9. Open a pull request describing your changes and linking the issue it closes with `Closes #<issue>` in the
   description (or from the Development sidebar; a plain `#<issue>` mention does not count). The issue title becomes the
   `CHANGELOG.md` entry, so you don't edit the changelog by hand (see [Changelog](#changelog)).
10. Await comments and discussions on your pull request. Make any necessary modifications based on the received feedback.
11. Once your pull request is approved, your contribution will be merged into the main branch.

## Contribution Guidelines

- All contributors are expected to follow the project's [code of conduct](CODE_of_CONDUCT.md). Please be respectful and
considerate towards other contributors.
- Before starting work on a new feature or fix, check existing [issues](../../issues) and [pull requests](../../pulls)
to avoid duplications and unnecessary discussions.
- If you wish to work on an existing issue, comment on the issue to inform other contributors that you are working on it.
This will help coordinate efforts and prevent conflicts.
- It is always advisable to discuss and gather feedback from the community before making significant changes to the
project's structure or architecture.
- Ensure a clean and organized commit history. Divide your changes into logical and descriptive commits. We recommend to use the [Conventional Commits Specification](https://www.conventionalcommits.org/en/v1.0.0/)
- Document any new changes or features you add. This will help other contributors and project users understand your work
and its purpose.
- Be sure to link the corresponding issue in your pull request to maintain proper tracking of contributions.
- Remember to add license and copyright information following the [REUSE Specification](https://reuse.software/spec/#copyright-and-licensing-information).

## Changelog

`CHANGELOG.md` is generated at release time by `.github/scripts/changelog-from-prs.mjs` from the merged pull requests:

- Each issue a PR closes gives one line with the issue title, filed by the issue labels: `security` → Security,
  `bug` → Fixed, `enhancement` → Added. Without one of those labels, the Conventional Commit type of the PR title
  decides (`feat:` → Added, `fix:` → Fixed, `perf:` → Changed), otherwise Changed.
- A PR that closes no issue uses its own title, without the `type(scope):` prefix. `build:`, `chore:`, `ci:`, `docs:`,
  `refactor:`, `style:` and `test:` PRs without an issue get no entry.
- Dependabot PRs and PRs with the `skip-changelog` label get no entry. Issues labelled `kind/internal` are left out.

The **Changelog check** on every pull request shows the lines the PR will add and warns when it is not linked to an
issue. To change an entry, edit the issue (or PR) title or labels before the release.

## Releases

Maintainers prepare a release locally, so the release commit is signed:

1. On a release branch from an up-to-date `main` (`git switch -c chore/release-X.Y.Z`) with a clean working tree, run
   `GH_TOKEN=$(gh auth token) npm run release:prepare -- X.Y.Z`. It
   fills `## [Unreleased]` from the PRs merged since the last tag, turns it into `## [X.Y.Z] - <today>`, sets the
   version in `package.json` and `package-lock.json` and, for minor and major releases, seeds
   `docs/release-notes/X.Y.Z.md`.
2. Review the diff, edit entries if needed and replace every `TODO` in the release notes.
3. Commit (`chore(release): X.Y.Z`, signed and signed off) and open the release PR. Merge it only if nothing else was
   merged into `main` since you ran the script; otherwise run it again on the updated branch. A PR merged in between
   would be inside the tag but missing from the changelog, and the next release would not pick it up either.
4. Tag the merge commit of the release PR and publish, using the changelog section as the release body:
   `gh release create X.Y.Z --target <merge-sha> --title X.Y.Z --notes-file <(node .github/scripts/changelog-from-prs.mjs --section X.Y.Z)`.

Patch releases only get the changelog. Release notes for minor and major releases live in
[docs/release-notes](docs/release-notes/README.md).
