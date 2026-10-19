// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { IParser, ParseResult } from '../parser/interfaces/IParser.js';
import { 
  IOrchestratorCommand, 
  CommandType, 
  CommandResult, 
  CommandContext,
  SequenceCommand,
  ConditionalCommand
} from './interfaces/IOrchestratorCommand.js';
import { ParserToOrchestrator } from '../adapters/ParserToOrchestrator.js';
import { OrchestratorToIDB } from '../adapters/OrchestratorToIDB.js';
import { IIDBManager } from '../idb/interfaces/IIDBManager.js';

/**
 * Implementation of the command factory
 */
class CommandFactoryImpl {
  /**
   * Creates an orchestrator command
   * @param type Command type
   * @param parameters Command parameters
   * @param description Command description
   * @returns Created command
   */
  createCommand(type: CommandType, parameters: Record<string, any>, description?: string): IOrchestratorCommand {
    return {
      type,
      parameters,
      id: randomUUID(),
      description,
      timeout: 30000, // 30 seconds by default
      retries: 1      // 1 retry by default
    };
  }

  /**
   * Creates a sequence command
   * @param commands Commands to execute in sequence
   * @param stopOnError Whether to stop on error
   * @returns Sequence command
   */
  createSequence(commands: IOrchestratorCommand[], stopOnError: boolean = true): SequenceCommand {
    return {
      type: CommandType.SEQUENCE,
      parameters: {
        commands,
        stopOnError
      },
      id: randomUUID(),
      description: `Sequence of ${commands.length} commands`
    };
  }

  /**
   * Creates a conditional command
   * @param condition Condition function
   * @param ifTrue Command to execute if condition is true
   * @param ifFalse Command to execute if condition is false
   * @returns Conditional command
   */
  createConditional(
    condition: (context: CommandContext) => Promise<boolean>,
    ifTrue: IOrchestratorCommand,
    ifFalse?: IOrchestratorCommand
  ): ConditionalCommand {
    return {
      type: CommandType.CONDITIONAL,
      parameters: {
        condition,
        ifTrue,
        ifFalse
      },
      id: randomUUID(),
      description: 'Conditional command'
    };
  }
}

/**
 * MCP Central Orchestrator
 * 
 * Coordinates interactions between the natural language parser and the IDB manager,
 * facilitating the execution of iOS simulator commands.
 */
export class MCPOrchestrator {
  private parser: IParser;
  private idbManager: IIDBManager;
  private parserToOrchestrator: ParserToOrchestrator;
  private orchestratorToIDB: OrchestratorToIDB;
  private commandFactory: CommandFactoryImpl;
  private activeSessionId: string | null = null;
  private commandHistory: Array<{
    command: IOrchestratorCommand;
    result: CommandResult;
    timestamp: number;
  }> = [];
  private eventListeners: Record<string, Array<(data: any) => void>> = {};

  /**
   * Constructor
   * @param parser Natural language parser instance
   * @param idbManager IDB manager instance
   */
  constructor(parser: IParser, idbManager: IIDBManager) {
    this.parser = parser;
    this.idbManager = idbManager;
    this.commandFactory = new CommandFactoryImpl();
    this.parserToOrchestrator = new ParserToOrchestrator(this.commandFactory);
    this.orchestratorToIDB = new OrchestratorToIDB(idbManager);
  }

