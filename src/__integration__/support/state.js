// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Singleton cross-module state for the integration run. Jest globalSetup and
 * test modules run in separate contexts, so the harness persists its state
 * in a private mkdtemp directory (0700, enforced by mkdtempSync itself) with
 * a 0600 state file. The canonical file is handed over through
 * MCP_INTEGRATION_STATE; reads never create anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const STATE_FILE_ENV = 'MCP_INTEGRATION_STATE';

export function readState() {
  const envPath = process.env[STATE_FILE_ENV];
  if (!envPath) {
    // Reads must never have side effects: creating a private directory on
    // the read path would mask an aborted setup as an empty state.
    const error = new Error(`integration state missing: ${STATE_FILE_ENV} not set by globalSetup`);
    error.code = 'MCP_INTEGRATION_STATE_MISSING';
    throw error;
  }
  return JSON.parse(fs.readFileSync(envPath, 'utf8'));
}

/**
 * Writes the run state. The state file path is ALWAYS provided by
 * globalSetup through STATE_FILE_ENV (inside that run's private mkdtemp):
 * writing without it throws instead of silently creating another private
 * directory whose teardown would never run. If a file already exists at
 * the canonical path it must be a regular file owned by this run (never a
 * symlink); it is then overwritten with O_EXCL-free semantics, keeping
 * mode 0600 via an explicit fchmod-equivalent open flag combination.
 */
export function writeState(state) {
  const file = process.env[STATE_FILE_ENV];
  if (!file) {
    const error = new Error(`state write refused: ${STATE_FILE_ENV} not set by globalSetup`);
    error.code = 'MCP_INTEGRATION_STATE_MISSING';
    throw error;
  }
  if (fs.existsSync(file)) {
    const real = fs.realpathSync(file);
    if (real !== file) {
      throw new Error(`state path is a symlink or hardlink alias: ${file}`);
    }
    if (!fs.statSync(file).isFile()) {
      throw new Error(`state path is not a regular file: ${file}`);
    }
  }
  // Fresh write with O_CREAT|O_EXCL when absent; when rewriting an
  // existing owned file, open with 'w' but re-assert 0600 mode so the
  // write remains private even after a partial prior attempt.
  const fd = fs.openSync(file, fs.existsSync(file) ? 'w' : 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}
