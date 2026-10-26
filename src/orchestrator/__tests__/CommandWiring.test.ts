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

const ALL_HANDLERS = [
  new SimulatorCommands(),
  new AppCommands(),
  new UICommands(),
  new AccessibilityCommands(),
  new CaptureCommands(),
  new DebugCommands(),
  new MiscCommands()
];

/**
 * Every IIDBManager method the orchestrator may reach. Used to prove that a
 * routed instruction called ONLY its intended destination.
 */
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
] as const;

type ManagerMethod = (typeof MANAGER_METHODS)[number];

/**
 * Canonical expectation for one parser example, written independently from the
 * adapters under test: the ONLY manager method the instruction may call plus
 * its exact argument list (the session id resolves to '' when no session is
 * active), or the manager method that must be reported as unsupported.
 * Expectations were derived by hand from the parser command definitions; they
 * are not generated from ParserToOrchestrator or OrchestratorToIDB.
 */
interface ExpectedManagerCall {
  method: ManagerMethod;
  args: unknown[];
}

interface ExpectedUnsupported {
  unsupported: string;
}

type ExpectedOutcome = ExpectedManagerCall | ExpectedUnsupported;

function call(method: ManagerMethod, ...args: unknown[]): ExpectedManagerCall {
  return { method, args };
}

function unsupported(managerMethod: string): ExpectedUnsupported {
  return { unsupported: managerMethod };
}

