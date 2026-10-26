// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ParseResult } from '../interfaces/IParser.js';
import { BaseCommandDefinition, CommandMatch, isBetterMatch } from './BaseCommandDefinition.js';

export class CommandRegistry {
  private commandHandlers: BaseCommandDefinition[] = [];

  registerHandler(handler: BaseCommandDefinition) {
    this.commandHandlers.push(handler);
  }

  parseInstruction(text: string): ParseResult {
    let best: CommandMatch | null = null;
    for (const handler of this.commandHandlers) {
      const match = handler.findBestMatch(text);
      if (match && (!best || isBetterMatch(match.index, match.length, best))) {
        best = match;
      }
    }
    
    if (best) {
      return best.result;
    }
    
    throw new Error(`Could not understand the instruction: ${text}`);
  }

  async getSupportedCommands(): Promise<Array<{
    command: string;
    description: string;
    requiredParameters: string[];
    optionalParameters: string[];
  }>> {
    return this.commandHandlers
      .flatMap(handler => handler.getDefinitions())
      .map(definition => ({
        command: definition.command,
        description: definition.description,
        requiredParameters: definition.requiredParameters,
        optionalParameters: definition.optionalParameters
      }));
  }

  async suggestCompletions(partialText: string): Promise<string[]> {
    const normalizedPartial = partialText.trim().toLowerCase();
    
    if (!normalizedPartial) {
      return [
        'create session',
        'list simulators',
        'install app',
        'launch app',
        'terminate session'
      ];
    }
    
    const suggestions = new Set<string>();
    
    for (const handler of this.commandHandlers) {
      for (const definition of handler.getDefinitions()) {
        if (definition.command.toLowerCase().includes(normalizedPartial)) {
          suggestions.add(definition.command);
        }
        
        for (const example of definition.examples) {
          if (example.toLowerCase().includes(normalizedPartial)) {
            suggestions.add(example);
          }
        }
      }
    }
    
    return Array.from(suggestions).slice(0, 5);
  }
}
