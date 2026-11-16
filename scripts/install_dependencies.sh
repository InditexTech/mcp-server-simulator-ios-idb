#!/bin/bash
# SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    echo "Error: idb requires macOS on Apple Silicon." >&2
    exit 1
fi

if (( $(sw_vers -productVersion | cut -d. -f1) < 15 )); then
    echo "Error: idb requires macOS 15 or later." >&2
    exit 1
fi

if ! command -v brew &> /dev/null; then
    echo "Error: Install Homebrew first: https://brew.sh" >&2
    exit 1
fi

if ! xcode_version=$(xcodebuild -version); then
    echo "Error: Select a full Xcode 26 or later installation." >&2
    exit 1
fi
xcode_major=$(awk '/^Xcode / { split($2, version, "."); print version[1] }' <<< "$xcode_version")
if [[ -z "$xcode_major" ]] || (( xcode_major < 26 )); then
    echo "Error: idb requires Xcode 26 or later." >&2
    exit 1
fi
xcrun --find simctl > /dev/null

# The official metapackage installs the client and companion together, including
# a Homebrew-managed Python environment. Never modify a project venv here.
# GitHub renamed the facebook organization to meta (meta/homebrew-fb).
# If an older facebook/fb tap is still present locally, trigger Homebrew's
# redirect to meta/fb before trusting meta/fb formulae.
if brew tap | grep -qx 'facebook/fb'; then
    brew tap facebook/fb
fi
if ! brew tap | grep -qx 'meta/fb'; then
    brew tap meta/fb
fi
# Homebrew refuses to install a formula whose installed receipt records another
# tap (for example facebook/fb before the rename to meta/fb). Detect that read-only
# and explain the one-time manual migration instead of removing a working install.
legacy_formulae=()
for formula in idb idb-cli idb-companion; do
    receipt="$(brew --prefix "meta/fb/$formula")/INSTALL_RECEIPT.json"
    if [[ -f "$receipt" ]]; then
        installed_tap=$(plutil -extract source.tap raw -o - "$receipt" 2> /dev/null || true)
        if [[ -n "$installed_tap" && "$installed_tap" != "meta/fb" ]]; then
            echo "Error: $formula is installed from the $installed_tap tap, not meta/fb." >&2
            legacy_formulae+=("$formula")
        fi
    fi
done
if [[ ${#legacy_formulae[@]} -gt 0 ]]; then
    echo "Homebrew cannot install the same formula name from two taps." >&2
    echo "Migrate once, then rerun the installation:" >&2
    echo "  brew uninstall ${legacy_formulae[*]}" >&2
    echo "  npm ci" >&2
    exit 1
fi
if brew command trust > /dev/null 2>&1; then
    # Recent Homebrew versions require explicit trust for dependencies in a
    # third-party tap. Trust only the three formulae used by this installer.
    brew trust --formula meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion
fi
brew install meta/fb/idb

cli_prefix=$(brew --prefix meta/fb/idb-cli)
companion_prefix=$(brew --prefix meta/fb/idb-companion)
for executable in idb idb_companion; do
    if ! command -v "$executable" > /dev/null; then
        echo "Error: $executable is missing from PATH. Add Homebrew's bin directory." >&2
        exit 1
    fi
done
if [[ ! "$(command -v idb)" -ef "$cli_prefix/bin/idb" ||
      ! "$(command -v idb_companion)" -ef "$companion_prefix/bin/idb_companion" ]]; then
    echo "Error: Another idb installation shadows Homebrew. Deactivate the old venv and check PATH." >&2
    exit 1
fi

client_version=$("$cli_prefix/libexec/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("fb-idb"))')
# Homebrew's opt prefix resolves to the active keg, while `list --versions`
# includes inactive installations and must not be used to select a version.
companion_keg=$(cd "$companion_prefix" && pwd -P)
companion_version=${companion_keg##*/}
if [[ "$client_version" != "${companion_version%_*}" ]]; then
    echo "Error: idb client ($client_version) and companion ($companion_version) versions differ." >&2
    echo "Upgrade both with: brew upgrade meta/fb/idb-cli meta/fb/idb-companion" >&2
    exit 1
fi

idb --help > /dev/null
idb_companion --version
brew list --versions meta/fb/idb meta/fb/idb-cli meta/fb/idb-companion
echo "idb: $(command -v idb) ($client_version)"
echo "idb_companion: $(command -v idb_companion)"
echo "idb dependencies installed successfully."
