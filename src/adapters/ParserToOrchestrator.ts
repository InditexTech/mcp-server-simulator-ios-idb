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
    
    // Mapping natural language commands to CommandType
    this.commandMappings = {
      // English command names, as emitted by the parser
      'create session': CommandType.CREATE_SIMULATOR_SESSION,
      'end session': CommandType.TERMINATE_SIMULATOR_SESSION,
      'list simulators': CommandType.LIST_AVAILABLE_SIMULATORS,
      'list booted simulators': CommandType.LIST_BOOTED_SIMULATORS,
      'boot simulator': CommandType.BOOT_SIMULATOR,
      'shutdown simulator': CommandType.SHUTDOWN_SIMULATOR,
      'install app': CommandType.INSTALL_APP,
      'launch app': CommandType.LAUNCH_APP,
      'terminate app': CommandType.TERMINATE_APP,
      'capture screen': CommandType.TAKE_SCREENSHOT,
      'get logs': CommandType.GET_SYSTEM_LOGS,

      // Simulator management commands
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
      'tap': CommandType.TAP,
      'tocar': CommandType.TAP,
      'pulsar': CommandType.TAP,
      'swipe': CommandType.SWIPE,
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
    
    // Look for exact match
    if (this.commandMappings[lowerCommand]) {
      return this.commandMappings[lowerCommand];
    }
    
    // Look for partial match
    for (const [key, value] of Object.entries(this.commandMappings)) {
      if (lowerCommand.includes(key)) {
        return value;
      }
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
