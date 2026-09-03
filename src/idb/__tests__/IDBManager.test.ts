// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { IDBManager } from '../IDBManager.js';

describe('IDBManager', () => {
  it('passes shell metacharacters as literal arguments', async () => {
    const manager = new IDBManager();

    const output = await manager['executeCommand']('/usr/bin/printf', [
      '%s',
      '$(printf injected); `printf injected`'
    ]);

    expect(output).toBe('$(printf injected); `printf injected`');
  });

  it('passes text as a positional argument without shell escaping', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');
    const text = '"; touch /tmp/injected; #';

    await manager.inputText('session', text);

    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'text',
      '--udid',
      'simulator-udid',
      '--',
      text
    ]);
  });

  it('places UI and log options on their leaf commands', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');

    await manager.swipe('session', 1, 2, 3, 4, 5);
    await manager.getSystemLogs('session', { bundle: 'com.example.app', limit: 10 });

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'idb', [
      'ui',
      'swipe',
      '1',
      '2',
      '3',
      '4',
      '--duration',
      '5',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'idb', [
      'log',
      '--udid',
      'simulator-udid',
      '--',
      '--bundle',
      'com.example.app',
      '--limit',
      '10',
      '--timeout',
      '5'
    ]);
  });

  it('parses newline-delimited app JSON', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest.spyOn(manager as any, 'executeCommand').mockResolvedValue([
      '{"bundle_id":"com.example.first","name":"First"}',
      '{"bundle_id":"com.example.second","name":"Second"}'
    ].join('\n'));

    await expect(manager.isAppInstalled('session', 'com.example.second')).resolves.toBe(true);
    await expect(manager.listApps('session')).resolves.toEqual([
      { bundleId: 'com.example.first', name: 'First', installedPath: undefined },
      { bundleId: 'com.example.second', name: 'Second', installedPath: undefined }
    ]);
  });

  it('separates option-like crash names from command options', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');

    await manager.deleteCrashLogs('session', { crashNames: ['--all'] });

    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'crash',
      'delete',
      '--udid',
      'simulator-udid',
      '--',
      '--all'
    ]);
  });
});