const EXPECTED_BY_EXAMPLE: Record<string, ExpectedOutcome> = {
  // Simulator management commands
  'crear sesión': call('createSimulatorSession', {}),
  'crear una sesión de simulador': call('createSimulatorSession', {}),
  'iniciar simulador iPhone 12': call('createSimulatorSession', { deviceName: 'iPhone 12' }),
  'create session with iPhone 12': call('createSimulatorSession', { deviceName: 'iPhone 12' }),
  'start simulator iPhone 13': call('createSimulatorSession', { deviceName: 'iPhone 13' }),
  'terminar sesión': call('terminateSimulatorSession', ''),
  'cerrar simulador': call('terminateSimulatorSession', ''),
  'end session': call('terminateSimulatorSession', ''),
  'close simulator': call('terminateSimulatorSession', ''),
  'terminate session': call('terminateSimulatorSession', ''),
  'listar simuladores': call('listAvailableSimulators'),
  'mostrar simuladores': call('listAvailableSimulators'),
  'qué simuladores hay': call('listAvailableSimulators'),
  'list simulators': call('listAvailableSimulators'),
  'show all simulators': call('listAvailableSimulators'),
  'display simulators': call('listAvailableSimulators'),
  'listar simuladores arrancados': call('listBootedSimulators'),
  'mostrar simuladores arrancados': call('listBootedSimulators'),
  'qué simuladores están arrancados': call('listBootedSimulators'),
  'list booted simulators': call('listBootedSimulators'),
  'show running simulators': call('listBootedSimulators'),
  'display active simulators': call('listBootedSimulators'),
  'arrancar simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('bootSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'bootear simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('bootSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'boot simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('bootSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'start simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('createSimulatorSession', { deviceName: '5A321B8F-4D85-4267-9F79-2F5C91D142C2' }),
  'apagar simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('shutdownSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'shutdown simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('shutdownSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'shutdown simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('shutdownSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'turn off simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2': call('shutdownSimulatorByUDID', '5A321B8F-4D85-4267-9F79-2F5C91D142C2'),
  'enfocar simulador': call('focusSimulator', ''),
  'focus simulador': call('focusSimulator', ''),
  'traer simulador al frente': call('focusSimulator', ''),
  'focus simulator': call('focusSimulator', ''),
  'bring simulator to front': call('focusSimulator', ''),

  // Application management commands
  'instalar app /ruta/a/la/app.ipa': call('installApp', '', '/ruta/a/la/app.ipa'),
  'instalar la aplicación /ruta/a/la/app.app': call('installApp', '', '/ruta/a/la/app.app'),
  'install app /path/to/app.ipa': call('installApp', '', '/path/to/app.ipa'),
  'install application /path/to/app.app': call('installApp', '', '/path/to/app.app'),
  'lanzar app com.example.app': call('launchApp', '', 'com.example.app'),
  'abrir app com.apple.mobilesafari': call('launchApp', '', 'com.apple.mobilesafari'),
  'launch app com.example.app': call('launchApp', '', 'com.example.app'),
  'open app com.apple.mobilesafari': call('launchApp', '', 'com.apple.mobilesafari'),
  'terminar app com.example.app': call('terminateApp', '', 'com.example.app'),
  'cerrar app com.apple.mobilesafari': call('terminateApp', '', 'com.apple.mobilesafari'),
  'matar app com.example.app': call('terminateApp', '', 'com.example.app'),
  'terminate app com.example.app': call('terminateApp', '', 'com.example.app'),
  'close app com.apple.mobilesafari': call('terminateApp', '', 'com.apple.mobilesafari'),
  'kill app com.example.app': call('terminateApp', '', 'com.example.app'),
  'desinstalar app com.example.app': call('uninstallApp', '', 'com.example.app'),
  'eliminar app com.apple.mobilesafari': call('uninstallApp', '', 'com.apple.mobilesafari'),
  'borrar app com.example.app': call('uninstallApp', '', 'com.example.app'),
  'uninstall app com.example.app': call('uninstallApp', '', 'com.example.app'),
  'remove app com.apple.mobilesafari': call('uninstallApp', '', 'com.apple.mobilesafari'),
  'delete app com.example.app': call('uninstallApp', '', 'com.example.app'),
  'listar apps': call('listApps', ''),
  'mostrar apps': call('listApps', ''),
  'qué apps hay': call('listApps', ''),
  'list apps': call('listApps', ''),
  'show apps': call('listApps', ''),
  'what apps are installed': call('listApps', ''),

  // UI interaction commands
  'tocar 150, 300': call('tap', '', 150, 300),
  'pulsar en 200, 400': call('tap', '', 200, 400),
  'tap at 100, 200': call('tap', '', 100, 200),
  'tap 150, 300': call('tap', '', 150, 300),
  'deslizar desde 150, 300 hasta 150, 100 con duración 500': call('swipe', '', 150, 300, 150, 100, 500),
  'swipe from 100, 200 to 300, 400': call('swipe', '', 100, 200, 300, 400, undefined),
  'swipe from 150, 300 to 150, 100 with duration 500': call('swipe', '', 150, 300, 150, 100, 500),
  'presionar botón del dispositivo HOME': call('pressButton', '', 'HOME', undefined),
  'pulsar botón del dispositivo SIRI': call('pressButton', '', 'SIRI', undefined),
  'presionar botón físico HOME': call('pressButton', '', 'HOME', undefined),
  'press device button HOME': call('pressButton', '', 'HOME', undefined),
  'push device button SIRI': call('pressButton', '', 'SIRI', undefined),
  'tap device button LOCK': call('pressButton', '', 'LOCK', undefined),
  'introducir texto Hola mundo': call('inputText', '', 'Hola mundo'),
  'escribir texto Prueba de texto': call('inputText', '', 'Prueba de texto'),
  'input text Hello world': call('inputText', '', 'Hello world'),
  'type text Test message': call('inputText', '', 'Test message'),
  'enter text Hello': call('inputText', '', 'Hello'),
  'presionar tecla 4': call('pressKey', '', 4, undefined),
  'pulsar la tecla 65': call('pressKey', '', 65, undefined),
  'press key 4': call('pressKey', '', 4, undefined),
  'hit key 65': call('pressKey', '', 65, undefined),
  'type key 13': call('pressKey', '', 13, undefined),
  'presionar secuencia de teclas 4 5 6': call('pressKeySequence', '', [4, 5, 6]),
  'pulsar secuencia de teclas 65 66 67': call('pressKeySequence', '', [65, 66, 67]),
  'press key sequence 4 5 6': call('pressKeySequence', '', [4, 5, 6]),
  'type key sequence 65 66 67': call('pressKeySequence', '', [65, 66, 67]),
  'enter key sequence 13 14 15': call('pressKeySequence', '', [13, 14, 15]),

  // Accessibility commands (IDBManager does not implement them yet)
  'describir todos los elementos': unsupported('describeAllElements'),
  'describe all elements': unsupported('describeAllElements'),
  'mostrar elementos de accesibilidad': unsupported('describeAllElements'),
  'describir punto 100, 200': unsupported('describePointElement'),
  'describe point 150, 300': unsupported('describePointElement'),
  'qué hay en 200, 400': unsupported('describePointElement'),

  // Capture and logging commands
  'capturar pantalla': call('takeScreenshot', '', undefined),
  'screenshot en /ruta/captura.png': call('takeScreenshot', '', '/ruta/captura.png'),
  'tomar una captura': call('takeScreenshot', '', undefined),
  'capture screen': call('takeScreenshot', '', undefined),
  'take screenshot to /path/capture.png': call('takeScreenshot', '', '/path/capture.png'),
  'grabar video /ruta/video.mp4': unsupported('startVideoRecording'),
  'record video /tmp/captura.mp4': unsupported('startVideoRecording'),
  'iniciar grabación de video /ruta/salida.mp4': unsupported('startVideoRecording'),
  'record video /path/video.mp4': unsupported('startVideoRecording'),
  'start recording video /path/output.mp4': unsupported('startVideoRecording'),
  'detener grabación': unsupported('stopVideoRecording'),
  'parar grabación de video': unsupported('stopVideoRecording'),
  'stop recording': unsupported('stopVideoRecording'),
  'end recording': unsupported('stopVideoRecording'),
  'stop video recording': unsupported('stopVideoRecording'),
  'obtener logs': call('getSystemLogs', '', undefined),
  'mostrar logs de com.example.app': call('getSystemLogs', '', { bundle: 'com.example.app' }),
  'get logs for com.apple.mobilesafari': call('getSystemLogs', '', { bundle: 'com.apple.mobilesafari' }),
  'show logs': call('getSystemLogs', '', undefined),
  'display logs for com.example.app': call('getSystemLogs', '', { bundle: 'com.example.app' }),

  // Debug commands
  'iniciar debug com.example.app': unsupported('startDebugServer'),
  'start debug com.apple.mobilesafari': unsupported('startDebugServer'),
  'debug app com.example.app': unsupported('startDebugServer'),
  'begin debug com.example.app': unsupported('startDebugServer'),
  'launch debug com.apple.mobilesafari': unsupported('startDebugServer'),
  'detener debug': unsupported('stopDebugServer'),
  'parar debug': unsupported('stopDebugServer'),
  'stop debug': unsupported('stopDebugServer'),
  'end debug': unsupported('stopDebugServer'),
  'terminate debug': unsupported('stopDebugServer'),
  'estado debug': call('getDebugServerStatus', ''),
  'status debug': call('getDebugServerStatus', ''),
  'información debug': call('getDebugServerStatus', ''),
  'debug status': call('getDebugServerStatus', ''),
  'get debug status': call('getDebugServerStatus', ''),
  'listar crash logs': call('listCrashLogs', '', { bundleId: undefined }),
  'mostrar crash logs': call('listCrashLogs', '', { bundleId: undefined }),
  'list crash logs': call('listCrashLogs', '', { bundleId: undefined }),
  'show crash logs': call('listCrashLogs', '', { bundleId: undefined }),
  'display crash logs': call('listCrashLogs', '', { bundleId: undefined }),
  'mostrar crash log crash_2023-01-01': call('getCrashLog', '', 'crash_2023-01-01'),
  'ver crash log app_crash_123': call('getCrashLog', '', 'app_crash_123'),
  'show crash log system_crash': call('getCrashLog', '', 'system_crash'),
  'display crash log error_log_123': call('getCrashLog', '', 'error_log_123'),
  'view crash log app_crash_456': call('getCrashLog', '', 'app_crash_456'),
  'eliminar crash logs de com.example.app': call('deleteCrashLogs', '', { bundleId: 'com.example.app', all: undefined }),
  'borrar todos los crash logs': call('deleteCrashLogs', '', { bundleId: undefined, all: true }),
  'delete crash logs for com.example.app': call('deleteCrashLogs', '', { bundleId: 'com.example.app', all: undefined }),
  'remove all crash logs': call('deleteCrashLogs', '', { bundleId: undefined, all: true }),
  'clear all crash logs': call('deleteCrashLogs', '', { bundleId: undefined, all: true }),

  // Miscellaneous commands
  'instalar dylib /ruta/a/lib.dylib': call('installDylib', '', '/ruta/a/lib.dylib'),
  'install dylib /tmp/library.dylib': call('installDylib', '', '/tmp/library.dylib'),
  'add dylib /path/to/lib.dylib': call('installDylib', '', '/path/to/lib.dylib'),
  'load dylib /path/to/library.dylib': call('installDylib', '', '/path/to/library.dylib'),
  'abrir url https://example.com': call('openUrl', '', 'https://example.com'),
  'open url https://google.com': call('openUrl', '', 'https://google.com'),
  'navegar a https://apple.com': call('openUrl', '', 'https://apple.com'),
  'navigate to https://example.com': call('openUrl', '', 'https://example.com'),
  'browse to https://apple.com': call('openUrl', '', 'https://apple.com'),
  'limpiar keychain': call('clearKeychain', ''),
  'clear keychain': call('clearKeychain', ''),
  'borrar keychain': call('clearKeychain', ''),
  'reset keychain': call('clearKeychain', ''),
  'empty keychain': call('clearKeychain', ''),
  'establecer ubicación 37.7749, -122.4194': call('setLocation', '', 37.7749, -122.4194),
  'set location 40.7128, -74.0060': call('setLocation', '', 40.7128, -74.0060),
  'cambiar ubicación a 51.5074, -0.1278': call('setLocation', '', 51.5074, -0.1278),
  'update location 48.8566, 2.3522': call('setLocation', '', 48.8566, 2.3522),
  'change location to 35.6762, 139.6503': call('setLocation', '', 35.6762, 139.6503),
  'añadir media /ruta/imagen.jpg /ruta/video.mp4': call('addMedia', '', ['/ruta/imagen.jpg', '/ruta/video.mp4']),
  'add media /tmp/photo.png': call('addMedia', '', ['/tmp/photo.png']),
  'importar multimedia /ruta/a/fotos/*.jpg': call('addMedia', '', ['/ruta/a/fotos/*.jpg']),
  'import media /path/to/photos/*.jpg': call('addMedia', '', ['/path/to/photos/*.jpg']),
  'upload media /path/video.mp4': call('addMedia', '', ['/path/video.mp4']),
  'aprobar permisos com.example.app photos camera': call('approvePermissions', '', 'com.example.app', ['photos', 'camera']),
  'approve permissions com.apple.mobilesafari contacts': call('approvePermissions', '', 'com.apple.mobilesafari', ['contacts']),
  'dar permisos a com.example.app photos': call('approvePermissions', '', 'com.example.app', ['photos']),
  'grant permissions com.example.app camera': call('approvePermissions', '', 'com.example.app', ['camera']),
  'allow permissions com.example.app location': call('approvePermissions', '', 'com.example.app', ['location']),
  'actualizar contactos /ruta/a/contactos.sqlite': call('updateContacts', '', '/ruta/a/contactos.sqlite'),
  'update contacts /tmp/contacts.db': call('updateContacts', '', '/tmp/contacts.db'),
  'importar contactos /ruta/contacts.sqlite': call('updateContacts', '', '/ruta/contacts.sqlite'),
  'import contacts /path/to/contacts.db': call('updateContacts', '', '/path/to/contacts.db'),
  'load contacts /path/contacts.sqlite': call('updateContacts', '', '/path/contacts.sqlite')
};

