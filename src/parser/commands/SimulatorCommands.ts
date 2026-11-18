// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { BaseCommandDefinition, CommandDefinition } from './BaseCommandDefinition.js';
import { DeviceOrientation, ExpectedPosture } from '../../idb/interfaces/IIDBManager.js';

function parsePresetAngle(preset?: string): number | undefined {
  if (!preset) return undefined;
  const normalized = preset.trim().toLowerCase();
  if (normalized === 'closed' || normalized === 'cerrado') return 0;
  if (normalized === 'flat' || normalized === 'open' || normalized === 'abierto') return 180;
  if (normalized.startsWith('half') || normalized.startsWith('semi')) return 90;
  return undefined;
}

function normalizeOrientationPhrase(raw?: string): DeviceOrientation | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (
    cleaned === 'portrait upside down' ||
    cleaned === 'upside down' ||
    cleaned === 'vertical invertido' ||
    cleaned === 'vertical invertida' ||
    cleaned === 'boca abajo'
  ) {
    return 'PORTRAIT_UPSIDE_DOWN';
  }
  if (
    cleaned === 'landscape left' ||
    cleaned === 'horizontal izquierda' ||
    cleaned === 'apaisado izquierda' ||
    cleaned === 'landscape' ||
    cleaned === 'horizontal' ||
    cleaned === 'apaisado'
  ) {
    return 'LANDSCAPE_LEFT';
  }
  if (
    cleaned === 'landscape right' ||
    cleaned === 'horizontal derecha' ||
    cleaned === 'apaisado derecha'
  ) {
    return 'LANDSCAPE_RIGHT';
  }
  if (cleaned === 'portrait' || cleaned === 'vertical') {
    return 'PORTRAIT';
  }
  return undefined;
}

function normalizeExpectedDisplayAlias(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === 'exterior' || cleaned === 'externa' || cleaned === 'cover' || cleaned === 'outer') {
    return 'outer';
  }
  if (cleaned === 'interior' || cleaned === 'interna' || cleaned === 'inner') {
    return 'inner';
  }
  if (cleaned === 'activa' || cleaned === 'active') {
    return 'active';
  }
  if (cleaned === 'principal' || cleaned === 'main') {
    return 'main';
  }
  return cleaned;
}

function extractExpectedPosture(clause?: string): ExpectedPosture | undefined {
  if (!clause) return undefined;
  const text = clause.trim();
  if (!text) return undefined;

  const expected: ExpectedPosture = {};

  const angleMatch =
    /(?:hinge\s+)?(?:angle|[aá]ngulo)\s*(?:of|de|=|:)?\s*(-?\d+(?:\.\d+)?)\s*(?:degrees|deg|grados|°)?/i.exec(
      text
    );
  if (angleMatch) {
    expected.angle = Number.parseFloat(angleMatch[1]);
  }

  const displayAfterKeyword =
    /(?:active\s+)?(?:display|screen|pantalla(?:\s+activa)?)\s*(?:is|sea|=|:)?\s*(outer|inner|cover|active|main|primary(?:-1)?|exterior|externa|interior|interna|activa|principal|[a-zA-Z0-9-]+)/i.exec(
      text
    );
  const displayBeforeKeyword =
    /\b(outer|inner|cover|active|main|exterior|externa|interior|interna|activa|principal)\s+(?:display|screen|pantalla)\b/i.exec(
      text
    );

  const rawDisplay = displayAfterKeyword?.[1] ?? displayBeforeKeyword?.[1];
  if (rawDisplay) {
    expected.activeDisplay = normalizeExpectedDisplayAlias(rawDisplay);
  }

  return Object.keys(expected).length > 0 ? expected : undefined;
}

const ORIENTATION_TOKEN =
  'portrait[\\s_-]+upside[\\s_-]+down|upside[\\s_-]+down|landscape[\\s_-]+left|landscape[\\s_-]+right|portrait|landscape|vertical\\s+invertid[oa]|boca\\s+abajo|horizontal\\s+izquierda|horizontal\\s+derecha|apaisado\\s+izquierda|apaisado\\s+derecha|vertical|horizontal|apaisado';

