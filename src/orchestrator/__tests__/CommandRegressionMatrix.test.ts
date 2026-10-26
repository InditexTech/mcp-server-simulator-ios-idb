// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { MCPOrchestrator } from '../MCPOrchestrator.js';
import { NLParser } from '../../parser/NLParser.js';
import { IIDBManager } from '../../idb/interfaces/IIDBManager.js';

/**
 * Regression matrix for every defect claimed fixed by PR #71.
 * Each entry states the original misbehavior and the assertion that detects
 * its return. Mocked evidence only: wiring contracts, not CLI behavior.
 */
describe('PR #71 regression matrix', () => {
  let idbManager: Record<string, jest.Mock>;
  let orchestrator: MCPOrchestrator;

  const MANAGER_METHODS = [
    'createSimulatorSession',
    'terminateSimulatorSession',
    'listAvailableSimulators',
    'listBootedSimulators',
    'listSimulatorSessions',
    'bootSimulatorByUDID',
    'shutdownSimulatorByUDID',
    'shutdownSimulator',
    'isSimulatorBooted',
    'focusSimulator',
    'installApp',
    'launchApp',
    'terminateApp',
    'uninstallApp',
    'listApps',
    'isAppInstalled',
    'tap',
    'swipe',
    'pressButton',
    'inputText',
    'pressKey',
    'pressKeySequence',
    'takeScreenshot',
    'getSystemLogs',
    'getAppLogs',
    'getDebugServerStatus',
    'listCrashLogs',
    'getCrashLog',
    'deleteCrashLogs',
    'installDylib',
    'openUrl',
    'clearKeychain',
    'setLocation',
    'addMedia',
    'approvePermissions',
    'updateContacts'
  ];

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    idbManager = {};
    for (const name of MANAGER_METHODS) {
      idbManager[name] = jest.fn(async () => 'regression-mock');
    }
    orchestrator = new MCPOrchestrator(new NLParser(), idbManager as unknown as IIDBManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Asserts the happy path of one instruction: it succeeds, reaches only the
   * intended manager method with these arguments, and no other manager method
   * runs (the original PR #71 defects misrouted operations).
   */
  async function expectRoutedTo(instruction: string, method: string, ...args: unknown[]) {
    for (const name of MANAGER_METHODS) {
      idbManager[name].mockClear();
    }
    const result = await orchestrator.processInstruction(instruction);
    expect(result.success).toBe(true);
    for (const name of MANAGER_METHODS) {
      if (name === method) {
        expect(idbManager[name]).toHaveBeenCalledTimes(1);
        if (args.length > 0) {
          expect(idbManager[name]).toHaveBeenCalledWith(...args);
        }
      } else {
        expect(idbManager[name]).not.toHaveBeenCalled();
      }
    }
  }

  // Bug: "uninstall app X" ran installApp because substring matching picked
  // the 'install app' mapping inside 'uninstall'.
  it('routes uninstall to uninstallApp (English and Spanish), never installApp', async () => {
    await expectRoutedTo('uninstall app com.example.ThirdApp', 'uninstallApp', '', 'com.example.ThirdApp');
    await expectRoutedTo('desinstalar app com.example.ThirdApp', 'uninstallApp', '', 'com.example.ThirdApp');
    expect(idbManager.installApp).not.toHaveBeenCalled();
  });

  // Bug: the mapping table only held ~15 of ~37 commands; other commands
  // failed with "Could not map command".
  it.each([
    ['list apps', 'listApps'],
    ['input text hello', 'inputText'],
    ['press key 13', 'pressKey'],
    ['open url https://example.com', 'openUrl'],
    ['set location 1.5, 2.5', 'setLocation'],
    ['clear keychain', 'clearKeychain'],
    ['add media /tmp/pic.png', 'addMedia'],
    ['approve permissions com.example.app camera', 'approvePermissions']
  ])('maps every previously unmapped command: "%s"', async (instruction, method) => {
    await expectRoutedTo(instruction, method);
  });

  // Bug: "list crash logs"/"delete crash logs" matched 'get logs' as a
  // substring and returned system logs instead.
  it('routes crash log commands to crash log methods, never to getSystemLogs', async () => {
    await expectRoutedTo('list crash logs', 'listCrashLogs');
    await expectRoutedTo('delete crash logs for com.example.MyApp', 'deleteCrashLogs', '', {
      bundleId: 'com.example.MyApp',
      all: undefined
    });
    expect(idbManager.getSystemLogs).not.toHaveBeenCalled();
  });

  // Bug: "get logs for <bundleId>" dropped the bundle id filter.
  it('passes the bundle id of "get logs for" into the log options', async () => {
    await expectRoutedTo(
      'get logs for com.example.TargetApp',
      'getSystemLogs',
      '',
      { bundle: 'com.example.TargetApp' }
    );
    await expectRoutedTo(
      'mostrar logs de com.example.TargetApp',
      'getSystemLogs',
      '',
      { bundle: 'com.example.TargetApp' }
    );
  });

  // Bug: input lowercased before matching destroyed the case of typed text,
  // bundle ids, paths, and URLs.
  it('preserves the original case of captured values', async () => {
    await expectRoutedTo('input text MixedCASE value', 'inputText', '', 'MixedCASE value');
    await expectRoutedTo('uninstall app com.example.MixedCaseID', 'uninstallApp', '', 'com.example.MixedCaseID');
    await expectRoutedTo('open url https://example.com/Some/Path?Q=CamelCase', 'openUrl', '', 'https://example.com/Some/Path?Q=CamelCase');
    await expectRoutedTo('install app /Users/demo/Builds/MyApp.app', 'installApp', '', '/Users/demo/Builds/MyApp.app');
    await expectRoutedTo('show crash log Crash_2023-Dec-01', 'getCrashLog', '', 'Crash_2023-Dec-01');
    await expectRoutedTo('update contacts /Tmp/Contacts.DB', 'updateContacts', '', '/Tmp/Contacts.DB');
  });

  // Bug: normalizeParameters coerced numeric-looking or boolean-looking free
  // text into numbers/booleans.
  it('types literal numeric and boolean words verbatim', async () => {
    await expectRoutedTo('input text 0123', 'inputText', '', '0123');
    await expectRoutedTo('input text TRUE', 'inputText', '', 'TRUE');
    await expectRoutedTo('input text 1e3 meters', 'inputText', '', '1e3 meters');
    await expectRoutedTo('input text 0x1F', 'inputText', '', '0x1F');
    await expectRoutedTo('show crash log 00042', 'getCrashLog', '', '00042');
  });

  // Bug: the registry returned the first handler that matched, so a command
  // name inside free text or a path won ("input text please uninstall app X"
  // uninstalled the app; "add media /x/screenshot.png" took a screenshot).
  it('keeps the command the instruction starts with when free text embeds other commands', async () => {
    await expectRoutedTo('input text please uninstall app com.example.Sneaky', 'inputText', '', 'please uninstall app com.example.Sneaky');
    await expectRoutedTo('type text tap at 10, 20', 'inputText', '', 'tap at 10, 20');
    // The URL capture group is [^\s]+, so a whitespace inside the argument
    // ends the URL; the residual "open app com.x" text must not execute as a
    // command (that was the PR #71 defect). Real URLs percent-encode spaces.
    await expectRoutedTo('open url myapp://open app com.x', 'openUrl', '', 'myapp://open');
    await expectRoutedTo('add media /Users/me/screenshot.png', 'addMedia', '', ['/Users/me/screenshot.png']);
    // Path captures are [^\s,]+ so spaces end the path; the residual text must
    // not switch the operation (the PR #71 defect). Paths with spaces need
    // quoting, which the parser does not support yet.
    await expectRoutedTo('update contacts /tmp/install app x', 'updateContacts', '', '/tmp/install');
    await expectRoutedTo('set location 40.7128, -0.1278', 'setLocation');
  });

  // Bug: install patterns matched inside uninstall/desinstalar ("install" is
  // a suffix of "uninstall").
  it('does not treat uninstall/desinstalar as install', async () => {
    await expectRoutedTo('uninstall app com.example.Stealth', 'uninstallApp', '', 'com.example.Stealth');
    await expectRoutedTo('desinstalar app com.example.Stealth', 'uninstallApp', '', 'com.example.Stealth');
    await expectRoutedTo('uninstall the app com.example.Stealth', 'uninstallApp', '', 'com.example.Stealth');
    expect(idbManager.installApp).not.toHaveBeenCalled();

    // The same must hold when the instruction merely contains the word.
    await expectRoutedTo('input text please uninstall app now', 'inputText', '', 'please uninstall app now');
  });

  // Bug: parser preference ignored position; Spanish "listar simuladores
  // arrancados" could resolve as plain "listar simuladores".
  it('resolves the longest Spanish command at the same position', async () => {
    await expectRoutedTo('listar simuladores arrancados', 'listBootedSimulators');
    await expectRoutedTo('mostrar simuladores arrancados', 'listBootedSimulators');
    await expectRoutedTo('listar simuladores', 'listAvailableSimulators');
  });

  // Safety: "delete crash logs" without a filter ran "idb crash delete" with
  // no filter and deleted every crash log.
  it('refuses unfiltered crash deletion and needs an explicit all', async () => {
    const refused = await orchestrator.processInstruction('delete crash logs');
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/without a filter/);
    expect(idbManager.deleteCrashLogs).not.toHaveBeenCalled();

    // 'borrar crash logs' (Spanish, no filter) must refuse too.
    const refusedEs = await orchestrator.processInstruction('borrar crash logs');
    expect(refusedEs.success).toBe(false);
    expect(refusedEs.error).toMatch(/without a filter|sin un filtro|no se puede/);
  });

  // Safety: explicit requests must pass all/bundleId through unchanged.
  it('requires explicit scope for crash deletion, then deletes with that scope', async () => {
    await expectRoutedTo('delete all crash logs', 'deleteCrashLogs', '', { bundleId: undefined, all: true });
    await expectRoutedTo('borrar todos los crash logs', 'deleteCrashLogs', '', { bundleId: undefined, all: true });
    await expectRoutedTo('delete crash logs for com.example.FilteredApp', 'deleteCrashLogs', '', {
      bundleId: 'com.example.FilteredApp',
      all: undefined
    });
  });

  // Sessions: newly wired commands must use the active session id returned
  // by create session, not lose it.
  it('threads the active session through subsequent commands', async () => {
    await expectRoutedTo('create session', 'createSimulatorSession', {});
    idbManager.createSimulatorSession.mockResolvedValueOnce('sess_ABC');
    const created = await orchestrator.processInstruction('create session');
    expect(created.success).toBe(true);
    expect(created.data).toBe('sess_ABC');

    await expectRoutedTo('list apps', 'listApps', 'sess_ABC');
    await expectRoutedTo('take screenshot', 'takeScreenshot', 'sess_ABC', undefined);
    await expectRoutedTo('end session', 'terminateSimulatorSession', 'sess_ABC');
  });

  // Unsupported commands must fail explicitly, never fall back to another
  // operation.
  it.each([
    ['describe all elements', 'describeAllElements'],
    ['describe point 150, 300', 'describePointElement'],
    ['record video /tmp/out.mp4', 'startVideoRecording'],
    ['stop recording', 'stopVideoRecording'],
    ['start debug com.example.app', 'startDebugServer'],
    ['stop debug', 'stopDebugServer']
  ])('rejects unsupported "%s" without running any operation', async (instruction, method) => {
    const result = await orchestrator.processInstruction(instruction);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`Command not supported by the IDB manager: ${method}`);
    for (const name of MANAGER_METHODS) {
      expect(idbManager[name]).not.toHaveBeenCalled();
    }
  });
});