const createIDBManagerMock = () => {
  const manager: Record<ManagerMethod, jest.Mock> = {} as Record<ManagerMethod, jest.Mock>;
  const resolvedValues: Partial<Record<ManagerMethod, unknown>> = {
    createSimulatorSession: 'session-1',
    listAvailableSimulators: [],
    listBootedSimulators: [],
    listSimulatorSessions: [],
    isSimulatorBooted: true,
    installApp: { bundleId: 'com.example.app', name: 'app' },
    listApps: [],
    isAppInstalled: true,
    takeScreenshot: '/tmp/screenshot.png',
    getSystemLogs: '',
    getAppLogs: '',
    getDebugServerStatus: { running: false },
    listCrashLogs: [],
    getCrashLog: ''
  };
  for (const name of MANAGER_METHODS) {
    manager[name] = jest.fn(async () => resolvedValues[name]);
  }
  return manager;
};

describe('Command wiring (parser -> orchestrator -> IDB manager)', () => {
  let idbManager: Record<ManagerMethod, jest.Mock>;
  let orchestrator: MCPOrchestrator;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    idbManager = createIDBManagerMock();
    orchestrator = new MCPOrchestrator(new NLParser(), idbManager as unknown as IIDBManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const parserExamples = ALL_HANDLERS
    .flatMap(handler => handler.getDefinitions())
    .flatMap(definition => definition.examples);

  it('has a canonical expectation for every parser example, exactly once', () => {
    const tableKeys = Object.keys(EXPECTED_BY_EXAMPLE);
    expect(new Set(tableKeys).size).toBe(tableKeys.length);
    expect([...tableKeys].sort()).toEqual([...parserExamples].sort());
  });

  it.each(Object.entries(EXPECTED_BY_EXAMPLE))(
    '%s routes to exactly one manager call or reports it unsupported',
    async (example, expected) => {
      const result = await orchestrator.processInstruction(example);

      if ('unsupported' in expected) {
        // The adapter must report the missing manager method instead of
        // silently running some other operation.
        expect(result.success).toBe(false);
        expect(result.error).toBe(`Command not supported by the IDB manager: ${expected.unsupported}`);
        for (const name of MANAGER_METHODS) {
          expect(idbManager[name]).not.toHaveBeenCalled();
        }
        return;
      }

      expect(result.success).toBe(true);
      expect(idbManager[expected.method]).toHaveBeenCalledTimes(1);
      expect(idbManager[expected.method]).toHaveBeenCalledWith(...expected.args);

      // No wrong destination: every other manager method must stay untouched.
      for (const name of MANAGER_METHODS) {
        if (name !== expected.method) {
          expect(idbManager[name]).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('passes the active session to follow-up commands', async () => {
    await orchestrator.processInstruction('create session');
    await orchestrator.processInstruction('open url https://example.com/Path');
    await orchestrator.processInstruction('input text MixedCase 0123');
    await orchestrator.processInstruction('end session');

    expect(idbManager.createSimulatorSession).toHaveBeenCalledTimes(1);
    expect(idbManager.openUrl).toHaveBeenCalledWith('session-1', 'https://example.com/Path');
    expect(idbManager.inputText).toHaveBeenCalledWith('session-1', 'MixedCase 0123');
    expect(idbManager.terminateSimulatorSession).toHaveBeenCalledWith('session-1');
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
