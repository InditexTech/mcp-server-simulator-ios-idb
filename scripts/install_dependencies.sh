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
brew tap facebook/fb
brew install facebook/fb/idb

cli_prefix=$(brew --prefix facebook/fb/idb-cli)
companion_prefix=$(brew --prefix facebook/fb/idb-companion)
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
companion_version=$(brew list --versions facebook/fb/idb-companion)
companion_version=${companion_version##* }
if [[ "$client_version" != "${companion_version%_*}" ]]; then
    echo "Error: idb client ($client_version) and companion ($companion_version) versions differ." >&2
    echo "Upgrade both with: brew upgrade facebook/fb/idb-cli facebook/fb/idb-companion" >&2
    exit 1
fi

idb --help > /dev/null
idb_companion --version
brew list --versions facebook/fb/idb facebook/fb/idb-cli facebook/fb/idb-companion
echo "idb: $(command -v idb) ($client_version)"
echo "idb_companion: $(command -v idb_companion)"
echo "idb dependencies installed successfully."