const EXPECTED_POSTURE_SUFFIX_EN =
  '(?:,?\\s*(?:and\\s+)?(?:verify(?:ing)?|expect(?:ing)?|with\\s+expected(?:\\s+posture)?)(?:\\s+posture)?\\s+(?<expected>.+))?';

const EXPECTED_POSTURE_SUFFIX_ES =
  '(?:,?\\s*(?:y\\s+)?(?:verificando|esperando|con\\s+postura\\s+esperada)(?:\\s+postura)?\\s+(?<expected>.+))?';

export class SimulatorCommands extends BaseCommandDefinition {
  protected definitions: CommandDefinition[] = [
    {
      command: 'create session',
      patterns: [
        /crear\s+(una\s+)?sesión(\s+de\s+simulador)?(\s+con\s+(?<deviceName>[^,]+))?/i,
        /iniciar\s+(un\s+)?simulador(\s+(?<deviceName>[^,]+))?/i,
        /create\s+(a\s+)?session(\s+with\s+(?<deviceName>[^,]+))?/i,
        /start\s+(a\s+)?simulator(\s+(?<deviceName>[^,]+))?/i,
        /launch\s+(a\s+)?simulator(\s+(?<deviceName>[^,]+))?/i
      ],
      description: 'Creates a new simulator session',
      requiredParameters: [],
      optionalParameters: ['deviceName', 'platformVersion', 'autoboot'],
      examples: [
        'crear sesión',
        'crear una sesión de simulador',
        'iniciar simulador iPhone 12',
        'create session with iPhone 12',
        'start simulator iPhone 13'
      ],
      parameterExtractors: {
        deviceName: (match) => match.groups?.deviceName?.trim()
      }
    },
    {
      command: 'end session',
      patterns: [
        /terminar\s+(la\s+)?sesión/i,
        /cerrar\s+(el\s+)?simulador/i,
        /end\s+(the\s+)?session/i,
        /close\s+(the\s+)?simulator/i,
        /terminate\s+(the\s+)?session/i
      ],
      description: 'Ends the current simulator session',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'terminar sesión',
        'cerrar simulador',
        'end session',
        'close simulator',
        'terminate session'
      ],
      parameterExtractors: {}
    },
    {
      command: 'list simulators',
      patterns: [
        /listar\s+(los\s+)?simuladores/i,
        /mostrar\s+(los\s+)?simuladores/i,
        /qué\s+simuladores\s+(hay|están\s+disponibles)/i,
        /list\s+(all\s+)?simulators/i,
        /show\s+(all\s+)?simulators/i,
        /display\s+(all\s+)?simulators/i
      ],
      description: 'Lists available simulators',
      requiredParameters: [],
      optionalParameters: [],
      examples: [
        'listar simuladores',
        'mostrar simuladores',
        'qué simuladores hay',
        'list simulators',
        'show all simulators',
        'display simulators'
      ],
      parameterExtractors: {}
    },
    {
      command: 'list booted simulators',
      patterns: [
        /listar\s+(los\s+)?simuladores\s+arrancados/i,
        /mostrar\s+(los\s+)?simuladores\s+arrancados/i,
        /qué\s+simuladores\s+están\s+arrancados/i,
        /list\s+(all\s+)?booted\s+simulators/i,
        /show\s+running\s+simulators/i,
        /display\s+active\s+simulators/i
      ],
      description: 'Lists booted simulators',
      requiredParameters: [],
      optionalParameters: [],
      examples: [
        'listar simuladores arrancados',
        'mostrar simuladores arrancados',
        'qué simuladores están arrancados',
        'list booted simulators',
        'show running simulators',
        'display active simulators'
      ],
      parameterExtractors: {}
    },
    {
      command: 'boot simulator',
      patterns: [
        /arrancar\s+(el\s+)?simulador\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /bootear\s+(el\s+)?simulador\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /boot\s+(the\s+)?simulator\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /start\s+(the\s+)?simulator\s+(?<udid>[a-zA-Z0-9-]+)/i
      ],
      description: 'Boots a simulator by its UDID',
      requiredParameters: ['udid'],
      optionalParameters: [],
      examples: [
        'arrancar simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'bootear simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'boot simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'start simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2'
      ],
      parameterExtractors: {
        udid: (match) => match.groups?.udid?.trim()
      }
    },
    {
      command: 'shutdown simulator',
      patterns: [
        /apagar\s+(el\s+)?simulador\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /shutdown\s+(el\s+)?simulador\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /shutdown\s+(the\s+)?simulator\s+(?<udid>[a-zA-Z0-9-]+)/i,
        /turn\s+off\s+(the\s+)?simulator\s+(?<udid>[a-zA-Z0-9-]+)/i
      ],
      description: 'Shuts down a simulator by its UDID',
      requiredParameters: ['udid'],
      optionalParameters: [],
      examples: [
        'apagar simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'shutdown simulador 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'shutdown simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2',
        'turn off simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2'
      ],
      parameterExtractors: {
        udid: (match) => match.groups?.udid?.trim()
      }
    },
    {
      command: 'check simulator',
      patterns: [
        /(verificar|comprobar)\s+(si\s+)?(el\s+)?simulador\s+(est[aá]\s+)?(arrancado|encendido|iniciado|activo)\s*[?.!]*$/i,
        /(verificar|comprobar)\s+(si\s+)?(el\s+)?simulador\s*[?.!]*$/i,
        /(check|verify)\s+(if\s+)?(the\s+)?simulator\s+(is\s+)?(booted|running|active)\s*[?.!]*$/i,
        /(check|verify)\s+(if\s+)?(the\s+)?simulator\s*[?.!]*$/i,
        /is\s+(the\s+)?simulator\s+(booted|running|active)\s*[?.!]*$/i
      ],
      description: 'Checks whether the current simulator session is booted',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'verificar simulador',
        'comprobar si el simulador está arrancado',
        'check simulator',
        'verify the simulator is booted',
        'is simulator booted'
      ],
      parameterExtractors: {}
    },
    {
      command: 'focus simulator',
      patterns: [
        /enfocar\s+(el\s+)?simulador/i,
        /focus\s+(el\s+)?simulador/i,
        /traer\s+(el\s+)?simulador\s+al\s+frente/i,
        /focus\s+(the\s+)?simulator/i,
        /bring\s+(the\s+)?simulator\s+to\s+front/i
      ],
      description: 'Focuses the simulator window',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'enfocar simulador',
        'focus simulador',
        'traer simulador al frente',
        'focus simulator',
        'bring simulator to front'
      ],
      parameterExtractors: {}
    },
    {
      command: 'set hinge angle',
      patterns: [
        /(?:plegar|doblar)(?:\s+(?:el\s+)?simulador)?\s+a\s+(?<angle>-?\d+(?:\.\d+)?)\s*(?:grados|°)?/i,
        /(?:ajustar|establecer|fijar|poner)\s+(?:el\s+)?[aá]ngulo\s+de\s+(?:la\s+)?bisagra\s+(?:a|en)\s+(?<angle>-?\d+(?:\.\d+)?)\s*(?:grados|°)?/i,
        /(?<unfoldEs>desplegar)(?:\s+(?:el\s+)?simulador)?/i,
        /plegar\s+(?<preset>cerrado|abierto)/i,
        /fold(?:\s+(?:the\s+)?simulator)?\s+to\s+(?<angle>-?\d+(?:\.\d+)?)\s*(?:degrees|deg|°)?/i,
        /set\s+(?:the\s+)?hinge(?:\s+angle)?\s+(?:to\s+)?(?<angle>-?\d+(?:\.\d+)?)\s*(?:degrees|deg|°)?/i,
        /hinge(?:\s+angle)?\s+(?<angle>-?\d+(?:\.\d+)?)\s*(?:degrees|deg|°)?/i,
        /(?<unfoldEn>unfold)(?:\s+(?:the\s+)?simulator)?/i,
        /fold\s+(?<preset>closed|flat|open|half(?:-|\s+)open|half)/i
      ],
      description: 'Sets the foldable simulator hinge angle (0 closed to 180 flat) and confirms the measured angle',
      requiredParameters: ['angle'],
      optionalParameters: ['sessionId'],
      examples: [
        'plegar a 120 grados',
        'ajustar ángulo de bisagra a 90 grados',
        'fold to 120 degrees',
        'set hinge angle to 180 degrees',
        'unfold simulator'
      ],
      parameterExtractors: {
        angle: (match) => {
          if (match.groups?.angle !== undefined) {
            return Number.parseFloat(match.groups.angle);
          }
          if (match.groups?.unfoldEn || match.groups?.unfoldEs) {
            return 180;
          }
          return parsePresetAngle(match.groups?.preset);
        }
      }
    },
    {
      command: 'get posture',
      patterns: [
        /(?:leer|obtener|mostrar|consultar|ver)\s+(?:la\s+)?postura(?:\s+del\s+(?:simulador|dispositivo))?/i,
        /(?:leer|obtener|mostrar|consultar|ver)\s+(?:el\s+)?[aá]ngulo\s+de\s+(?:la\s+)?bisagra/i,
        /(?:read|get|show|check)\s+(?:the\s+)?(?:(?:device|simulator)\s+)?posture/i,
        /(?:read|get|show)\s+(?:the\s+)?hinge\s+angle/i,
        /what\s+is\s+the\s+(?:current\s+)?posture\s*[?.!]*$/i
      ],
      description: 'Reads the simulator posture (hinge angle, orientation, and displays)',
      requiredParameters: [],
      optionalParameters: ['sessionId'],
      examples: [
        'leer postura',
        'obtener la postura del simulador',
        'read posture',
        'get simulator posture',
        'get hinge angle'
      ],
      parameterExtractors: {}
    },
    {
      command: 'set orientation',
      patterns: [
        new RegExp(
          `(?:cambiar|establecer|ajustar|fijar|poner)\\s+(?:la\\s+)?orientaci[oó]n(?:\\s+del\\s+(?:simulador|dispositivo))?\\s+(?:a|en)\\s+(?<orientation>${ORIENTATION_TOKEN})${EXPECTED_POSTURE_SUFFIX_ES}`,
          'i'
        ),
        new RegExp(
          `(?:rotar|girar)(?:\\s+(?:el\\s+)?(?:simulador|dispositivo))?\\s+a\\s+(?<orientation>${ORIENTATION_TOKEN})${EXPECTED_POSTURE_SUFFIX_ES}`,
          'i'
        ),
        new RegExp(
          `set\\s+(?:the\\s+)?(?:(?:device|simulator)\\s+)?orientation\\s+(?:to\\s+)?(?<orientation>${ORIENTATION_TOKEN})${EXPECTED_POSTURE_SUFFIX_EN}`,
          'i'
        ),
        new RegExp(
          `rotate(?:\\s+(?:the\\s+)?(?:device|simulator))?\\s+(?:to\\s+)?(?<orientation>${ORIENTATION_TOKEN})${EXPECTED_POSTURE_SUFFIX_EN}`,
          'i'
        )
      ],
      description: 'Sets device orientation and verifies the resulting posture',
      requiredParameters: ['orientation'],
      optionalParameters: ['expectedPosture', 'sessionId'],
      examples: [
        'cambiar orientación a horizontal izquierda',
        'rotar a vertical verificando pantalla exterior',
        'set orientation to landscape left',
        'rotate simulator to portrait expecting angle 0 and active display outer'
      ],
      parameterExtractors: {
        orientation: (match) => normalizeOrientationPhrase(match.groups?.orientation),
        expectedPosture: (match) => extractExpectedPosture(match.groups?.expected)
      }
    }
  ];
}
