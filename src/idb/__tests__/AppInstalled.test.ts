// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { IDBManager } from '../IDBManager.js';
import { IIDBManager } from '../interfaces/IIDBManager.js';
import { OrchestratorToIDB } from '../../adapters/OrchestratorToIDB.js';
import { CommandType } from '../../orchestrator/interfaces/IOrchestratorCommand.js';

const createManager = (output: string | Error) => {
  const manager = new IDBManager();
  manager['sessions'].set('session', 'simulator-udid');
  const executeCommand = output instanceof Error
    ? jest.spyOn(manager as any, 'executeCommand').mockRejectedValue(output)
    : jest.spyOn(manager as any, 'executeCommand').mockResolvedValue(output);
  return { manager, executeCommand };
};

describe('IDBManager.isAppInstalled', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when the app list contains the bundle ID', async () => {
    const { manager } = createManager(
      '{"bundle_id":"com.example.first"}\n{"bundle_id":"com.example.second"}'
    );

    await expect(manager.isAppInstalled('session', 'com.example.second')).resolves.toBe(true);
  });

  it('returns false when the app list does not contain the bundle ID', async () => {
    const { manager } = createManager('{"bundle_id":"com.example.first"}');

    await expect(manager.isAppInstalled('session', 'com.example.other')).resolves.toBe(false);
  });

  it('propagates a failure to list the apps instead of reporting the app as missing', async () => {
    const { manager } = createManager(new Error('Error executing command: idb companion is not running'));

    await expect(manager.isAppInstalled('session', 'com.example.app'))
      .rejects.toThrow('idb companion is not running');
  });

  it('reports the listing failure to the caller as a failed command', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = createManager(new Error('Error executing command: idb companion is not running'));
    const adapter = new OrchestratorToIDB(manager as unknown as IIDBManager);

    const result = await adapter.executeCommand({
      type: CommandType.IS_APP_INSTALLED,
      parameters: { bundleId: 'com.example.app' },
      id: 'check-app'
    }, 'session');

    expect(result.success).toBe(false);
    expect(result.error).toContain('idb companion is not running');
  });
});
