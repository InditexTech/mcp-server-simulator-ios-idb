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
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

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

export function writeState(state) {
  // Fallback for direct module use: the suite itself always hands the file
  // over through STATE_FILE_ENV from globalSetup. Random per-activation
  // path inside a private mkdtemp (0700), file 0600.
  const file = process.env[STATE_FILE_ENV]
    || path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-state-')),
      `state-${randomUUID().slice(0, 8)}.json`
    );
  process.env[STATE_FILE_ENV] = file;
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return file;
}
