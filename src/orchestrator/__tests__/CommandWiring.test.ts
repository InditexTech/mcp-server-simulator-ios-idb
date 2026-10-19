// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { MCPOrchestrator } from '../MCPOrchestrator.js';
import { NLParser } from '../../parser/NLParser.js';
import { IIDBManager } from '../../idb/interfaces/IIDBManager.js';
import { ParserToOrchestrator } from '../../adapters/ParserToOrchestrator.js';
import { CommandFactory } from '../interfaces/IOrchestratorCommand.js';
import { SimulatorCommands } from '../../parser/commands/SimulatorCommands.js';
import { AppCommands } from '../../parser/commands/AppCommands.js';
import { UICommands } from '../../parser/commands/UICommands.js';
import { AccessibilityCommands } from '../../parser/commands/AccessibilityCommands.js';
import { CaptureCommands } from '../../parser/commands/CaptureCommands.js';
import { DebugCommands } from '../../parser/commands/DebugCommands.js';
import { MiscCommands } from '../../parser/commands/MiscCommands.js';

// Methods that IDBManager does not implement yet; the adapter must report
// them as unsupported instead of routing to a different command.
const UNIMPLEMENTED = [
  'describeAllElements',
  'describePointElement',
  'startVideoRecording',
  'stopVideoRecording',
  'startDebugServer',
  'stopDebugServer'
] as const;

const createIDBManagerMock = () => ({
  createSimulatorSession: jest.fn(async () => 'session-1'),
  terminateSimulatorSession: jest.fn(async () => {}),
  listAvailableSimulators: jest.fn(async () => []),
  listBootedSimulators: jest.fn(async () => []),
  listSimulatorSessions: jest.fn(async () => []),
  bootSimulatorByUDID: jest.fn(async () => {}),
  shutdownSimulatorByUDID: jest.fn(async () => {}),
  shutdownSimulator: jest.fn(async () => {}),
  isSimulatorBooted: jest.fn(async () => true),
  focusSimulator: jest.fn(async () => {}),
  installApp: jest.fn(async () => ({ bundleId: 'com.example.app', name: 'app' })),
  launchApp: jest.fn(async () => {}),
  terminateApp: jest.fn(async () => {}),
  uninstallApp: jest.fn(async () => {}),
  listApps: jest.fn(async () => []),
  isAppInstalled: jest.fn(async () => true),
  tap: jest.fn(async () => {}),
  swipe: jest.fn(async () => {}),
  pressButton: jest.fn(async () => {}),
  inputText: jest.fn(async () => {}),
  pressKey: jest.fn(async () => {}),
  pressKeySequence: jest.fn(async () => {}),
  takeScreenshot: jest.fn(async () => '/tmp/screenshot.png'),
  getSystemLogs: jest.fn(async () => ''),
  getAppLogs: jest.fn(async () => ''),
  getDebugServerStatus: jest.fn(async () => ({ running: false })),
  listCrashLogs: jest.fn(async () => []),
  getCrashLog: jest.fn(async () => ''),
  deleteCrashLogs: jest.fn(async () => {}),
  installDylib: jest.fn(async () => {}),
  openUrl: jest.fn(async () => {}),
  clearKeychain: jest.fn(async () => {}),
  setLocation: jest.fn(async () => {}),
  addMedia: jest.fn(async () => {}),
  approvePermissions: jest.fn(async () => {}),
  updateContacts: jest.fn(async () => {})
});

describe('Command wiring (parser -> orchestrator -> IDB manager)', () => {
  let idbManager: ReturnType<typeof createIDBManagerMock>;
  let orchestrator: MCPOrchestrator;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    idbManager = createIDBManagerMock();
    orchestrator = new MCPOrchestrator(new NLParser(), idbManager as unknown as IIDBManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const examples = [
    new SimulatorCommands(),
    new AppCommands(),
    new UICommands(),
    new AccessibilityCommands(),
    new CaptureCommands(),
    new DebugCommands(),
    new MiscCommands()
  ]
    .flatMap(handler => handler.getDefinitions())
    .flatMap(definition => definition.examples.map(example => [definition.command, example]));

  it.each(examples)('%s: "%s" is executed or reported as unsupported', async (_command, example) => {
    const result = await orchestrator.processInstruction(example);

    if (!result.success) {
      expect(result.error).toMatch(
        new RegExp(`^Command not supported by the IDB manager: (${UNIMPLEMENTED.join('|')})$`)
      );
    }
  });

  it('routes "uninstall app" to uninstallApp, not installApp', async () => {
    const result = await orchestrator.processInstruction('uninstall app com.example.app');

    expect(result.success).toBe(true);
    expect(idbManager.uninstallApp).toHaveBeenCalledWith('', 'com.example.app');
    expect(idbManager.installApp).not.toHaveBeenCalled();
  });

  it('routes "list crash logs" and "delete crash logs" to the crash log methods', async () => {
    await orchestrator.processInstruction('list crash logs');
    await orchestrator.processInstruction('delete crash logs for com.example.app');

    expect(idbManager.listCrashLogs).toHaveBeenCalled();
    expect(idbManager.deleteCrashLogs).toHaveBeenCalled();
    expect(idbManager.getSystemLogs).not.toHaveBeenCalled();
  });

  it('refuses to delete crash logs without a filter', async () => {
    const result = await orchestrator.processInstruction('delete crash logs');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/without a filter/);
    expect(idbManager.deleteCrashLogs).not.toHaveBeenCalled();
  });

  it.each([
    ['delete all crash logs', { bundleId: undefined, all: true }],
    ['borrar todos los crash logs', { bundleId: undefined, all: true }],
    ['delete crash logs for com.example.MyApp', { bundleId: 'com.example.MyApp', all: undefined }]
  ])('deletes crash logs when asked explicitly: "%s"', async (instruction, options) => {
    const result = await orchestrator.processInstruction(instruction);

    expect(result.success).toBe(true);
    expect(idbManager.deleteCrashLogs).toHaveBeenCalledWith('', options);
  });

  it('passes the bundle ID of "get logs for" to getSystemLogs', async () => {
    await orchestrator.processInstruction('get logs for com.example.MyApp');

    expect(idbManager.getSystemLogs).toHaveBeenCalledWith('', { bundle: 'com.example.MyApp' });
  });

  it('types text with its original case', async () => {
    await orchestrator.processInstruction('input text Hello World');

    expect(idbManager.inputText).toHaveBeenCalledWith('', 'Hello World');
  });

  it.each(['0123', '0x1F', '1e3', 'TRUE'])('types "%s" verbatim', async (text) => {
    await orchestrator.processInstruction(`input text ${text}`);

    expect(idbManager.inputText).toHaveBeenCalledWith('', text);
  });

  it('keeps leading zeros in crash log names', async () => {
    await orchestrator.processInstruction('show crash log 00042');

    expect(idbManager.getCrashLog).toHaveBeenCalledWith('', '00042');
  });

  it('passes the active session to newly wired commands', async () => {
    await orchestrator.processInstruction('create session');
    await orchestrator.processInstruction('open url https://example.com/Path');

    expect(idbManager.openUrl).toHaveBeenCalledWith('session-1', 'https://example.com/Path');
  });

  it('rejects command names that only contain a known command', () => {
    const adapter = new ParserToOrchestrator({
      createCommand: (type, parameters) => ({ type, parameters, id: 'id' })
    } as CommandFactory);

    expect(() => adapter.convertToCommand({
      command: 'please uninstall app now',
      parameters: {},
      confidence: 1,
      originalText: 'please uninstall app now'
    })).toThrow('Could not map command');
  });
});
