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
    return this.findBestMatch(text)?.result ?? null;
  }

  /**
   * Finds the definition whose pattern matches earliest in the text, preferring
   * the longest match on ties, so a command name inside free text (a path, a
   * URL, text to type) does not win over the command the instruction starts with
   * @param text Instruction text
   * @returns Best match with its position and length, or null
   */
  findBestMatch(text: string): CommandMatch | null {
    // Patterns are case-insensitive; matching the original text keeps the case
    // of captured values (text to type, paths, bundle IDs).
    const trimmedText = text.trim();
    let best: CommandMatch | null = null;
    
    for (const definition of this.definitions) {
      for (const pattern of definition.patterns) {
        const match = trimmedText.match(pattern);
        if (!match || match.index === undefined) {
          continue;
        }
        if (best && !isBetterMatch(match.index, match[0].length, best)) {
          continue;
        }
        
        const parameters: Record<string, any> = {};
        for (const [paramName, extractor] of Object.entries(definition.parameterExtractors)) {
          const value = extractor(match);
          if (value !== undefined) {
            parameters[paramName] = value;
          }
        }
        
        best = {
          index: match.index,
          length: match[0].length,
          result: {
            command: definition.command,
            parameters,
            confidence: 0.9,
            originalText: text
          }
        };
      }
    }
    
    return best;
  }
}

export interface CommandMatch {
  index: number;
  length: number;
  result: ParseResult;
}

/**
 * Earlier matches win; on the same position the longer match wins. Equal
 * matches keep the one found first, so registration order breaks ties.
 */
export function isBetterMatch(index: number, length: number, current: CommandMatch): boolean {
  return index < current.index || (index === current.index && length > current.length);
}
