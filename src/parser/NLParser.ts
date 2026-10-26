// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { IParser, ParseResult, ValidationResult } from './interfaces/IParser.js';
import { CommandRegistry } from './commands/CommandRegistry.js';
import { SimulatorCommands } from './commands/SimulatorCommands.js';
import { AppCommands } from './commands/AppCommands.js';
import { UICommands } from './commands/UICommands.js';
import { AccessibilityCommands } from './commands/AccessibilityCommands.js';
import { CaptureCommands } from './commands/CaptureCommands.js';
import { DebugCommands } from './commands/DebugCommands.js';
import { MiscCommands } from './commands/MiscCommands.js';

// Free-text parameters are passed through verbatim: converting them would turn
// a PIN like "0123" into 123 or the text "TRUE" into the boolean true.
const VERBATIM_PARAMETERS = new Set([
  'text',
  'crashName',
  'bundleId',
  'url',
  'appPath',
  'outputPath',
  'dylibPath',
  'dbPath',
  'deviceName',
  'udid',
  'recordingId'
]);

/**
 * Natural language parser implementation
 */
export class NLParser implements IParser {
  private commandRegistry: CommandRegistry;

  /**
   * Constructor
   */
  constructor() {
    this.commandRegistry = new CommandRegistry();
    
    // Register all command handlers
    this.commandRegistry.registerHandler(new SimulatorCommands());
    this.commandRegistry.registerHandler(new AppCommands());
    this.commandRegistry.registerHandler(new UICommands());
    this.commandRegistry.registerHandler(new AccessibilityCommands());
    this.commandRegistry.registerHandler(new CaptureCommands());
    this.commandRegistry.registerHandler(new DebugCommands());
    this.commandRegistry.registerHandler(new MiscCommands());
  }

  /**
   * Parses a natural language instruction into a command structure
   * @param text Natural language instruction text
   * @returns Parsing result with extracted command and parameters
   */
  async parseInstruction(text: string): Promise<ParseResult> {
    return this.commandRegistry.parseInstruction(text);
  }

  /**
   * Validates if an instruction has all required parameters
   * @param parseResult Parsing result to validate
   * @returns Validation result
   */
  async validateInstruction(parseResult: ParseResult): Promise<ValidationResult> {
    // Get supported command definitions
    const supportedCommands = await this.commandRegistry.getSupportedCommands();
    const definition = supportedCommands.find(cmd => cmd.command === parseResult.command);
    
    if (!definition) {
      return {
        isValid: false,
        errorMessage: `Unrecognized command: ${parseResult.command}`
      };
    }
    
    // Verify required parameters
    const missingParameters = definition.requiredParameters.filter(
      param => !(param in parseResult.parameters)
    );
    
    if (missingParameters.length > 0) {
      return {
        isValid: false,
        missingParameters,
        errorMessage: `Missing required parameters: ${missingParameters.join(', ')}`
      };
    }
    
    // Validate parameter types
    const invalidParameters: Record<string, string> = {};
    for (const [param, value] of Object.entries(parseResult.parameters)) {
      if (typeof value === 'undefined' || value === null) {
        invalidParameters[param] = 'Value cannot be null or undefined';
      }
    }
    
    if (Object.keys(invalidParameters).length > 0) {
      return {
        isValid: false,
        invalidParameters,
        errorMessage: 'Some parameters have invalid values'
      };
    }
    
    return {
      isValid: true
    };
  }

  /**
   * Normalizes parameters of a parsed instruction
   * @param parseResult Parsing result to normalize
   * @returns Parsing result with normalized parameters
   */
  async normalizeParameters(parseResult: ParseResult): Promise<ParseResult> {
    const normalizedParameters = { ...parseResult.parameters };
    
    // Normalize numeric values
    for (const [key, value] of Object.entries(normalizedParameters)) {
      if (VERBATIM_PARAMETERS.has(key)) {
        continue;
      }
      if (typeof value === 'string' && !isNaN(Number(value))) {
        normalizedParameters[key] = Number(value);
      }
    }
    
    // Normalize booleans
    for (const [key, value] of Object.entries(normalizedParameters)) {
      if (VERBATIM_PARAMETERS.has(key)) {
        continue;
      }
      if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) {
        normalizedParameters[key] = value.toLowerCase() === 'true';
      }
    }
    
    return {
      ...parseResult,
      parameters: normalizedParameters
    };
  }

  /**
   * Generates suggestions to complete an incomplete instruction
   * @param partialText Partial instruction text
   * @returns List of suggestions to complete the instruction
   */
  async suggestCompletions(partialText: string): Promise<string[]> {
    return this.commandRegistry.suggestCompletions(partialText);
  }

  /**
   * Gets the list of commands supported by the parser
   * @returns List of supported commands with their descriptions
   */
  async getSupportedCommands(): Promise<Array<{
    command: string;
    description: string;
    requiredParameters: string[];
    optionalParameters: string[];
  }>> {
    return this.commandRegistry.getSupportedCommands();
  }
}
