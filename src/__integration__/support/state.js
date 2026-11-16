// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Singleton cross-module state for the integration run. Jest globalSetup and
 * test modules run in separatecontexts, so the harness persists its state in
 * a private mkdtemp directory (0700) and the state file itself is written
 * with mode 0600. The canonical filename is a random suffix per run, so no
 * predictable path is exposed in a shared temporary directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_FILE_ENV = 'MCP_INTEGRATION_STATE';

function resolveStateFile() {
  if (process.env[STATE_FILE_ENV]) {
    return process.env[STATE_FILE_ENV];
  }
  // The test modules cannot share in-process state with globalSetup, so the
  // canonical state file is handed over through this dedicated env var.
  // When it is not set by the harness, fall back to a random per-activation
  // file inside a private directory. Never reuse a shared, predictable path.
  const stateFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-state-'), { mode: 0o700 }),
    `state-${randomUUID().slice(0, 8)}.json`
  );
  process.env[STATE_FILE_ENV] = stateFile;
  return stateFile;
}

export function readState() {
  return JSON.parse(fs.readFileSync(resolveStateFile(), 'utf8'));
}

export function writeState(state) {
  fs.writeFileSync(resolveStateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
}
