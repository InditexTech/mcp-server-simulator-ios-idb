// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { BaseCommandDefinition, CommandDefinition } from './BaseCommandDefinition.js';

export class UICommands extends BaseCommandDefinition {
  protected definitions: CommandDefinition[] = [
    {
      command: 'tap',
      patterns: [
        /tap(\s+at)?\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i,
        /tocar(\s+en)?\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i,
        /pulsar(\s+en)?\s+(?<x>\d+)\s*,\s*(?<y>\d+)/i
      ],
      description: 'Performs a tap at the specified coordinates',
      requiredParameters: ['x', 'y'],
      optionalParameters: ['sessionId', 'duration'],
      examples: [
        'tocar 150, 300',
        'pulsar en 200, 400',
        'tap at 100, 200',
        'tap 150, 300'
      ],
      parameterExtractors: {
        x: (match) => parseInt(match.groups?.x || '0', 10),
        y: (match) => parseInt(match.groups?.y || '0', 10)
      }
    },
    {
      command: 'swipe',
      patterns: [
        /swipe\s+from\s+(?<startX>\d+)\s*,\s*(?<startY>\d+)\s+to\s+(?<endX>\d+)\s*,\s*(?<endY>\d+)(\s+with\s+duration\s+(?<duration>\d+))?/i,
        /deslizar\s+desde\s+(?<startX>\d+)\s*,\s*(?<startY>\d+)\s+hasta\s+(?<endX>\d+)\s*,\s*(?<endY>\d+)(\s+con\s+duración\s+(?<duration>\d+))?/i
      ],
      description: 'Performs a swipe from one point to another',
      requiredParameters: ['startX', 'startY', 'endX', 'endY'],
      optionalParameters: ['duration', 'delta', 'sessionId'],
      examples: [
        'deslizar desde 150, 300 hasta 150, 100 con duración 500',
        'swipe from 100, 200 to 300, 400',
        'swipe from 150, 300 to 150, 100 with duration 500'
      ],
      parameterExtractors: {
        startX: (match) => parseInt(match.groups?.startX || '0', 10),
        startY: (match) => parseInt(match.groups?.startY || '0', 10),
        endX: (match) => parseInt(match.groups?.endX || '0', 10),
        endY: (match) => parseInt(match.groups?.endY || '0', 10),
        duration: (match) => match.groups?.duration ? parseInt(match.groups.duration, 10) : undefined
      }
    },
    {
      command: 'press device button',
      patterns: [
        /presionar\s+(el\s+)?botón\s+del\s+dispositivo\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i,
        /pulsar\s+(el\s+)?botón\s+del\s+dispositivo\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i,
        /presionar\s+(el\s+)?botón\s+físico\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i,
        /press\s+(the\s+)?device\s+button\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i,
        /push\s+(the\s+)?device\s+button\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i,
        /tap\s+(the\s+)?device\s+button\s+(?<button>APPLE_PAY|HOME|LOCK|SIDE_BUTTON|SIRI)/i
      ],
      description: 'Presses a hardware device button',
      requiredParameters: ['button'],
      optionalParameters: ['duration', 'sessionId'],
      examples: [
        'presionar botón del dispositivo HOME',
        'pulsar botón del dispositivo SIRI',
        'presionar botón físico HOME',
        'press device button HOME',
        'push device button SIRI',
        'tap device button LOCK'
      ],
      parameterExtractors: {
        button: (match) => match.groups?.button?.trim().toUpperCase() as any
      }
    },
    {
      command: 'input text',
      patterns: [
        /introducir\s+texto\s+(?<text>.+)/i,
        /escribir\s+texto\s+(?<text>.+)/i,
        /input\s+text\s+(?<text>.+)/i,
        /type\s+text\s+(?<text>.+)/i,
        /enter\s+text\s+(?<text>.+)/i
      ],
      description: 'Inputs text in the simulator',
      requiredParameters: ['text'],
      optionalParameters: ['sessionId'],
      examples: [
        'introducir texto Hola mundo',
        'escribir texto Prueba de texto',
        'input text Hello world',
        'type text Test message',
        'enter text Hello'
      ],
      parameterExtractors: {
        text: (match) => match.groups?.text?.trim()
      }
    },
    {
      command: 'press key',
      patterns: [
        /presionar\s+(la\s+)?tecla\s+(?<keyCode>\d+)/i,
        /pulsar\s+(la\s+)?tecla\s+(?<keyCode>\d+)/i,
        /press\s+key\s+(?<keyCode>\d+)/i,
        /hit\s+key\s+(?<keyCode>\d+)/i,
        /type\s+key\s+(?<keyCode>\d+)/i
      ],
      description: 'Presses a specific key by its code',
      requiredParameters: ['keyCode'],
      optionalParameters: ['duration', 'sessionId'],
      examples: [
        'presionar tecla 4',
        'pulsar la tecla 65',
        'press key 4',
        'hit key 65',
        'type key 13'
      ],
      parameterExtractors: {
        keyCode: (match) => parseInt(match.groups?.keyCode || '0', 10)
      }
    },
    {
      command: 'press key sequence',
      patterns: [
        /presionar\s+secuencia\s+de\s+teclas\s+(?<keyCodes>[\d\s]+)/i,
        /pulsar\s+secuencia\s+de\s+teclas\s+(?<keyCodes>[\d\s]+)/i,
        /press\s+key\s+sequence\s+(?<keyCodes>[\d\s]+)/i,
        /type\s+key\s+sequence\s+(?<keyCodes>[\d\s]+)/i,
        /enter\s+key\s+sequence\s+(?<keyCodes>[\d\s]+)/i
      ],
      description: 'Presses a sequence of keys',
      requiredParameters: ['keyCodes'],
      optionalParameters: ['sessionId'],
      examples: [
        'presionar secuencia de teclas 4 5 6',
        'pulsar secuencia de teclas 65 66 67',
        'press key sequence 4 5 6',
        'type key sequence 65 66 67',
        'enter key sequence 13 14 15'
      ],
      parameterExtractors: {
        keyCodes: (match) => match.groups?.keyCodes?.trim().split(/\s+/).map(k => parseInt(k, 10))
      }
    }
  ];
}
