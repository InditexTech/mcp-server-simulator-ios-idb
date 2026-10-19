// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ParseResult } from '../interfaces/IParser.js';

export interface CommandDefinition {
  command: string;
  patterns: RegExp[];
  description: string;
  requiredParameters: string[];
  optionalParameters: string[];
  examples: string[];
  parameterExtractors: Record<string, (match: RegExpMatchArray) => any>;
}

export abstract class BaseCommandDefinition {
  protected abstract definitions: CommandDefinition[];

  getDefinitions(): CommandDefinition[] {
    return this.definitions;
  }

  parseCommand(text: string): ParseResult | null {
    // Patterns are case-insensitive; matching the original text keeps the case
    // of captured values (text to type, paths, bundle IDs).
    const trimmedText = text.trim();
    
    for (const definition of this.definitions) {
      for (const pattern of definition.patterns) {
        const match = trimmedText.match(pattern);
        if (match) {
          const parameters: Record<string, any> = {};
          for (const [paramName, extractor] of Object.entries(definition.parameterExtractors)) {
            const value = extractor(match);
            if (value !== undefined) {
              parameters[paramName] = value;
            }
          }
          
          return {
            command: definition.command,
            parameters,
            confidence: 0.9,
            originalText: text
          };
        }
      }
    }
    
    return null;
  }
}
