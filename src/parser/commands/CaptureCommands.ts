// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { BaseCommandDefinition, CommandDefinition } from './BaseCommandDefinition.js';

function normalizeScreenshotDisplay(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (
    cleaned === 'pantalla' ||
    cleaned === 'la pantalla' ||
    cleaned === 'screen' ||
    cleaned === 'the screen'
  ) {
    return undefined;
  }
  if (
    cleaned === 'todas las pantallas' ||
    cleaned === 'ambas pantallas' ||
    cleaned === 'todas' ||
    cleaned === 'ambas' ||
    cleaned === 'all' ||
    cleaned === 'all displays' ||
    cleaned === 'all screens' ||
    cleaned === 'both' ||
    cleaned === 'both displays' ||
    cleaned === 'both screens'
  ) {
    return 'all';
  }
  if (
    /^(?:la\s+)?pantalla\s+(?:exterior|externa)$/.test(cleaned) ||
    cleaned === 'outer' ||
    cleaned === 'outer display' ||
    cleaned === 'outer screen' ||
    cleaned === 'cover' ||
    cleaned === 'cover display' ||
    cleaned === 'cover screen'
  ) {
    return 'outer';
  }
  if (
    /^(?:la\s+)?pantalla\s+(?:interior|interna)$/.test(cleaned) ||
    cleaned === 'inner' ||
    cleaned === 'inner display' ||
    cleaned === 'inner screen'
  ) {
    return 'inner';
  }
  if (
    /^(?:la\s+)?pantalla\s+activa$/.test(cleaned) ||
    cleaned === 'active' ||
    cleaned === 'active display' ||
    cleaned === 'active screen'
  ) {
    return 'active';
  }
  if (
    /^(?:la\s+)?pantalla\s+principal$/.test(cleaned) ||
    cleaned === 'main' ||
    cleaned === 'main display' ||
    cleaned === 'main screen'
  ) {
    return 'main';
  }

  const stripped = cleaned.replace(/^(?:la\s+)?(?:pantalla|display|screen)\s+/i, '').trim();
  return stripped || undefined;
}

export class CaptureCommands extends BaseCommandDefinition {
  protected definitions: CommandDefinition[] = [
    {
      command: 'capture screen',
      patterns: [
        /^(?:tomar?|hacer|sacar)\s+(?:una\s+)?captura(?:\s+de\s+(?<display>todas\s+las\s+pantallas|ambas\s+pantallas|(?:la\s+)?pantalla(?:\s+(?!en\b)[a-z0-9-]+)?))?(?:\s+en\s+(?<outputPath>[^\s,]+)|[.!?]*)$/i,
        /^capturar\s+(?<display>todas\s+las\s+pantallas|ambas\s+pantallas|(?:la\s+)?pantalla(?:\s+(?!en\b)[a-z0-9-]+)?)(?:\s+en\s+(?<outputPath>[^\s,]+)|[.!?]*)$/i,
        /^screenshot(?:\s+de\s+(?<display>todas\s+las\s+pantallas|ambas\s+pantallas|(?:la\s+)?pantalla\s+(?!en\b)[a-z0-9-]+))?(?:\s+en\s+(?<outputPath>[^\s,]+)|[.!?]*)$/i,
        /^take\s+(?:a\s+)?screenshot(?:\s+(?:of|from)\s+(?:the\s+)?(?<display>(?:all|both)(?:\s+(?:displays|screens))?|(?:outer|inner|cover|active|main|primary(?:-1)?)(?:\s+(?:display|screen))?|(?:display|screen)\s+[a-z0-9-]+))?(?:\s+to\s+(?<outputPath>[^\s,]+)|[.!?]*)$/i,
        /^capture\s+(?:the\s+)?(?<display>all\s+(?:displays|screens)|both\s+(?:displays|screens)|(?:outer|inner|cover|active|main|primary(?:-1)?)\s+(?:display|screen)|screen)(?:\s+to\s+(?<outputPath>[^\s,]+)|[.!?]*)$/i
      ],
      description: 'Captures a screenshot of the simulator (active display by default, a specific display, or all displays)',
      requiredParameters: [],
      optionalParameters: ['outputPath', 'display', 'sessionId'],
      examples: [
        'capturar pantalla',
        'screenshot en /ruta/captura.png',
        'tomar una captura',
        'toma captura de todas las pantallas',
        'capturar pantalla interior en /ruta/interior.png',
        'capture screen',
        'take screenshot to /path/capture.png',
        'take screenshot of all displays',
        'take screenshot of outer display to /path/outer.png'
      ],
      parameterExtractors: {
        outputPath: (match) => match.groups?.outputPath?.trim(),
        display: (match) => normalizeScreenshotDisplay(match.groups?.display)
      }
    },
    {
      command: 'record video',
      patterns: [
        /grabar\s+video\s+(?<outputPath>[^\s,]+)/i,
        /record\s+video\s+(?<outputPath>[^\s,]+)/i,
        /iniciar\s+grabación\s+de\s+video\s+(?<outputPath>[^\s,]+)/i,
        /start\s+recording\s+video\s+(?<outputPath>[^\s,]+)/i,
        /begin\s+video\s+recording\s+(?<outputPath>[^\s,]+)/i
      ],
      description: 'Starts video recording of the simulator',
      requiredParameters: ['outputPath'],
      optionalParameters: ['sessionId'],
      examples: [
        'grabar video /ruta/video.mp4',
        'record video /tmp/captura.mp4',
        'iniciar grabación de video /ruta/salida.mp4',
        'record video /path/video.mp4',
        'start recording video /path/output.mp4'
      ],
      parameterExtractors: {
        outputPath: (match) => match.groups?.outputPath?.trim()
      }
    },
    {
      command: 'stop recording',
      patterns: [
        /detener\s+grabación(\s+de\s+video)?/i,
        /parar\s+grabación(\s+de\s+video)?/i,
        /stop\s+recording/i,
        /end\s+recording/i,
        /stop\s+video\s+recording/i
      ],
      description: 'Stops video recording of the simulator',
      requiredParameters: [],
      optionalParameters: ['recordingId', 'sessionId'],
      examples: [
        'detener grabación',
        'parar grabación de video',
        'stop recording',
        'end recording',
        'stop video recording'
      ],
      parameterExtractors: {}
    },
    {
      command: 'get logs',
      patterns: [
        /obtener\s+logs(\s+de\s+(?<bundleId>[^\s,]+))?/i,
        /mostrar\s+logs(\s+de\s+(?<bundleId>[^\s,]+))?/i,
        /get\s+logs(\s+for\s+(?<bundleId>[^\s,]+))?/i,
        /show\s+logs(\s+for\s+(?<bundleId>[^\s,]+))?/i,
        /display\s+logs(\s+for\s+(?<bundleId>[^\s,]+))?/i
      ],
      description: 'Gets system logs or logs from a specific application',
      requiredParameters: [],
      optionalParameters: ['bundleId', 'limit', 'sessionId'],
      examples: [
        'obtener logs',
        'mostrar logs de com.example.app',
        'get logs for com.apple.mobilesafari',
        'show logs',
        'display logs for com.example.app'
      ],
      parameterExtractors: {
        bundleId: (match) => match.groups?.bundleId?.trim()
      }
    }
  ];
}
