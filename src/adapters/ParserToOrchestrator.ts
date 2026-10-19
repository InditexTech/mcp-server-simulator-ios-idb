// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ParseResult } from '../parser/interfaces/IParser.js';
import { 
  CommandType, 
  IOrchestratorCommand,
  CommandFactory
} from '../orchestrator/interfaces/IOrchestratorCommand.js';

/**
 * Adapter that converts parser results into orchestrator commands
 */
export class ParserToOrchestrator {
  private commandFactory: CommandFactory;
  private commandMappings: Record<string, CommandType>;

  /**
   * Constructor
   * @param commandFactory Command factory to create IOrchestratorCommand instances
   */
  constructor(commandFactory: CommandFactory) {
    this.commandFactory = commandFactory;
    
    // Canonical command names, exactly as emitted by the parser definitions
    // in src/parser/commands/. Matching is exact: substring matching sent
    // "uninstall app" to INSTALL_APP and "list crash logs" to GET_SYSTEM_LOGS.
    this.commandMappings = {
      // Simulator management commands
      'create session': CommandType.CREATE_SIMULATOR_SESSION,
      'end session': CommandType.TERMINATE_SIMULATOR_SESSION,
      'list simulators': CommandType.LIST_AVAILABLE_SIMULATORS,
      'list booted simulators': CommandType.LIST_BOOTED_SIMULATORS,
      'boot simulator': CommandType.BOOT_SIMULATOR,
      'shutdown simulator': CommandType.SHUTDOWN_SIMULATOR,
      'focus simulator': CommandType.FOCUS_SIMULATOR,

      // Application management commands
      'install app': CommandType.INSTALL_APP,
      'launch app': CommandType.LAUNCH_APP,
      'terminate app': CommandType.TERMINATE_APP,
      'uninstall app': CommandType.UNINSTALL_APP,
      'list apps': CommandType.LIST_APPS,

      // UI interaction commands
      'tap': CommandType.TAP,
      'swipe': CommandType.SWIPE,
      'press device button': CommandType.PRESS_BUTTON,
      'input text': CommandType.INPUT_TEXT,
      'press key': CommandType.PRESS_KEY,
      'press key sequence': CommandType.PRESS_KEY_SEQUENCE,

      // Accessibility commands
      'describe elements': CommandType.DESCRIBE_ALL_ELEMENTS,
      'describe point': CommandType.DESCRIBE_POINT_ELEMENT,

      // Capture and logging commands
      'capture screen': CommandType.TAKE_SCREENSHOT,
      'record video': CommandType.START_VIDEO_RECORDING,
      'stop recording': CommandType.STOP_VIDEO_RECORDING,
      'get logs': CommandType.GET_SYSTEM_LOGS,

      // Debug commands
      'start debug': CommandType.START_DEBUG_SERVER,
      'stop debug': CommandType.STOP_DEBUG_SERVER,
      'debug status': CommandType.GET_DEBUG_SERVER_STATUS,
      'list crash logs': CommandType.LIST_CRASH_LOGS,
      'show crash log': CommandType.GET_CRASH_LOG,
      'delete crash logs': CommandType.DELETE_CRASH_LOGS,

      // Miscellaneous commands
      'install dylib': CommandType.INSTALL_DYLIB,
      'open url': CommandType.OPEN_URL,
      'clear keychain': CommandType.CLEAR_KEYCHAIN,
      'set location': CommandType.SET_LOCATION,
      'add media': CommandType.ADD_MEDIA,
      'approve permissions': CommandType.APPROVE_PERMISSIONS,
      'update contacts': CommandType.UPDATE_CONTACTS,

      // Legacy aliases (mostly Spanish), accepted from custom IParser implementations
      'crear sesión': CommandType.CREATE_SIMULATOR_SESSION,
      'crear simulador': CommandType.CREATE_SIMULATOR_SESSION,
      'iniciar simulador': CommandType.CREATE_SIMULATOR_SESSION,
      'terminar sesión': CommandType.TERMINATE_SIMULATOR_SESSION,
      'cerrar simulador': CommandType.TERMINATE_SIMULATOR_SESSION,
      'listar simuladores': CommandType.LIST_AVAILABLE_SIMULATORS,
      'mostrar simuladores': CommandType.LIST_AVAILABLE_SIMULATORS,
      'listar simuladores arrancados': CommandType.LIST_BOOTED_SIMULATORS,
      'arrancar simulador': CommandType.BOOT_SIMULATOR,
      'apagar simulador': CommandType.SHUTDOWN_SIMULATOR,
      
      // Application management commands
      'instalar app': CommandType.INSTALL_APP,
      'instalar aplicación': CommandType.INSTALL_APP,
      'lanzar app': CommandType.LAUNCH_APP,
      'abrir app': CommandType.LAUNCH_APP,
      'iniciar app': CommandType.LAUNCH_APP,
      'cerrar app': CommandType.TERMINATE_APP,
      'terminar app': CommandType.TERMINATE_APP,
      
      // UI interaction commands
      'tocar': CommandType.TAP,
      'pulsar': CommandType.TAP,
      'deslizar': CommandType.SWIPE,
      
      // Screenshot and logs commands
      'capturar pantalla': CommandType.TAKE_SCREENSHOT,
      'screenshot': CommandType.TAKE_SCREENSHOT,
      'captura': CommandType.TAKE_SCREENSHOT,
      'logs': CommandType.GET_SYSTEM_LOGS,
      'logs del sistema': CommandType.GET_SYSTEM_LOGS,
      'logs de app': CommandType.GET_APP_LOGS,
      
      // Verification commands
      'verificar simulador': CommandType.IS_SIMULATOR_BOOTED,
      'comprobar simulador': CommandType.IS_SIMULATOR_BOOTED,
      'verificar app': CommandType.IS_APP_INSTALLED,
      'comprobar app': CommandType.IS_APP_INSTALLED
    };
  }

