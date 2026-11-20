// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { jest } from '@jest/globals';
import { IDBManager } from '../IDBManager.js';
import { LabelledScreenshot, SavedDisplayScreenshot } from '../interfaces/IIDBManager.js';

function createTestPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((1 + rowBytes) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowBytes);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
      raw[px + 3] = 255;
    }
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrData),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const DUO_ENUMERATE_OUTPUT = [
  'Port:',
  '    Class: DisplayAdapter',
  '    Connected Screens:',
  '    (5) Resizable:',
  '        Screen ID: 5',
  '        Name: Resizable',
  '        Unique ID: E9A92A27-4AC1-4601-B055-1B4FD35EA889',
  '        Device Name: resizable',
  '        Screen Type: Scene',
  '        Pixel Size: {7680, 4320}',
  '    (1) LCD:',
  '        Screen ID: 1',
  '        Name: LCD',
  '        Unique ID: EC1AFD70-A528-4ADB-A96A-FBE73DB53DF3',
  '        Device Name: primary',
  '        Screen Type: Integrated',
  '        Pixel Size: {1398, 2034}',
  '        UI Orientation: Portrait',
  '    (2) TVOut:',
  '        Screen ID: 2',
  '        Name: TVOut',
  '        Unique ID: D782E534-2E35-4C1B-B97B-422EB583CA51',
  '        Device Name: external-0',
  '        Screen Type: TVOut',
  '        Pixel Size: {720, 480}',
  '    (3) LCD-1:',
  '        Screen ID: 3',
  '        Name: LCD-1',
  '        Unique ID: CDFAF032-131E-4E5D-8D2D-BC3A5541CF12',
  '        Device Name: primary-1',
  '        Screen Type: Integrated',
  '        Pixel Size: {2007, 2853}',
  '        UI Orientation: Landscape Left'
].join('\n');

const SINGLE_SCREEN_ENUMERATE_OUTPUT = [
  'Port:',
  '    Class: DisplayAdapter',
  '    Connected Screens:',
  '    (1) LCD:',
  '        Screen ID: 1',
  '        Name: LCD',
  '        Unique ID: 11111111-2222-3333-4444-555555555555',
  '        Device Name: primary',
  '        Screen Type: Integrated',
  '        Pixel Size: {1206, 2622}',
  '        UI Orientation: Portrait'
].join('\n');

