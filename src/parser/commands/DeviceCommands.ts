// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { BaseCommandDefinition, CommandDefinition } from './BaseCommandDefinition.js';

export class DeviceCommands extends BaseCommandDefinition {
  protected definitions: CommandDefinition[] = [
    {
      command: 'create device session',
      patterns: [
        /crear\s+(una\s+)?sesi[oó]n\s+de\s+(?:dispositivo\s+f[ií]sico|device|dispositivo)(?:\s+(?<deviceName>[^,}]+))?/i,
        /conectar\s+(?:al\s+)?(?:dispositivo\s+f[ií]sico|device|dispositivo)(?:\s+(?<deviceName>[^,}]+))?/i,
        /create\s+(?:a\s+)?device\s+session(?:\s+(?:with|on)\s+(?<deviceName>[^,}]+))?/i,
        /connect\s+(?:to\s+)?(?:the\s+)?(?:physical\s+)?device(?:\s+(?<deviceName>[^,}]+))?/i
      ],
      description: 'Creates a new session on a connected physical device',
      requiredParameters: [],
      optionalParameters: ['deviceName'],
      examples: [
        'crear sesión de dispositivo físico',
        'crear sesión de dispositivo iPhone de Arturo',
        'conectar dispositivo 00008101-000A0C123456001E',
        'create device session',
        'create device session with iPhone de Arturo',
        'connect to physical device 00008101-000A0C123456001E'
      ],
      parameterExtractors: {
        deviceName: (match) => trimDeviceName(match.groups?.deviceName)
      }
    },
    {
      command: 'list devices',
      patterns: [
        /listar\s+(?:los\s+)?dispositivos\s+f[ií]sicos/i,
        /mostrar\s+(?:los\s+)?dispositivos\s+f[ií]sicos/i,
        /qu[eé]\s+dispositivos\s+f[ií]sicos\s+(?:hay|est[aá]n\s+conectados)/i,
        /list\s+(?:all\s+)?devices/i,
        /show\s+(?:all\s+)?(?:physical\s+)?devices/i,
        /display\s+(?:all\s+)?devices/i
      ],
      description: 'Lists physical devices paired with this Mac',
      requiredParameters: [],
      optionalParameters: [],
      examples: [
        'listar dispositivos físicos',
        'mostrar dispositivos físicos',
        'qué dispositivos físicos hay',
        'list devices',
        'show all devices',
        'display devices'
      ],
      parameterExtractors: {}
    },
    {
      command: 'check device',
      patterns: [
        /(verificar|comprobar)\s+(?:si\s+)?(?:el\s+)?dispositivo\s+(?:est[aá]\s+)?(?:conectado|disponible)\s*[?.!]*$/i,
        /(verificar|comprobar)\s+(?:si\s+)?(?:el\s+)?dispositivo\s*[?.!]*$/i,
        /(check|verify)\s+(?:if\s+)?(?:the\s+)?device\s+(?:is\s+)?(?:connected|available)\s*[?.!]*$/i,
        /(check|verify)\s+(?:if\s+)?(?:the\s+)?device\s*[?.!]*$/i,
        /is\s+(?:the\s+)?device\s+(?:still\s+)?connected\s*[?.!]*$/i
      ],
      description: 'Checks whether the current device session is still connected',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'verificar dispositivo',
        'comprobar si el dispositivo está conectado',
        'check device',
        'verify the device is connected',
        'is device connected'
      ],
      parameterExtractors: {}
    },
    {
      command: 'get device info',
      patterns: [
        /informaci[oó]n\s+(?:del\s+)?dispositivo/i,
        /detalles\s+del\s+dispositivo/i,
        /device\s+info/i,
        /(?:describe|show)\s+(?:the\s+)?(?:connected\s+)?device/i
      ],
      description: 'Describes the device behind the current session (name, OS, connection)',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'información del dispositivo',
        'detalles del dispositivo',
        'device info',
        'describe the connected device'
      ],
      parameterExtractors: {}
    }
  ];
}

/**
 * Strips trailing punctuation from the loosely captured device name. A name is
 * not enforced against a grammar, so chained instructions like "connect to the
 * device and install the app" capture prose and surface as an actionable
 * "No connected device found" selection error, never as a wrong-device match.
 */
function trimDeviceName(raw?: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trim();
}
