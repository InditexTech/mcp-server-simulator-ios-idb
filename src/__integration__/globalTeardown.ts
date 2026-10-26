// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Shuts down and deletes the disposable simulator created by globalSetup
 */
export default async function globalTeardown(): Promise<void> {
  const udid = process.env.IOS_SIM_INTEGRATION_UDID;
  if (!udid) {
    return;
  }

  // Shutdown fails if the simulator is already off; deleting is what matters
  await execFileAsync('xcrun', ['simctl', 'shutdown', udid], { timeout: 120000 }).catch(() => undefined);
  await execFileAsync('xcrun', ['simctl', 'delete', udid], { timeout: 120000 });
  process.stderr.write(`Deleted simulator ${udid}\n`);
}