  /**
   * Processes a natural language instruction
   * @param instruction Natural language instruction
   * @returns Execution result
   */
  public async processInstruction(instruction: string): Promise<CommandResult> {
    try {
      // Parse the instruction
      const parseResult = await this.parser.parseInstruction(instruction);
      
      // Validate the instruction
      const validationResult = await this.parser.validateInstruction(parseResult);
      if (!validationResult.isValid) {
        return {
          success: false,
          error: validationResult.errorMessage || 'Invalid instruction',
          timestamp: Date.now()
        };
      }
      
      // Normalize parameters
      const normalizedResult = await this.parser.normalizeParameters(parseResult);
      
      // Convert to orchestrator command
      const command = this.parserToOrchestrator.convertToCommand(normalizedResult);
      
      // Execute the command
      return this.executeCommand(command);
    } catch (error: any) {
      console.error('Error processing instruction:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Executes an orchestrator command
   * @param command Command to execute
   * @returns Execution result
   */
  public async executeCommand(command: IOrchestratorCommand): Promise<CommandResult> {
    try {
      let result: CommandResult;
      
      // Execute command based on its type
      if (command.type === CommandType.SEQUENCE) {
        result = await this.executeSequenceCommand(command as SequenceCommand);
      } else if (command.type === CommandType.CONDITIONAL) {
        result = await this.executeConditionalCommand(command as ConditionalCommand);
      } else {
        // Validate parameters if validation function exists
        if (command.validate) {
          const isValid = await command.validate({ 
            sessionId: this.activeSessionId || undefined 
          });
          if (!isValid) {
            return {
              success: false,
              error: 'Parameter validation failed',
              timestamp: Date.now()
            };
          }
        }
        
        // Transform parameters if transformation function exists
        if (command.transformParameters) {
          command.parameters = await command.transformParameters({ 
            sessionId: this.activeSessionId || undefined 
          });
        }
        
        // Execute the command
        result = await this.orchestratorToIDB.executeCommand(command, this.activeSessionId || undefined);
        
        // If it's a session creation command and successful, save the session ID
        if (command.type === CommandType.CREATE_SIMULATOR_SESSION && result.success && result.data) {
          this.activeSessionId = result.data;
          this.emit('sessionCreated', { sessionId: this.activeSessionId });
        }
        
        // If it's a session termination command and successful, clear the session ID
        if (command.type === CommandType.TERMINATE_SIMULATOR_SESSION && result.success) {
          const oldSessionId = this.activeSessionId;
          this.activeSessionId = null;
          this.emit('sessionTerminated', { sessionId: oldSessionId });
        }
      }
      
      // Save to history
      this.commandHistory.push({
        command,
        result,
        timestamp: Date.now()
      });
      
      // Emit command executed event
      this.emit('commandExecuted', {
        command,
        result
      });
      
      return result;
    } catch (error: any) {
      console.error('Error executing command:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Executes a sequence command
   * @param sequenceCommand Sequence command
   * @returns Execution result
   */
  private async executeSequenceCommand(sequenceCommand: SequenceCommand): Promise<CommandResult> {
    const results: CommandResult[] = [];
    const context: CommandContext = {
      sessionId: this.activeSessionId || undefined,
      previousResults: {},
      variables: {}
    };
    
    try {
      // Execute each command in sequence
      for (const command of sequenceCommand.parameters.commands) {
        const result = await this.executeCommand(command);
        results.push(result);
        
        // Save result in context
        context.previousResults![command.id] = result;
        
        // If there's an error and stopOnError is true, stop execution
        if (!result.success && sequenceCommand.parameters.stopOnError) {
          return {
            success: false,
            data: {
              results,
              completedCommands: sequenceCommand.parameters.commands.indexOf(command) + 1,
              totalCommands: sequenceCommand.parameters.commands.length
            },
            error: `Error in command ${command.id}: ${result.error}`,
            timestamp: Date.now()
          };
        }
      }
      
      // All commands executed successfully
      return {
        success: true,
        data: {
          results,
          completedCommands: sequenceCommand.parameters.commands.length,
          totalCommands: sequenceCommand.parameters.commands.length
        },
        timestamp: Date.now()
      };
    } catch (error: any) {
      console.error('Error executing sequence:', error);
      return {
        success: false,
        data: {
          results,
          completedCommands: results.length,
          totalCommands: sequenceCommand.parameters.commands.length
        },
        error: error.message || 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Executes a conditional command
   * @param conditionalCommand Conditional command
   * @returns Execution result
   */
  private async executeConditionalCommand(conditionalCommand: ConditionalCommand): Promise<CommandResult> {
    try {
      // Evaluate condition
      const context: CommandContext = {
        sessionId: this.activeSessionId || undefined,
        previousResults: {},
        variables: {}
      };
      
      const conditionResult = await conditionalCommand.parameters.condition(context);
      
      // Execute corresponding command based on condition result
      if (conditionResult) {
        return this.executeCommand(conditionalCommand.parameters.ifTrue);
      } else if (conditionalCommand.parameters.ifFalse) {
        return this.executeCommand(conditionalCommand.parameters.ifFalse);
      } else {
        // No command for false case
        return {
          success: true,
          data: {
            conditionResult,
            executed: false
          },
          timestamp: Date.now()
        };
      }
    } catch (error: any) {
      console.error('Error executing conditional command:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Gets command history
   * @param limit Command limit to return (optional)
   * @returns Command history
   */
  public getCommandHistory(limit?: number): Array<{
    command: IOrchestratorCommand;
    result: CommandResult;
    timestamp: number;
  }> {
    if (limit) {
      return this.commandHistory.slice(-limit);
    }
    return [...this.commandHistory];
  }

  /**
   * Gets the active session ID
   * @returns Active session ID or null if no active session
   */
  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /**
   * Sets the active session ID
   * @param sessionId Session ID to set
   */
  public setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    if (sessionId) {
      this.emit('sessionActivated', { sessionId });
    } else {
      this.emit('sessionDeactivated', {});
    }
  }

  /**
   * Registers an event listener
   * @param event Event name
   * @param listener Function to execute when event occurs
   */
  public on(event: string, listener: (data: any) => void): void {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(listener);
  }

  /**
   * Removes an event listener
   * @param event Event name
   * @param listener Function to remove
   */
  public off(event: string, listener: (data: any) => void): void {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(l => l !== listener);
    }
  }

  /**
   * Emits an event
   * @param event Event name
   * @param data Event data
   */
  private emit(event: string, data: any): void {
    if (this.eventListeners[event]) {
      for (const listener of this.eventListeners[event]) {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in event listener ${event}:`, error);
        }
      }
    }
  }
}
