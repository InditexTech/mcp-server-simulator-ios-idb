// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { 
  CommandType, 
  IOrchestratorCommand, 
  CommandResult 
} from '../orchestrator/interfaces/IOrchestratorCommand.js';
import { IIDBManager } from '../idb/interfaces/IIDBManager.js';

/**
 * Adapter that converts orchestrator commands into IDBManager calls
 */
export class OrchestratorToIDB {
  private idbManager: IIDBManager;

  /**
   * Constructor
   * @param idbManager IDBManager instance to execute commands
   */
  constructor(idbManager: IIDBManager) {
    this.idbManager = idbManager;
  }

  /**
   * Returns an optional IIDBManager method bound to the manager
   * @param name Method name
   * @returns Bound method
   * @throws If the manager does not implement the method
   */
  private requireMethod<K extends keyof IIDBManager>(name: K): NonNullable<IIDBManager[K]> {
    const method = this.idbManager[name];
    if (typeof method !== 'function') {
      throw new Error(`Command not supported by the IDB manager: ${String(name)}`);
    }
    return (method as Function).bind(this.idbManager) as NonNullable<IIDBManager[K]>;
  }

  /**
   * Executes an orchestrator command using IDBManager
   * @param command Command to execute
   * @param sessionId Simulator session ID (optional)
   * @returns Execution result
   */
  public async executeCommand(command: IOrchestratorCommand, sessionId?: string): Promise<CommandResult> {
    try {
      const startTime = Date.now();
      let result: any;
      const params = command.parameters;
      const sid = params.sessionId || sessionId || '';

      // Execute command based on its type
      switch (command.type) {
        // Simulator management commands
        case CommandType.CREATE_SIMULATOR_SESSION:
          result = await this.idbManager.createSimulatorSession(command.parameters);
          break;

        case CommandType.TERMINATE_SIMULATOR_SESSION:
          await this.idbManager.terminateSimulatorSession(
            sid
          );
          result = { sessionId: command.parameters.sessionId || sessionId };
          break;

        case CommandType.LIST_AVAILABLE_SIMULATORS:
          result = await this.idbManager.listAvailableSimulators();
          break;

        case CommandType.LIST_BOOTED_SIMULATORS:
          result = await this.idbManager.listBootedSimulators();
          break;

        case CommandType.BOOT_SIMULATOR:
          await this.idbManager.bootSimulatorByUDID(command.parameters.udid);
          result = { udid: command.parameters.udid };
          break;

        case CommandType.SHUTDOWN_SIMULATOR:
          if (command.parameters.udid) {
            await this.idbManager.shutdownSimulatorByUDID(command.parameters.udid);
            result = { udid: command.parameters.udid };
          } else {
            await this.idbManager.shutdownSimulator(
              sid
            );
            result = { sessionId: command.parameters.sessionId || sessionId };
          }
          break;

        // Application management commands
        case CommandType.INSTALL_APP:
          result = await this.idbManager.installApp(
            sid,
            command.parameters.appPath
          );
          break;

        case CommandType.LAUNCH_APP:
          await this.idbManager.launchApp(
            sid,
            command.parameters.bundleId
          );
          result = { bundleId: command.parameters.bundleId };
          break;

        case CommandType.TERMINATE_APP:
          await this.idbManager.terminateApp(
            sid,
            command.parameters.bundleId
          );
          result = { bundleId: command.parameters.bundleId };
          break;

        // UI interaction commands
        case CommandType.TAP:
          await this.idbManager.tap(
            sid,
            command.parameters.x,
            command.parameters.y
          );
          result = { x: command.parameters.x, y: command.parameters.y };
          break;

        case CommandType.SWIPE:
          await this.idbManager.swipe(
            sid,
            command.parameters.startX,
            command.parameters.startY,
            command.parameters.endX,
            command.parameters.endY,
            command.parameters.duration
          );
          result = {
            startX: command.parameters.startX,
            startY: command.parameters.startY,
            endX: command.parameters.endX,
            endY: command.parameters.endY
          };
          break;

        // Screenshot and logging commands
        case CommandType.TAKE_SCREENSHOT:
          result = await this.idbManager.takeScreenshot(
            sid,
            command.parameters.outputPath
          );
          break;

        case CommandType.GET_SYSTEM_LOGS:
          result = await this.idbManager.getSystemLogs(
            sid,
            command.parameters.options
          );
          break;

        case CommandType.GET_APP_LOGS:
          result = await this.idbManager.getAppLogs(
            sid,
            command.parameters.bundleId
          );
          break;

        case CommandType.FOCUS_SIMULATOR:
          await this.requireMethod('focusSimulator')(sid);
          result = { sessionId: sid };
          break;

        case CommandType.UNINSTALL_APP:
          await this.requireMethod('uninstallApp')(sid, params.bundleId);
          result = { bundleId: params.bundleId };
          break;

        case CommandType.LIST_APPS:
          result = await this.requireMethod('listApps')(sid);
          break;

        case CommandType.PRESS_BUTTON:
          await this.requireMethod('pressButton')(sid, params.button, params.duration);
          result = { button: params.button };
          break;

        case CommandType.INPUT_TEXT:
          await this.requireMethod('inputText')(sid, params.text);
          result = { text: params.text };
          break;

        case CommandType.PRESS_KEY:
          await this.requireMethod('pressKey')(sid, params.keyCode, params.duration);
          result = { keyCode: params.keyCode };
          break;

        case CommandType.PRESS_KEY_SEQUENCE:
          await this.requireMethod('pressKeySequence')(sid, params.keyCodes);
          result = { keyCodes: params.keyCodes };
          break;

        // Accessibility commands
        case CommandType.DESCRIBE_ALL_ELEMENTS:
          result = await this.requireMethod('describeAllElements')(sid);
          break;

        case CommandType.DESCRIBE_POINT_ELEMENT:
          result = await this.requireMethod('describePointElement')(sid, params.x, params.y);
          break;

        case CommandType.START_VIDEO_RECORDING:
          result = await this.requireMethod('startVideoRecording')(sid, params.outputPath);
          break;

        case CommandType.STOP_VIDEO_RECORDING:
          await this.requireMethod('stopVideoRecording')(sid, params.recordingId);
          result = { recordingId: params.recordingId };
          break;

        // Debug commands
        case CommandType.START_DEBUG_SERVER:
          result = { port: await this.requireMethod('startDebugServer')(sid, params.bundleId) };
          break;

        case CommandType.STOP_DEBUG_SERVER:
          await this.requireMethod('stopDebugServer')(sid);
          result = { sessionId: sid };
          break;

        case CommandType.GET_DEBUG_SERVER_STATUS:
          result = await this.requireMethod('getDebugServerStatus')(sid);
          break;

        case CommandType.LIST_CRASH_LOGS:
          result = await this.requireMethod('listCrashLogs')(sid, { bundleId: params.bundleId });
          break;

        case CommandType.GET_CRASH_LOG:
          result = await this.requireMethod('getCrashLog')(sid, params.crashName);
          break;

        case CommandType.DELETE_CRASH_LOGS:
          await this.requireMethod('deleteCrashLogs')(sid, {
            bundleId: params.bundleId,
            all: params.all
          });
          result = { deleted: true };
          break;

        // Miscellaneous commands
        case CommandType.INSTALL_DYLIB:
          await this.requireMethod('installDylib')(sid, params.dylibPath);
          result = { dylibPath: params.dylibPath };
          break;

        case CommandType.OPEN_URL:
          await this.requireMethod('openUrl')(sid, params.url);
          result = { url: params.url };
          break;

        case CommandType.CLEAR_KEYCHAIN:
          await this.requireMethod('clearKeychain')(sid);
          result = { sessionId: sid };
          break;

        case CommandType.SET_LOCATION:
          await this.requireMethod('setLocation')(sid, params.latitude, params.longitude);
          result = { latitude: params.latitude, longitude: params.longitude };
          break;

        case CommandType.ADD_MEDIA:
          await this.requireMethod('addMedia')(sid, params.mediaPaths);
          result = { mediaPaths: params.mediaPaths };
          break;

        case CommandType.APPROVE_PERMISSIONS:
          await this.requireMethod('approvePermissions')(sid, params.bundleId, params.permissions);
          result = { bundleId: params.bundleId, permissions: params.permissions };
          break;

        case CommandType.UPDATE_CONTACTS:
          await this.requireMethod('updateContacts')(sid, params.dbPath);
          result = { dbPath: params.dbPath };
          break;

        // Verification commands
        case CommandType.IS_SIMULATOR_BOOTED:
          result = await this.idbManager.isSimulatorBooted(
            sid
          );
          break;

        case CommandType.IS_APP_INSTALLED:
          result = await this.idbManager.isAppInstalled(
            sid,
            command.parameters.bundleId
          );
          break;

        default:
          throw new Error(`Unsupported command type: ${command.type}`);
      }

      // Create and return the result
      return {
        success: true,
        data: result,
        timestamp: Date.now()
      };
    } catch (error: any) {
      // Handle errors
      console.error(`Error executing command ${command.type}:`, error);
      
      // If there's a custom error handler, use it
      if (command.onError) {
        return command.onError(error, { sessionId });
      }
      
      // Return error result
      return {
        success: false,
        error: error.message || 'Unknown error',
        timestamp: Date.now()
      };
    }
  }
}
