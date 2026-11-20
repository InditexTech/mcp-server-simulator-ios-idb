// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { BaseCommandDefinition, CommandDefinition } from './BaseCommandDefinition.js';
import { AccessibilityMatchKey } from '../../idb/interfaces/IIDBManager.js';

function unquoteMarker(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const inner = trimmed.slice(1, -1);
    return inner.trim().length > 0 ? inner : undefined;
  }
  return trimmed;
}

export class AccessibilityCommands extends BaseCommandDefinition {
  protected definitions: CommandDefinition[] = [
    {
      command: 'describe elements',
      patterns: [
        /describir\s+(todos\s+los\s+)?elementos/i,
        /describe\s+all\s+elements/i,
        /mostrar\s+elementos\s+de\s+accesibilidad/i
      ],
      description: 'Describes all accessibility elements on the screen',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'describir todos los elementos',
        'describe all elements',
        'mostrar elementos de accesibilidad'
      ],
      parameterExtractors: {}
    },
    {
      command: 'describe point',
      patterns: [
        /describir\s+punto\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i,
        /describe\s+point\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i,
        /qué\s+hay\s+en\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i
      ],
      description: 'Describes the accessibility element at a specific point',
      requiredParameters: ['x', 'y'],
      optionalParameters: ['sessionId'],
      examples: [
        'describir punto 100, 200',
        'describe point 150, 300',
        'qué hay en 200, 400'
      ],
      parameterExtractors: {
        x: (match) => parseInt(match.groups?.x || '0', 10),
        y: (match) => parseInt(match.groups?.y || '0', 10)
      }
    },
    {
      command: 'tap element',
      patterns: [
        /^(?:tap|press|activate|select)\s+(?:the\s+)?(?:accessibility\s+)?element\s+(?:with\s+|by\s+)?(?:id|identifier)\s+(?<idMarker>.+)$/i,
        /^(?:tocar|pulsar|activar|seleccionar)\s+(?:el\s+)?elemento(?:\s+de\s+accesibilidad)?\s+(?:con\s+|por\s+)?(?:id|identificador)\s+(?<idMarker>.+)$/i,
        /^(?:tap|press|activate|select)\s+(?:the\s+)?(?:accessibility\s+)?element(?:\s+(?:with\s+|by\s+)?label)?\s+(?!(?:with\s+|by\s+)?(?:id|identifier)(?:\s|$))(?<labelMarker>.+)$/i,
        /^(?:tocar|pulsar|activar|seleccionar)\s+(?:el\s+)?elemento(?:\s+de\s+accesibilidad)?(?:\s+(?:con\s+|por\s+)?etiqueta)?\s+(?!(?:con\s+|por\s+)?(?:id|identificador)(?:\s|$))(?<labelMarker>.+)$/i
      ],
      description: 'Activates an accessibility element by label or unique identifier',
      requiredParameters: ['marker'],
      optionalParameters: ['matchKey', 'sessionId'],
      examples: [
        'tap element "Play"',
        'tap element Settings',
        'tap element with id "fixtureSecondaryButton"',
        'activate element by id loginButton',
        'tocar elemento "Reproducir"',
        'pulsar elemento con id "fixtureSecondaryButton"'
      ],
      parameterExtractors: {
        marker: (match) => unquoteMarker(match.groups?.idMarker ?? match.groups?.labelMarker),
        matchKey: (match): AccessibilityMatchKey =>
          match.groups?.idMarker !== undefined ? 'AXUniqueId' : 'AXLabel'
      }
    }
  ];
}
