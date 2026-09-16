// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { IDBManager } from '../IDBManager.js';

describe('IDBManager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('passes shell metacharacters as literal arguments', async () => {
    const manager = new IDBManager();

    const output = await manager['executeCommand']('/usr/bin/printf', [
      '%s',
      '$(printf injected); `printf injected`'
    ]);

    expect(output).toBe('$(printf injected); `printf injected`');
  });

  it('reports process execution failures', async () => {
    const manager = new IDBManager();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      manager['executeCommand']('/path/that/does/not/exist')
    ).rejects.toThrow('Error executing command:');
  });

  it('uses argument arrays for simulator commands', async () => {
    const manager = new IDBManager();
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
            udid: 'simulator-udid',
            name: 'iPhone',
            state: 'Shutdown',
            deviceTypeIdentifier: 'iPhone'
          }]
        }
      }));

    await expect(manager.listAvailableSimulators()).resolves.toEqual([{
      udid: 'simulator-udid',
      name: 'iPhone',
      state: 'Shutdown',
      os: 'iOS-18-0',
      deviceType: 'iPhone'
    }]);
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'idb', ['--version']);
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      'xcrun',
      ['simctl', 'list', 'devices', '--json']
    );
  });

  it('boots and shuts down a simulator without a shell', async () => {
    jest.useFakeTimers();
    const manager = new IDBManager();
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');
    jest.spyOn(manager, 'listBootedSimulators')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        udid: 'simulator-udid',
        name: 'iPhone',
        state: 'Booted',
        os: 'iOS-18-0',
        deviceType: 'iPhone'
      }]);

    const bootPromise = manager.bootSimulatorByUDID('simulator-udid');
    await jest.runAllTimersAsync();
    await bootPromise;
    await manager.shutdownSimulatorByUDID('simulator-udid');

    expect(executeCommand).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'boot', 'simulator-udid']
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'shutdown', 'simulator-udid']
    );
  });

  it('uses argument arrays for app commands', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');

    await expect(manager.installApp('session', 'package.json')).resolves.toEqual({
      bundleId: 'com.example.package',
      name: 'package',
      installedPath: 'package.json'
    });
    await manager.launchApp('session', 'com.example.app');
    await manager.terminateApp('session', 'com.example.app');
    await manager.focusSimulator('session');
    await manager.uninstallApp('session', 'com.example.app');

    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['install', '--udid', 'simulator-udid', '--', 'package.json']
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['launch', '--udid', 'simulator-udid', '--', 'com.example.app']
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['terminate', '--udid', 'simulator-udid', '--', 'com.example.app']
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['uninstall', '--udid', 'simulator-udid', '--', 'com.example.app']
    );
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
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        return commandArgs[0] === 'list-apps'
          ? '{"bundle_id":"com.example.app","pid":1234}'
          : 'first log\nsecond log';
      });

    await manager.tap('session', 10, 20);
    await manager.swipe('session', 1, 2, 3, 4, 5);
    await manager.pressButton('session', 'HOME', 6);
    await manager.pressKey('session', 7, 8);
    await manager.pressKeySequence('session', [9, 10]);
    await expect(
      manager.getSystemLogs('session', { bundle: 'com.example.app', limit: 1 })
    ).resolves.toBe('first log');

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'idb', [
      'ui',
      'tap',
      '10',
      '20',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'idb', [
      'ui',
      'swipe',
      '1',
      '2',
      '3',
      '4',
      '--duration',
      '0.005',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'idb', [
      'ui',
      'button',
      'HOME',
      '--duration',
      '0.006',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'idb', [
      'ui',
      'key',
      '7',
      '--duration',
      '0.008',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(5, 'idb', [
      'ui',
      'key-sequence',
      '9',
      '10',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(6, 'idb', [
      'list-apps',
      '--udid',
      'simulator-udid',
      '--json'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(7, 'idb', [
      'log',
      '--udid',
      'simulator-udid',
      '--',
      'stream',
      '--process',
      '1234',
      '--timeout',
      '5'
    ]);
  });

  it('passes screenshot paths as literal arguments', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');
    const outputPath = '/tmp/screenshot; injected.png';

    await expect(manager.takeScreenshot('session', outputPath)).resolves.toBe(outputPath);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'screenshot',
      '--udid',
      'simulator-udid',
      '--',
      outputPath
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

  it('uses argument arrays for debug, crash, and miscellaneous commands', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        if (commandArgs[0] === 'debugserver') {
          return 'process connect connect://localhost:1234';
        }
        if (commandArgs[0] === 'crash' && commandArgs[1] === 'list') {
          return JSON.stringify({
            name: 'Example.crash',
            bundle_id: 'com.example.app',
            timestamp: 1735689600
          });
        }
        return '';
      });
    const before = new Date('2026-01-01T00:00:00.000Z');
    const since = new Date('2025-01-01T00:00:00.000Z');

    await expect(manager.getDebugServerStatus('session')).resolves.toEqual({
      running: true,
      port: 1234
    });
    await expect(manager.listCrashLogs('session', {
      bundleId: 'com.example.app',
      before,
      since
    })).resolves.toEqual([{
      name: 'Example.crash',
      bundleId: 'com.example.app',
      date: new Date('2025-01-01T00:00:00.000Z'),
      path: ''
    }]);
    await manager.getCrashLog('session', '--all');
    await manager.deleteCrashLogs('session', { all: true });
    await manager.deleteCrashLogs('session', {
      bundleId: 'com.example.app',
      before,
      since
    });
    await manager.installDylib('session', '/tmp/library; injected.dylib');
    await manager.openUrl('session', 'https://example.com/?value=a;b');
    await manager.clearKeychain('session');
    await manager.setLocation('session', 1.5, -2.5);
    await manager.addMedia('session', ['/tmp/one image.png', '/tmp/two.mov']);
    await manager.approvePermissions('session', 'com.example.app', ['photos', 'camera']);
    await manager.updateContacts('session', '/tmp/contacts; injected');

    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'crash',
      'show',
      '--udid',
      'simulator-udid',
      '--',
      '--all'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'crash',
      'delete',
      '--udid',
      'simulator-udid',
      '--bundle-id',
      'com.example.app',
      '--before',
      '1767225600',
      '--since',
      '1735689600'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'add-media',
      '--udid',
      'simulator-udid',
      '--',
      '/tmp/one image.png',
      '/tmp/two.mov'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'approve',
      '--udid',
      'simulator-udid',
      '--',
      'com.example.app',
      'photos',
      'camera'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'clear-keychain',
      '--udid',
      'simulator-udid'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'set-location',
      '--udid',
      'simulator-udid',
      '1.5',
      '-2.5'
    ]);
  });
});