describe('IDBManager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('fails fast when idb list-targets is unavailable', async () => {
    const manager = new IDBManager();
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockRejectedValue(new Error('spawn idb ENOENT'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(manager.listAvailableSimulators())
      .rejects.toThrow('idb is not installed or not available in PATH');
    expect(executeCommand).toHaveBeenCalledWith('idb', ['list-targets', '--only', 'simulator']);
  });

  it('memoizes simulator-only idb availability checks and re-verifies after ENOENT', async () => {
    const manager = new IDBManager();
    const simctlPayload = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
          udid: 'booted-udid',
          name: 'iPhone 16',
          state: 'Booted',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16'
        }]
      }
    });

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const command = parameters[0] as string;
        const args = parameters[1] as string[];
        if (command === 'idb' && args[0] === 'list-targets') {
          return '';
        }
        if (command === 'xcrun') {
          return simctlPayload;
        }
        return '';
      });

    const [firstList, secondList] = await Promise.all([
      manager.listAvailableSimulators(),
      manager.listBootedSimulators()
    ]);
    await manager.shutdownSimulatorByUDID('booted-udid');

    expect(firstList).toHaveLength(1);
    expect(secondList).toHaveLength(1);
    const idbCheckCalls = executeCommand.mock.calls.filter(
      call => call[0] === 'idb' && (call[1] as string[])[0] === 'list-targets'
    );
    expect(idbCheckCalls).toEqual([['idb', ['list-targets', '--only', 'simulator']]]);

    // Non-spawn ENOENT in command arguments (exit code 1) must NOT invalidate the availability cache
    manager['sessions'].set('session', 'booted-udid');
    executeCommand.mockRejectedValueOnce(
      Object.assign(
        new Error("Error executing command: idb add-media failed: ENOENT: no such file '/tmp/missing.png'"),
        { code: 1 }
      )
    );
    await expect(manager.addMedia('session', ['/tmp/missing.png'])).rejects.toThrow('missing.png');
    await manager.listAvailableSimulators();
    expect(
      executeCommand.mock.calls.filter(
        call => call[0] === 'idb' && (call[1] as string[])[0] === 'list-targets'
      )
    ).toHaveLength(1);

    // Simulate idb disappearing from PATH mid-session; next simulator check must re-probe idb
    executeCommand.mockRejectedValueOnce(
      Object.assign(new Error('Error executing command: spawn idb ENOENT'), { code: 'ENOENT' })
    );
    await expect(manager.tap('session', 10, 20)).rejects.toThrow('ENOENT');

    executeCommand.mockRejectedValueOnce(new Error('spawn idb ENOENT'));
    await expect(manager.listAvailableSimulators())
      .rejects.toThrow('idb is not installed or not available in PATH');
    expect(
      executeCommand.mock.calls.filter(
        call => call[0] === 'idb' && (call[1] as string[])[0] === 'list-targets'
      )
    ).toHaveLength(2);
  });

  it('deduplicates idb and simctl calls when creating sessions on booted or shutdown simulators', async () => {
    jest.useFakeTimers();
    const manager = new IDBManager();
    let isBooted = false;

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const command = parameters[0] as string;
        const args = parameters[1] as string[];
        if (command === 'xcrun' && args[1] === 'boot') {
          isBooted = true;
          return '';
        }
        if (command === 'xcrun' && args[1] === 'list') {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
                udid: 'sim-1',
                name: 'iPhone 16 Pro',
                state: isBooted ? 'Booted' : 'Shutdown',
                deviceTypeIdentifier: 'iPhone'
              }]
            }
          });
        }
        return '';
      });

    // Cold simulator: 1 idb check + 1 initial simctl list + 1 simctl boot + 1 poll simctl list (no pre-boot duplicate list)
    const coldSessionPromise = manager.createSimulatorSession({ deviceName: 'iphone 16 pro' });
    await jest.runAllTimersAsync();
    const coldSessionId = await coldSessionPromise;
    expect(coldSessionId).toMatch(/^session_/);
    expect(executeCommand.mock.calls).toEqual([
      ['idb', ['list-targets', '--only', 'simulator']],
      ['xcrun', ['simctl', 'list', 'devices', '--json']],
      ['xcrun', ['simctl', 'boot', 'sim-1']],
      ['xcrun', ['simctl', 'list', 'devices', '--json']]
    ]);

    executeCommand.mockClear();

    // Already-booted simulator on warm manager: 0 idb checks + 1 simctl list + 0 boot calls
    const warmSessionId = await manager.createSimulatorSession({ deviceName: 'iPhone 16 Pro' });
    expect(warmSessionId).toMatch(/^session_/);
    expect(executeCommand.mock.calls).toEqual([
      ['xcrun', ['simctl', 'list', 'devices', '--json']]
    ]);
  });

  it('resolves sessions to UDIDs and refuses unknown sessions', async () => {
    const manager = new IDBManager();
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');

    await expect(manager.launchApp('ghost-session', 'com.example.app'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.uninstallApp('ghost-session', 'com.example.app'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.listApps('ghost-session'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.tap('ghost-session', 1, 2))
      .rejects.toThrow('Session not found: ghost-session');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('uninstalls and lists apps by the resolved UDID', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        return commandArgs[0] === 'list-apps'
          ? ['{"bundle_id":"com.example.first","name":"First","install_path":"/apps/First.app"}',
             '{"bundle_id":"com.apple.mobilesafari","name":"Safari"}'].join('\n')
          : '';
      });

    await manager.uninstallApp('session', 'com.example.ThirdApp');
    const apps = await manager.listApps('session');

    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['uninstall', '--udid', 'simulator-udid', '--', 'com.example.ThirdApp']
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['list-apps', '--udid', 'simulator-udid', '--json']
    );
    expect(apps).toEqual([
      { bundleId: 'com.example.first', name: 'First', installedPath: '/apps/First.app' },
      { bundleId: 'com.apple.mobilesafari', name: 'Safari', installedPath: undefined }
    ]);
  });

  it('propagates app list parse failures instead of inventing apps', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest.spyOn(manager as any, 'executeCommand').mockResolvedValue('not json at all');

    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(manager.listApps('session')).rejects.toThrow();
    // Since main's fix(idb) #94 a listing failure is not the same as the app
    // being absent: list-apps failures propagate out of isAppInstalled too.
    await expect(manager.isAppInstalled('session', 'com.example.app')).rejects.toThrow();
  });

  it('streams unrestricted system logs and filters them by running app pid', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        if (commandArgs[0] === 'list-apps') {
          return '{"bundle_id":"com.example.app","pid":4321}';
        }
        return 'line-1\nline-2\nline-3';
      });

    await expect(manager.getSystemLogs('session')).resolves.toBe('line-1\nline-2\nline-3');
    await expect(manager.getSystemLogs('session', { bundle: 'com.example.app' }))
      .resolves.toBe('line-1\nline-2\nline-3');
    await expect(manager.getSystemLogs('session', { bundle: 'com.example.app', limit: 2 }))
      .resolves.toBe('line-1\nline-2');
    await expect(manager.getAppLogs('session', 'com.example.app'))
      .resolves.toBe('line-1\nline-2\nline-3');

    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'log',
      '--udid',
      'simulator-udid',
      '--',
      'stream',
      '--timeout',
      '5'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'log',
      '--udid',
      'simulator-udid',
      '--',
      'stream',
      '--process',
      '4321',
      '--timeout',
      '5'
    ]);
  });

  it('refuses app logs when the app is not running', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        return commandArgs[0] === 'list-apps'
          ? '{"bundle_id":"com.example.app","pid":null}'
          : '';
      });

    await expect(manager.getSystemLogs('session', { bundle: 'com.example.app' }))
      .rejects.toThrow('Application is not running: com.example.app');
    await expect(manager.getAppLogs('session', 'com.notinstalled.app'))
      .rejects.toThrow('Application is not running: com.notinstalled.app');
  });

  it('reports debug server crashes and unparseable output as not running', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        if (commandArgs[0] === 'debugserver') {
          return expectedDebugStatus.output;
        }
        return expectedDebugStatus.output;
      });

    const expectedDebugStatus = { output: 'Not Running' } as { output: string };
    await expect(manager.getDebugServerStatus('session')).resolves.toEqual({ running: false });

    expectedDebugStatus.output = 'process connect connect://192.0.2.7:64722';
    await expect(manager.getDebugServerStatus('session')).resolves.toEqual({
      running: true,
      port: 64722
    });

    expectedDebugStatus.output = 'garbage without a connect string';
    await expect(manager.getDebugServerStatus('session')).resolves.toEqual({
      running: true,
      port: undefined
    });

    expectedDebugStatus.output = 'process connect connect://no-port-here';
    await expect(manager.getDebugServerStatus('session')).resolves.toEqual({
      running: true,
      port: undefined
    });
  });

  it('converts crash list timestamps and null-safe crash metadata', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        if (commandArgs[0] === 'crash' && commandArgs[1] === 'list') {
          return [
            JSON.stringify({ name: 'App-2026-01-01.crash', bundle_id: 'com.example.app', timestamp: 1767225600 }),
            JSON.stringify({ name: null, bundle_id: null, timestamp: null })
          ].join('\n');
        }
        return '';
      });

    const crashes = await manager.listCrashLogs('session');

    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['crash', 'list', '--udid', 'simulator-udid']
    );
    expect(crashes[0]).toEqual({
      name: 'App-2026-01-01.crash',
      bundleId: 'com.example.app',
      date: new Date('2026-01-01T00:00:00.000Z'),
      path: ''
    });
    expect(crashes[1]).toEqual({
      name: '',
      bundleId: undefined,
      date: expect.any(Date),
      path: ''
    });
  });

  it('parses a multi-line crash list without leaking host-side entries into normalized results', async () => {
    // Synthetic contract only: the real idb crash list output on current
    // runtimes mixes HOST operating-system crash entries with simulator
    // reports (observed behavior), so the integration suite exercises this
    // command only at the contract level, on these synthetic lines. It
    // never reads real host crash logs and never uploads raw ones. This
    // test asserts the normalized shape the server exposes for whatever
    // lines idb returns.
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        expect(commandArgs[0]).toBe('crash');
        expect(commandArgs[1]).toBe('list');
        return [
          JSON.stringify({ name: 'SimApp-report.ips', bundle_id: 'com.example.simapp', timestamp: 1690000000 }),
          JSON.stringify({ name: 'SIM-REPORT-TWO.ips', bundle_id: 'com.example.simtwo', timestamp: 1700000000 }),
          '', // trailing blank lines are tolerated
          JSON.stringify({ name: null, bundle_id: 'com.example.overrides', timestamp: undefined as any })
        ].join('\n');
      });

    const crashes = await manager.listCrashLogs('session');

    expect(crashes).toHaveLength(3);
    expect(crashes[0]).toEqual({
      name: 'SimApp-report.ips',
      bundleId: 'com.example.simapp',
      date: new Date(1690000000 * 1000),
      path: ''
    });
    expect(crashes[1].name).toBe('SIM-REPORT-TWO.ips');
    expect(crashes[1].bundleId).toBe('com.example.simtwo');
    expect(crashes[2]).toEqual({
      name: '',
      bundleId: 'com.example.overrides',
      date: expect.any(Date),
      path: ''
    });
  });

  it('passes shell metacharacters as literal arguments', async () => {
    const manager = new IDBManager();

    const output = await manager['executeCommand']('/usr/bin/printf', [
      '%s',
      '$(printf injected); `printf injected`'
    ]);

    expect(output).toBe('$(printf injected); `printf injected`');
  });

  it('reports process execution failures and preserves errno code', async () => {
    const manager = new IDBManager();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      manager['executeCommand']('/path/that/does/not/exist')
    ).rejects.toMatchObject({
      message: expect.stringContaining('Error executing command:'),
      code: 'ENOENT'
    });
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
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'idb', ['list-targets', '--only', 'simulator']);
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
      .mockResolvedValueOnce('{"installedAppBundleId": "com.acme.shop", "uuid": null}')
      .mockResolvedValue('');

    await expect(manager.installApp('session', 'package.json')).resolves.toEqual({
      bundleId: 'com.acme.shop',
      name: 'package',
      installedPath: 'package.json'
    });
    await manager.launchApp('session', 'com.example.app');
    await manager.terminateApp('session', 'com.example.app');
    await manager.focusSimulator('session');
    await manager.uninstallApp('session', 'com.example.app');

    expect(executeCommand).toHaveBeenCalledWith(
      'idb',
      ['install', '--udid', 'simulator-udid', '--json', '--', 'package.json']
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

  it('fails when idb install does not report the bundle ID', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    jest.spyOn(manager as any, 'executeCommand').mockResolvedValue('Installed: com.acme.shop None');

    await expect(manager.installApp('session', 'package.json')).rejects.toThrow(
      'Could not read the bundle ID from the idb install output: Installed: com.acme.shop None'
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

  describe('foldable posture, orientation verification, and display-selectable screenshots', () => {
    it.each(['both dark', 'both visible', 'missing', 'invalid'])('does not confirm activity with %s capture evidence', async state => {
      const manager = new IDBManager();
      manager['sessions'].set('duo', 'duo-udid');
      manager['multiDisplayUdids'].add('duo-udid');
      manager['settleMaxAttempts'] = 1;
      jest.spyOn(manager as any, 'executeCommand').mockImplementation(async (...parameters: unknown[]) => {
        const args = parameters[1] as string[];
        if (args[3] === 'enumerate') return DUO_ENUMERATE_OUTPUT;
        if (args[0] === 'hinge') return '{"angle":120}';
        if (args[0] === 'rotation') return '{"orientation":"PORTRAIT"}';
        if (args[3] === 'screenshot' && state !== 'missing') {
          const color: [number, number, number] = state === 'both dark' ? [0, 0, 0] : [1, 2, 3];
          await fs.promises.writeFile(args[args.length - 1], state === 'invalid' ? 'not a PNG' : createTestPng(2, 2, color));
        }
        return '';
      });

      if (state === 'missing' || state === 'invalid') {
        await expect(manager.takeScreenshot('duo', undefined, 'all')).rejects.toThrow(/ENOENT|Invalid or unsupported PNG/);
        return;
      }

      const posture = await manager.getPosture('duo');
      expect(posture.activeDisplay).toBeNull();
      expect(posture.displays.map(display => display.active)).toEqual([null, null]);
      await expect(manager.takeScreenshot('duo')).rejects.toThrow('Could not determine the active display');
      await expect(manager.takeScreenshot('duo', undefined, 'active')).rejects.toThrow('Could not determine the active display');
      await expect(manager.setOrientation('duo', 'PORTRAIT', { activeDisplay: 'inner' })).rejects.toThrow('got "unknown"');
      await expect(manager.takeScreenshot('duo', undefined, 'all')).resolves.toEqual([
        expect.objectContaining({ label: expect.stringContaining('activity unknown') }),
        expect.objectContaining({ label: expect.stringContaining('activity unknown') })
      ]);
    });
    it('sets hinge angle, polls until settled, and rejects invalid or mismatched angles', async () => {
      const manager = new IDBManager();
      manager['sessions'].set('session', 'duo-udid');
      manager['settleMaxAttempts'] = 3;
      manager['settleIntervalMs'] = 0;

      const blackOuter = createTestPng(4, 6, [0, 0, 0]);
      const litInner = createTestPng(8, 6, [40, 120, 200]);
      const measuredAngles = [45.0, 120.0, 120.0];

      const executeCommand = jest
        .spyOn(manager as any, 'executeCommand')
        .mockImplementation(async (...parameters: unknown[]) => {
          const cmd = parameters[0] as string;
          const args = parameters[1] as string[];
          if (cmd === 'idb' && args[0] === 'hinge' && args[1] === '--udid') {
            const next = measuredAngles.shift() ?? 120.0;
            return JSON.stringify({ angle: next });
          }
          if (cmd === 'xcrun' && args[3] === 'enumerate') {
            return DUO_ENUMERATE_OUTPUT;
          }
          if (cmd === 'xcrun' && args[3] === 'screenshot') {
            const displayArg = args.find(a => a.startsWith('--display=')) ?? '';
            const outPath = args[args.length - 1];
            await fs.promises.writeFile(
              outPath,
              displayArg.endsWith('primary-1') ? litInner : blackOuter
            );
            return '';
          }
          return '';
        });

      await expect(manager.setHingeAngle('session', -5)).rejects.toThrow(
        'Hinge angle must be a finite number between 0 and 180 degrees'
      );
      await expect(manager.setHingeAngle('session', 200)).rejects.toThrow(
        'Hinge angle must be a finite number between 0 and 180 degrees'
      );

      const res = await manager.setHingeAngle('session', 120);
      expect(executeCommand).toHaveBeenCalledWith('idb', ['hinge', '120', '--udid', 'duo-udid']);
      expect(res.angle).toBe(120);
      expect(res.measuredAngle).toBe(120);
      expect(res.activeDisplay?.role).toBe('inner');
      expect(res.activeDisplay?.active).toBe(true);

      measuredAngles.splice(0, measuredAngles.length, 30.0, 30.0, 30.0);
      await expect(manager.setHingeAngle('session', 180)).rejects.toThrow(
        'Hinge angle mismatch: requested 180 degrees, measured 30 degrees'
      );
    });

    it('reads posture on foldable simulators and degrades cleanly on single-display simulators', async () => {
      const manager = new IDBManager();
      manager['sessions'].set('duo', 'duo-udid');
      manager['sessions'].set('phone', 'phone-udid');

      const litOuter = createTestPng(4, 6, [180, 90, 30]);
      const blackInner = createTestPng(6, 8, [0, 0, 0]);

      const executeCommand = jest
        .spyOn(manager as any, 'executeCommand')
        .mockImplementation(async (...parameters: unknown[]) => {
          const cmd = parameters[0] as string;
          const args = parameters[1] as string[];
          const udid = cmd === 'xcrun' ? args[2] : args[2];
          if (cmd === 'xcrun' && args[3] === 'enumerate') {
            return udid === 'duo-udid' ? DUO_ENUMERATE_OUTPUT : SINGLE_SCREEN_ENUMERATE_OUTPUT;
          }
          if (cmd === 'idb' && args[0] === 'rotation') {
            return JSON.stringify({ orientation: 'PORTRAIT' });
          }
          if (cmd === 'idb' && args[0] === 'hinge') {
            return JSON.stringify({ angle: 0.0 });
          }
          if (cmd === 'xcrun' && args[3] === 'screenshot') {
            const displayArg = args.find(a => a.startsWith('--display=')) ?? '';
            const outPath = args[args.length - 1];
            await fs.promises.writeFile(
              outPath,
              displayArg.endsWith('primary') ? litOuter : blackInner
            );
            return '';
          }
          return '';
        });

      const duoPosture = await manager.getPosture('duo');
      expect(duoPosture.foldable).toBe(true);
      expect(duoPosture.angle).toBe(0);
      expect(duoPosture.orientation).toBe('PORTRAIT');
      expect(duoPosture.displays).toHaveLength(2);
      expect(duoPosture.activeDisplay?.role).toBe('outer');
      expect(duoPosture.displays.find(d => d.role === 'inner')?.active).toBe(false);

      const phonePosture = await manager.getPosture('phone');
      expect(phonePosture.foldable).toBe(false);
      expect(phonePosture.angle).toBeNull();
      expect(phonePosture.orientation).toBe('PORTRAIT');
      expect(phonePosture.activeDisplay?.role).toBe('main');
      expect(executeCommand).not.toHaveBeenCalledWith('idb', ['hinge', '--udid', 'phone-udid', '--json']);
    });

    it('verifies orientation and expected posture, failing explicitly on mismatch', async () => {
      const manager = new IDBManager();
      manager['sessions'].set('duo', 'duo-udid');
      manager['settleMaxAttempts'] = 2;
      manager['settleIntervalMs'] = 0;

      const blackOuter = createTestPng(4, 6, [0, 0, 0]);
      const litInner = createTestPng(6, 8, [10, 200, 50]);
      let reportedOrientation = 'LANDSCAPE_LEFT';

      jest.spyOn(manager as any, 'executeCommand').mockImplementation(async (...parameters: unknown[]) => {
        const cmd = parameters[0] as string;
        const args = parameters[1] as string[];
        if (cmd === 'xcrun' && args[3] === 'enumerate') {
          return DUO_ENUMERATE_OUTPUT;
        }
        if (cmd === 'idb' && args[0] === 'rotation') {
          if (args[1] === '--udid') {
            return JSON.stringify({ orientation: reportedOrientation });
          }
          return '';
        }
        if (cmd === 'idb' && args[0] === 'hinge') {
          return JSON.stringify({ angle: 120.0 });
        }
        if (cmd === 'xcrun' && args[3] === 'screenshot') {
          const displayArg = args.find(a => a.startsWith('--display=')) ?? '';
          const outPath = args[args.length - 1];
          await fs.promises.writeFile(
            outPath,
            displayArg.endsWith('primary-1') ? litInner : blackOuter
          );
          return '';
        }
        return '';
      });

      const verified = await manager.setOrientation('duo', 'LANDSCAPE_LEFT', {
        angle: 120,
        activeDisplay: 'inner'
      });
      expect(verified.orientation).toBe('LANDSCAPE_LEFT');
      expect(verified.activeDisplay?.role).toBe('inner');

      await expect(manager.setOrientation('duo', 'LANDSCAPE_LEFT', {
        angle: 90, minAngle: 130, maxAngle: 110
      })).rejects.toThrow('expected hinge angle 90 degrees, got 120 degrees; expected hinge angle >= 130 degrees, got 120 degrees; expected hinge angle <= 110 degrees, got 120 degrees');
      await expect(manager.setOrientation('missing', 'PORTRAIT')).rejects.toThrow('Session not found');

      // Mismatch on expected active display
      await expect(
        manager.setOrientation('duo', 'LANDSCAPE_LEFT', { activeDisplay: 'outer' })
      ).rejects.toThrow('Posture mismatch: expected active display "outer", got "inner (primary-1)"');

      // Mismatch when simulator refuses to rotate
      reportedOrientation = 'PORTRAIT';
      await expect(
        manager.setOrientation('duo', 'PORTRAIT_UPSIDE_DOWN')
      ).rejects.toThrow('Posture mismatch: expected orientation PORTRAIT_UPSIDE_DOWN, got PORTRAIT');
    });

    it('captures active display by default on foldable sessions and supports per-display + suffixed all-displays screenshots', async () => {
      const manager = new IDBManager();
      const litOuter = createTestPng(4, 6, [220, 100, 40]);
      const blackInner = createTestPng(6, 8, [0, 0, 0]);
      let enumeration = DUO_ENUMERATE_OUTPUT;

      jest.spyOn(manager as any, 'executeCommand').mockImplementation(async (...parameters: unknown[]) => {
        const cmd = parameters[0] as string;
        const args = parameters[1] as string[];
        if (cmd === 'xcrun' && args[1] === 'list') {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
                {
                  udid: 'duo-udid',
                  name: 'iPhone Duo',
                  state: 'Booted',
                  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'
                }
              ]
            }
          });
        }
        if (cmd === 'xcrun' && args[3] === 'enumerate') {
          return enumeration;
        }
        if (cmd === 'idb' && args[0] === 'hinge') {
          return JSON.stringify({ angle: 0.0 });
        }
        if (cmd === 'xcrun' && args[3] === 'screenshot') {
          const displayArg = args.find(a => a.startsWith('--display=')) ?? '';
          const outPath = args[args.length - 1];
          await fs.promises.writeFile(
            outPath,
            displayArg.endsWith('primary') ? litOuter : blackInner
          );
          return '';
        }
        return '';
      });

      const sessionId = await manager.createSimulatorSession({ deviceName: 'iPhone Duo' });

      // Default screenshot on foldable session captures the lit outer screen Buffer
      const defaultBuf = await manager.takeScreenshot(sessionId);
      expect(Buffer.isBuffer(defaultBuf)).toBe(true);
      expect(defaultBuf).toEqual(litOuter);

      // All displays in-memory returns labelled PNGs
      const allInMemory = (await manager.takeScreenshot(
        sessionId,
        undefined,
        'all'
      )) as LabelledScreenshot[];
      expect(allInMemory).toHaveLength(2);
      expect(allInMemory[0].label).toBe('outer (primary, 4x6, active)');
      expect(allInMemory[0].buffer).toEqual(litOuter);
      expect(allInMemory[1].label).toBe('inner (primary-1, 6x8, inactive)');
      expect(allInMemory[1].buffer).toEqual(blackInner);

      for (const [selector, expected] of [
        ['activa', litOuter], ['exterior', litOuter], ['3', blackInner],
        ['interior', blackInner], ['CDFAF032-131E-4E5D-8D2D-BC3A5541CF12', blackInner]
      ] as const) {
        await expect(manager.takeScreenshot(sessionId, undefined, selector)).resolves.toEqual([
          expect.objectContaining({ buffer: expected })
        ]);
      }
      await expect(manager.takeScreenshot(sessionId, undefined, 'external-0'))
        .rejects.toThrow('Display "external-0" not found');

      // All displays with single file outputPath writes suffixed files
      const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-duo-test-'));
      try {
        const baseOut = path.join(outDir, 'capture.png');
        const saved = (await manager.takeScreenshot(
          sessionId,
          baseOut,
          'all'
        )) as SavedDisplayScreenshot[];
        expect(saved).toHaveLength(2);
        expect(saved[0].path).toBe(path.join(outDir, 'capture-outer.png'));
        expect(saved[1].path).toBe(path.join(outDir, 'capture-inner.png'));
        expect(await fs.promises.readFile(saved[0].path)).toEqual(litOuter);
        expect(await fs.promises.readFile(saved[1].path)).toEqual(blackInner);
        const directory = await manager.takeScreenshot(sessionId, outDir, 'ambas') as SavedDisplayScreenshot[];
        expect(directory.map(file => path.basename(file.path))).toEqual([
          'screenshot-outer.png', 'screenshot-inner.png'
        ]);
        const prefix = await manager.takeScreenshot(sessionId, path.join(outDir, 'prefix'), 'all') as SavedDisplayScreenshot[];
        expect(prefix.map(file => path.basename(file.path))).toEqual(['prefix-outer.png', 'prefix-inner.png']);
        const single = path.join(outDir, 'explicit.png');
        await expect(manager.takeScreenshot(sessionId, single, 'inner')).resolves.toEqual([
          expect.objectContaining({ path: single })
        ]);
        expect(await fs.promises.readFile(single)).toEqual(blackInner);
      } finally {
        await fs.promises.rm(outDir, { recursive: true, force: true });
      }

      await expect(manager.takeScreenshot(sessionId)).resolves.toEqual(litOuter);
      await expect(manager.takeScreenshot(sessionId, undefined, 'active')).resolves.toEqual([
        expect.objectContaining({ buffer: litOuter })
      ]);
      enumeration = '';
      await expect(manager.takeScreenshot(sessionId, undefined, 'all'))
        .rejects.toThrow('No integrated displays reported by simulator');
    });
  });

  it('normalizes accessibility elements from describe-all and describe-point', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const commandArgs = parameters[1] as string[];
        if (commandArgs[1] === 'describe-all') {
          return JSON.stringify([
            {
              AXUniqueId: 'fixtureTextField',
              AXLabel: 'Enter text here',
              AXValue: '0123 AbC',
              type: 'TextField',
              frame: { x: 24, y: 120, width: 320, height: 44 },
              children: [
                {
                  identifier: 'innerPlaceholder',
                  label: 'Placeholder',
                  role: 'StaticText',
                  frame: { x: 28, y: 126, width: 100, height: 20 }
                }
              ]
            }
          ]);
        }
        if (commandArgs[1] === 'describe-point') {
          const x = commandArgs[commandArgs.length - 2];
          if (x === '0') {
            return '[]';
          }
          return JSON.stringify({
            AXUniqueId: 'fixtureEchoLabel',
            AXLabel: 'Value: 0123 AbC',
            type: 'StaticText',
            frame: { x: 24, y: 180, width: 200, height: 24 }
          });
        }
        return '';
      });

    await expect(manager.describeAllElements('ghost-session'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.describePointElement('ghost-session', 10, 20))
      .rejects.toThrow('Session not found: ghost-session');

    const all = await manager.describeAllElements('session');
    expect(all).toEqual([
      {
        identifier: 'fixtureTextField',
        label: 'Enter text here',
        value: '0123 AbC',
        type: 'TextField',
        frame: { x: 24, y: 120, width: 320, height: 44 },
        children: [
          {
            identifier: 'innerPlaceholder',
            label: 'Placeholder',
            type: 'StaticText',
            frame: { x: 28, y: 126, width: 100, height: 20 }
          }
        ]
      }
    ]);

    await expect(manager.describePointElement('session', 150, 190)).resolves.toEqual({
      identifier: 'fixtureEchoLabel',
      label: 'Value: 0123 AbC',
      type: 'StaticText',
      frame: { x: 24, y: 180, width: 200, height: 24 }
    });
    await expect(manager.describePointElement('session', 0, 0)).resolves.toBeNull();

    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'describe-all',
      '--udid',
      'simulator-udid',
      '--json'
    ]);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'describe-point',
      '--udid',
      'simulator-udid',
      '--json',
      '--',
      '150',
      '190'
    ]);
  });

  it('starts and stops debug server with parsed port and argument separation', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValueOnce('process connect connect://localhost:54321')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Not a connect URL');

    await expect(manager.startDebugServer('ghost-session', 'com.example.app'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.stopDebugServer('ghost-session'))
      .rejects.toThrow('Session not found: ghost-session');

    await expect(manager.startDebugServer('session', 'com.example.app')).resolves.toBe(54321);
    await expect(manager.stopDebugServer('session')).resolves.toBeUndefined();
    await expect(manager.startDebugServer('session', 'com.example.app'))
      .rejects.toThrow('Could not read the debug server port from idb output: Not a connect URL');

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'idb', [
      'debugserver',
      'start',
      '--udid',
      'simulator-udid',
      '--',
      'com.example.app'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'idb', [
      'debugserver',
      'stop',
      '--udid',
      'simulator-udid'
    ]);
  });

  it('manages background video recording lifecycle and cleans up on session termination', async () => {
    const makeFakeChild = () => {
      const child = new EventEmitter() as any;
      child.stderr = new EventEmitter();
      child.kill = jest.fn((signal?: NodeJS.Signals) => {
        if (signal === 'SIGINT' || signal === 'SIGKILL') {
          setImmediate(() => child.emit('close', 0, null));
        }
        return true;
      });
      return child;
    };

    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');

    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    const failingChild = new EventEmitter() as any;
    failingChild.stderr = new EventEmitter();
    failingChild.kill = jest.fn(() => true);

    const children = [firstChild, secondChild, failingChild];
    const spawnProcess = jest
      .spyOn(manager as any, 'spawnProcess')
      .mockImplementation(() => {
        const next = children.shift();
        setImmediate(() => {
          if (next === failingChild) {
            next.stderr.emit('data', Buffer.from('Target not booted\n'));
            next.emit('close', 1, null);
          } else {
            next.stderr.emit('data', Buffer.from('Running video until ^C\n'));
          }
        });
        return next;
      });

    await expect(manager.startVideoRecording('ghost-session', '/tmp/out.mp4'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.stopVideoRecording('session'))
      .rejects.toThrow('No active video recording for session: session');

    const recordingId = await manager.startVideoRecording('session', '/tmp/video;1.mp4');
    expect(recordingId).toMatch(/^recording_/);
    expect(spawnProcess).toHaveBeenNthCalledWith(1, 'idb', [
      'video',
      '--udid',
      'simulator-udid',
      '--',
      '/tmp/video;1.mp4'
    ]);

    // Concurrent recording on the same session is rejected cleanly.
    await expect(manager.startVideoRecording('session', '/tmp/second.mp4'))
      .rejects.toThrow(`Video recording is already active for session session: ${recordingId}`);

    // Implicit stop (no recordingId, as emitted by natural-language "stop recording").
    await expect(manager.stopVideoRecording('session')).resolves.toBeUndefined();
    expect(firstChild.kill).toHaveBeenCalledWith('SIGINT');

    // Session termination cleans up an active recording automatically.
    const secondId = await manager.startVideoRecording('session', '/tmp/video2.mp4');
    expect(secondId).toMatch(/^recording_/);
    await manager.terminateSimulatorSession('session');
    expect(secondChild.kill).toHaveBeenCalledWith('SIGINT');

    // Premature child exit before "Running video" surfaces an explicit startup error.
    manager['sessions'].set('session-2', 'simulator-udid-2');
    await expect(manager.startVideoRecording('session-2', '/tmp/fail.mp4'))
      .rejects.toThrow('Video recording exited before becoming ready (code 1): Target not booted');
  });

  it('covers accessibility fallback shapes and video error/timeout branches', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');

    // Exercise spawnProcess directly against a harmless built-in binary (/usr/bin/true).
    const realProc = manager['spawnProcess']('/usr/bin/true', []);
    await new Promise<void>(resolve => realProc.once('close', () => resolve()));

    // Accessibility edge shapes: empty string, single object, null, array hit, primitive JSON.
    const outputs = [
      '',
      JSON.stringify({ AXLabel: 'SingleRoot', AXValue: 42 }),
      '42',
      '',
      'null',
      JSON.stringify([{ AXLabel: 'ArrayPointHit', frame: { x: 5, y: 6, width: 7, height: 8 } }]),
      '42'
    ];
    jest.spyOn(manager as any, 'executeCommand').mockImplementation(async () => outputs.shift() ?? '');

    await expect(manager.describeAllElements('session')).resolves.toEqual([]);
    await expect(manager.describeAllElements('session')).resolves.toEqual([
      { label: 'SingleRoot', value: '42', frame: { x: 0, y: 0, width: 0, height: 0 } }
    ]);
    await expect(manager.describeAllElements('session')).resolves.toEqual([]);

    await expect(manager.describePointElement('session', 1, 2)).resolves.toBeNull();
    await expect(manager.describePointElement('session', 1, 2)).resolves.toBeNull();
    await expect(manager.describePointElement('session', 1, 2)).resolves.toEqual({
      label: 'ArrayPointHit',
      frame: { x: 5, y: 6, width: 7, height: 8 }
    });
    await expect(manager.describePointElement('session', 1, 2)).resolves.toBeNull();

    await expect(manager.stopVideoRecording('ghost-session'))
      .rejects.toThrow('Session not found: ghost-session');

    // Spawn error event during video startup.
    const errorChild = new EventEmitter() as any;
    errorChild.stderr = new EventEmitter();
    errorChild.kill = jest.fn(() => true);

    // Non-zero exit on explicit recordingId stop, plus wrong recordingId rejection.
    const nonZeroStopChild = new EventEmitter() as any;
    nonZeroStopChild.stderr = new EventEmitter();
    nonZeroStopChild.kill = jest.fn(() => {
      setImmediate(() => nonZeroStopChild.emit('close', 2, null));
      return true;
    });

    // Startup timeout and stop timeout under fake timers.
    const silentStartChild = new EventEmitter() as any;
    silentStartChild.stderr = new EventEmitter();
    silentStartChild.kill = jest.fn(() => true);

    const hungStopChild = new EventEmitter() as any;
    hungStopChild.stderr = new EventEmitter();
    hungStopChild.kill = jest.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGKILL') {
        setImmediate(() => hungStopChild.emit('close', null, 'SIGKILL'));
      }
      return true;
    });

    const shutdownCleanupChild = new EventEmitter() as any;
    shutdownCleanupChild.stderr = new EventEmitter();
    shutdownCleanupChild.kill = jest.fn(() => {
      setImmediate(() => shutdownCleanupChild.emit('close', 3, null));
      return true;
    });

    const queue = [errorChild, nonZeroStopChild, silentStartChild, hungStopChild, shutdownCleanupChild];
    jest.spyOn(manager as any, 'spawnProcess').mockImplementation(() => {
      const next = queue.shift();
      if (next === errorChild) {
        setImmediate(() => next.emit('error', new Error('spawn idb ENOENT')));
      } else if (next !== silentStartChild) {
        setImmediate(() => next.stderr.emit('data', 'Running video until ^C\n'));
      }
      return next;
    });

    await expect(manager.startVideoRecording('session', '/tmp/err.mp4'))
      .rejects.toThrow('Error executing command: spawn idb ENOENT');

    const explicitId = await manager.startVideoRecording('session', '/tmp/explicit.mp4');
    await expect(manager.stopVideoRecording('session', 'wrong-id'))
      .rejects.toThrow('Video recording not found for session session: wrong-id');
    await expect(manager.stopVideoRecording('session', explicitId))
      .rejects.toThrow('Video recording exited with code 2');

    jest.useFakeTimers();
    const startTimeoutPromise = manager.startVideoRecording('session', '/tmp/timeout-start.mp4');
    const startTimeoutExpectation = expect(startTimeoutPromise)
      .rejects.toThrow('Timeout waiting for video recording to start');
    await jest.advanceTimersByTimeAsync(16_000);
    await startTimeoutExpectation;
    expect(silentStartChild.kill).toHaveBeenCalledWith('SIGKILL');
    jest.useRealTimers();

    const hungId = await manager.startVideoRecording('session', '/tmp/timeout-stop.mp4');
    jest.useFakeTimers();
    const stopTimeoutPromise = manager.stopVideoRecording('session', hungId);
    const stopTimeoutExpectation = expect(stopTimeoutPromise)
      .rejects.toThrow(`Timeout waiting for video recording to stop: ${hungId}`);
    await jest.advanceTimersByTimeAsync(16_000);
    await stopTimeoutExpectation;
    expect(hungStopChild.kill).toHaveBeenCalledWith('SIGKILL');
    jest.useRealTimers();

    // shutdownSimulator cleans up active recordings even if stopping exits non-zero.
    jest.spyOn(manager, 'shutdownSimulatorByUDID').mockResolvedValue(undefined);
    await manager.startVideoRecording('session', '/tmp/shutdown-cleanup.mp4');
    await expect(manager.shutdownSimulator('session')).resolves.toBeUndefined();
  });

  it('uses an isolated os.tmpdir() directory for buffer screenshots and cleans up without masking primary errors', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('session', 'simulator-udid');
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    let capturedTempDir = '';
    let leakedCleanupDir = '';

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementationOnce(async (...parameters: unknown[]) => {
        const args = parameters[1] as string[];
        const targetPath = args[4];
        capturedTempDir = path.dirname(targetPath);
        expect(capturedTempDir.startsWith(os.tmpdir())).toBe(true);
        expect(capturedTempDir.startsWith(process.cwd())).toBe(false);
        await fs.promises.writeFile(targetPath, pngBytes);
        return '';
      })
      .mockImplementationOnce(async (...parameters: unknown[]) => {
        const args = parameters[1] as string[];
        const targetPath = args[4];
        capturedTempDir = path.dirname(targetPath);
        await fs.promises.writeFile(targetPath, pngBytes);
        throw new Error('idb screenshot failed mid-capture');
      })
      .mockImplementationOnce(async (...parameters: unknown[]) => {
        const args = parameters[1] as string[];
        leakedCleanupDir = path.dirname(args[4]);
        throw new Error('primary screenshot failure');
      });

    const result = await manager.takeScreenshot('session');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(pngBytes);
    expect(fs.existsSync(capturedTempDir)).toBe(false);

    await expect(manager.takeScreenshot('session')).rejects.toThrow('idb screenshot failed mid-capture');
    expect(fs.existsSync(capturedTempDir)).toBe(false);

    // Cleanup failure in finally must never mask the primary screenshot error
    const realRm = fs.promises.rm.bind(fs.promises);
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EBUSY cleanup failure'));
    await expect(manager.takeScreenshot('session')).rejects.toThrow('primary screenshot failure');
    rmSpy.mockRestore();
    if (leakedCleanupDir) {
      await realRm(leakedCleanupDir, { recursive: true, force: true });
    }
    expect(executeCommand).toHaveBeenCalledTimes(3);
  });

  it('covers session lifecycle, boot short-circuit/timeout, and debugserver failure branches', async () => {
    jest.useFakeTimers();
    const manager = new IDBManager();
    let devicesPayload: Record<string, unknown[]> = {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'shutdown-udid', name: 'iPhone SE', state: 'Shutdown', deviceTypeIdentifier: 'iPhone' },
        { udid: 'booted-udid', name: 'iPhone 16', state: 'Booted', deviceTypeIdentifier: 'iPhone' }
      ]
    };

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const command = parameters[0] as string;
        const args = parameters[1] as string[];
        if (command === 'xcrun' && args[1] === 'list') {
          return JSON.stringify({ devices: devicesPayload });
        }
        if (command === 'idb' && args[0] === 'debugserver') {
          throw new Error('debugserver failed');
        }
        return '';
      });

    // Default selection prefers Booted over Shutdown
    const sessionId = await manager.createSimulatorSession();
    await expect(manager.listSimulatorSessions()).resolves.toEqual([sessionId]);
    await expect(manager.isSimulatorBooted(sessionId)).resolves.toBe(true);
    await expect(manager.getDebugServerStatus(sessionId)).resolves.toEqual({ running: false });

    // bootSimulatorByUDID returns immediately when already Booted
    await manager.bootSimulatorByUDID('booted-udid');
    expect(executeCommand).not.toHaveBeenCalledWith('xcrun', ['simctl', 'boot', 'booted-udid']);

    // shutdownSimulator delegates by resolved UDID, terminateSimulatorSession removes session
    await manager.shutdownSimulator(sessionId);
    expect(executeCommand).toHaveBeenCalledWith('xcrun', ['simctl', 'shutdown', 'booted-udid']);
    await manager.terminateSimulatorSession(sessionId);
    await expect(manager.terminateSimulatorSession(sessionId))
      .rejects.toThrow(`Session not found: ${sessionId}`);

    // Missing named simulator and empty device list errors
    await expect(manager.createSimulatorSession({ deviceName: 'NonExistent' }))
      .rejects.toThrow('No simulator found with name NonExistent');
    devicesPayload = {};
    await expect(manager.createSimulatorSession())
      .rejects.toThrow('No available simulators found');

    // Boot timeout when simulator never transitions to Booted
    devicesPayload = {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'stuck-udid', name: 'Stuck', state: 'Shutdown', deviceTypeIdentifier: 'iPhone' }
      ]
    };
    const stuckBootAssertion = expect(
      manager.bootSimulatorByUDID('stuck-udid')
    ).rejects.toThrow('Timeout waiting for simulator stuck-udid to boot');
    await jest.runAllTimersAsync();
    await stuckBootAssertion;
  });

  it('filters unavailable simulators, prioritizes iOS on default session creation, and guards tvOS non-touch/posture actions', async () => {
    const manager = new IDBManager();
    let devicesPayload: Record<string, unknown[]> = {
      'com.apple.CoreSimulator.SimRuntime.tvOS-27-2': [
        {
          udid: 'tv-booted',
          name: 'Apple TV 4K (4th generation)',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-4th-generation-1080p'
        },
        {
          udid: 'tv-unavailable',
          name: 'Deleted Apple TV',
          state: 'Shutdown',
          isAvailable: false,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-TV-1080p'
        }
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
        {
          udid: 'iphone-booted',
          name: 'iPhone 17 Pro',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
        }
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-27-0': [
        {
          udid: 'watch-shutdown',
          name: 'Apple Watch Series 12',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-12-46mm'
        }
      ],
      'com.apple.CoreSimulator.SimRuntime.visionOS-27-0': [
        {
          udid: 'vision-shutdown',
          name: 'Apple Vision Pro',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro'
        }
      ]
    };

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const command = parameters[0] as string;
        const args = parameters[1] as string[];
        if (command === 'xcrun' && args[1] === 'list') {
          return JSON.stringify({ devices: devicesPayload });
        }
        return '';
      });

    const available = await manager.listAvailableSimulators();
    expect(available.map(s => s.udid)).toEqual([
      'tv-booted',
      'iphone-booted',
      'watch-shutdown',
      'vision-shutdown'
    ]);

    // Unqualified createSimulatorSession prefers iOS even when tvOS appears first in simctl JSON
    const defaultSession = await manager.createSimulatorSession({ autoboot: false });
    await manager.tap(defaultSession, 10, 20);
    expect(executeCommand).toHaveBeenCalledWith('idb', ['ui', 'tap', '10', '20', '--udid', 'iphone-booted']);

    // Explicit platformVersion without deviceName selects matching tvOS simulator
    const tvByPlatform = await manager.createSimulatorSession({
      platformVersion: 'tvOS',
      autoboot: false
    });
    await expect(
      manager.createSimulatorSession({ platformVersion: 'tvOS-99', autoboot: false })
    ).rejects.toThrow('No simulator found for platform tvOS-99');

    // Explicit deviceName selects Apple TV and activates tvOS guardrails
    const tvByName = await manager.createSimulatorSession({
      deviceName: 'Apple TV 4K (4th generation)',
      autoboot: false
    });

    await expect(manager.tap(tvByPlatform, 100, 200)).rejects.toThrow(
      /Touch input \(tap\) is not supported on tvOS simulators/
    );
    await expect(manager.swipe(tvByName, 0, 0, 100, 100)).rejects.toThrow(
      /Touch input \(swipe\) is not supported on tvOS simulators/
    );
    await expect(manager.setHingeAngle(tvByName, 90)).rejects.toThrow(
      'Hinge angle control is not supported on tvOS simulators.'
    );
    await expect(manager.setOrientation(tvByName, 'LANDSCAPE_LEFT')).rejects.toThrow(
      'Device orientation control is not supported on tvOS simulators.'
    );

    // Non-touch operations (e.g. focusSimulator) still proceed on tvOS sessions
    await manager.focusSimulator(tvByName);
    expect(executeCommand).toHaveBeenCalledWith('idb', ['focus', '--udid', 'tv-booted']);

    await manager.terminateSimulatorSession(tvByName);
    await manager.terminateSimulatorSession(tvByPlatform);

    // Fallback when no iOS simulators exist in inventory
    devicesPayload = {
      'com.apple.CoreSimulator.SimRuntime.tvOS-27-2': [
        {
          udid: 'tv-only',
          name: 'Apple TV',
          state: 'Booted',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-TV-1080p'
        }
      ],
      'com.apple.CoreSimulator.SimRuntime.Custom-1-0': [
        {
          udid: 'custom-sim',
          name: 'Custom',
          state: 'Shutdown',
          deviceTypeIdentifier: 'CustomType'
        }
      ]
    };
    const fallbackSession = await manager.createSimulatorSession({ autoboot: false });
    await expect(manager.tap(fallbackSession, 1, 1)).rejects.toThrow(/not supported on tvOS/);
    const customSession = await manager.createSimulatorSession({ deviceName: 'Custom', autoboot: false });
    await manager.tap(customSession, 5, 6);
    expect(executeCommand).toHaveBeenCalledWith('idb', ['ui', 'tap', '5', '6', '--udid', 'custom-sim']);
  });

  it('sends Siri Remote focus actions and extended hardware buttons via idb', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('tv-session', 'tv-udid');
    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockResolvedValue('');

    await expect(manager.pressRemote('ghost-session', 'select'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.pressRemote('tv-session', 'diagonal' as any))
      .rejects.toThrow('Invalid Siri Remote action: diagonal');
    await expect(manager.pressButton('tv-session', 'POWER_OFF' as any))
      .rejects.toThrow('Invalid device button: POWER_OFF');

    for (const action of ['up', 'down', 'left', 'right', 'select', 'menu'] as const) {
      await manager.pressRemote('tv-session', action);
      expect(executeCommand).toHaveBeenCalledWith('idb', ['ui', 'remote', action, '--udid', 'tv-udid']);
    }

    await manager.pressRemote('tv-session', 'select', 350);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'remote',
      'select',
      '--duration',
      '0.35',
      '--udid',
      'tv-udid'
    ]);

    for (const button of ['PLAY_PAUSE', 'VOLUME_UP', 'VOLUME_DOWN', 'EJECT'] as const) {
      await manager.pressButton('tv-session', button);
      expect(executeCommand).toHaveBeenCalledWith('idb', ['ui', 'button', button, '--udid', 'tv-udid']);
    }

    await manager.pressButton('tv-session', 'PLAY_PAUSE', 500);
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'button',
      'PLAY_PAUSE',
      '--duration',
      '0.5',
      '--udid',
      'tv-udid'
    ]);
  });

  it('preserves focused/enabled accessibility attributes and taps elements by label or identifier on tvOS and iOS', async () => {
    const manager = new IDBManager();
    manager['sessions'].set('tv-session', 'tv-udid');
    manager['sessionPlatforms'].set('tv-session', 'tvos');

    const executeCommand = jest
      .spyOn(manager as any, 'executeCommand')
      .mockImplementation(async (...parameters: unknown[]) => {
        const args = parameters[1] as string[];
        if (args[1] === 'describe-all') {
          return JSON.stringify([
            {
              AXUniqueId: 'fixturePrimaryButton',
              AXLabel: 'Primary Action',
              type: 'Button',
              focused: true,
              enabled: true,
              frame: { x: 200, y: 300, width: 400, height: 80 },
              children: [
                {
                  AXLabel: 'Subtitle',
                  type: 'StaticText',
                  focused: false,
                  enabled: false,
                  frame: { x: 210, y: 340, width: 200, height: 30 }
                }
              ]
            }
          ]);
        }
        return '';
      });

    const elements = await manager.describeAllElements('tv-session');
    expect(elements).toEqual([
      {
        identifier: 'fixturePrimaryButton',
        label: 'Primary Action',
        type: 'Button',
        focused: true,
        enabled: true,
        frame: { x: 200, y: 300, width: 400, height: 80 },
        children: [
          {
            label: 'Subtitle',
            type: 'StaticText',
            focused: false,
            enabled: false,
            frame: { x: 210, y: 340, width: 200, height: 30 }
          }
        ]
      }
    ]);

    await expect(manager.tapElement('ghost-session', 'Play'))
      .rejects.toThrow('Session not found: ghost-session');
    await expect(manager.tapElement('tv-session', '   '))
      .rejects.toThrow('Accessibility marker must be a non-empty string');
    await expect(manager.tapElement('tv-session', 'Play', 'AXRole' as any))
      .rejects.toThrow('Invalid accessibility match key: AXRole');

    // Works on tvOS sessions even though coordinate tap is blocked
    await manager.tapElement('tv-session', 'Primary Action');
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'tap',
      '--match-key',
      'AXLabel',
      '--udid',
      'tv-udid',
      '--',
      'Primary Action'
    ]);

    await manager.tapElement('tv-session', '--leading-dash-id', 'AXUniqueId');
    expect(executeCommand).toHaveBeenCalledWith('idb', [
      'ui',
      'tap',
      '--match-key',
      'AXUniqueId',
      '--udid',
      'tv-udid',
      '--',
      '--leading-dash-id'
    ]);
  });
});