  /**
   * Converts a parser result into an orchestrator command
   * @param parseResult Parser result
   * @returns Orchestrator command
   */
  public convertToCommand(parseResult: ParseResult): IOrchestratorCommand {
    // Determine command type
    const commandType = this.mapToCommandType(parseResult.command);
    
    // Convert parameters
    const parameters = this.convertParameters(commandType, parseResult.parameters);
    
    // Create and return command
    return this.commandFactory.createCommand(
      commandType,
      parameters,
      `Command generated from: "${parseResult.originalText}"`
    );
  }

  /**
   * Maps a natural language command to a CommandType
   * @param naturalCommand Natural language command
   * @returns Corresponding CommandType
   */
  private mapToCommandType(naturalCommand: string): CommandType {
    const lowerCommand = naturalCommand.toLowerCase();
    
    if (Object.prototype.hasOwnProperty.call(this.commandMappings, lowerCommand)) {
      return this.commandMappings[lowerCommand];
    }
    
    // If no match found, throw error
    throw new Error(`Could not map command "${naturalCommand}" to a CommandType`);
  }

  /**
   * Converts parser parameters to orchestrator parameters
   * @param commandType Command type
   * @param parserParameters Parser parameters
   * @returns Orchestrator parameters
   */
  private convertParameters(
    commandType: CommandType, 
    parserParameters: Record<string, any>
  ): Record<string, any> {
    // Clone parameters to avoid modifying the original
    const parameters = { ...parserParameters };
    
    // Convert specific parameters based on command type
    switch (commandType) {
      case CommandType.TAP:
        // Ensure x and y are numbers
        if (parameters.x !== undefined) {
          parameters.x = Number(parameters.x);
        }
        if (parameters.y !== undefined) {
          parameters.y = Number(parameters.y);
        }
        break;
        
      case CommandType.SWIPE:
        // Ensure coordinates are numbers
        if (parameters.startX !== undefined) {
          parameters.startX = Number(parameters.startX);
        }
        if (parameters.startY !== undefined) {
          parameters.startY = Number(parameters.startY);
        }
        if (parameters.endX !== undefined) {
          parameters.endX = Number(parameters.endX);
        }
        if (parameters.endY !== undefined) {
          parameters.endY = Number(parameters.endY);
        }
        if (parameters.duration !== undefined) {
          parameters.duration = Number(parameters.duration);
        }
        break;
        
      case CommandType.GET_SYSTEM_LOGS:
        // The parser extracts bundleId; IDBManager reads it from options.bundle
        if (parameters.bundleId !== undefined) {
          parameters.options = { ...parameters.options, bundle: String(parameters.bundleId) };
        }
        break;

      case CommandType.GET_CRASH_LOG:
        // Numeric-looking names are turned into numbers by parameter normalization
        if (parameters.crashName !== undefined) {
          parameters.crashName = String(parameters.crashName);
        }
        break;
        
      case CommandType.CREATE_SIMULATOR_SESSION:
        // Convert autoboot to boolean if it's a string
        if (typeof parameters.autoboot === 'string') {
          parameters.autoboot = parameters.autoboot.toLowerCase() === 'true';
        }
        break;
    }
    
    return parameters;
  }
}
