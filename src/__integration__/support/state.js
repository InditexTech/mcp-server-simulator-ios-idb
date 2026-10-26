// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';

/**
 * Singleton cross-module state for the integration run. Jest globalSetup and
 * test modules run in separatecontexts, so the harness persists its state in
 * this JSON file under os.tmpdir().
 */
const stateFile = process.env.MCP_INTEGRATION_STATE
  || `${process.env.TMPDIR || '/tmp'}mcp-integration-state-${process.pid}.json`;

export function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

export function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export function statePath() {
  return stateFile;
}
