import { NLParser } from '../NLParser.js';
import { ParseResult, ValidationResult } from '../interfaces/IParser.js';

// Add Jest types to global scope
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      [key: string]: any;
    }
  }
}

describe('NLParser', () => {
  let parser: NLParser;

  beforeEach(() => {
    parser = new NLParser();
  });

  describe('parseInstruction', () => {
    it('should parse a valid instruction', async () => {
      const result = await parser.parseInstruction('launch app com.example.app');
      expect(result).toBeDefined();
      expect(result.command).toBe('launch app');
      expect(result.parameters).toHaveProperty('bundleId');
      expect(result.parameters.bundleId).toBe('com.example.app');
    });

    it.each([
      ['input text please uninstall app com.foo.bar', 'input text'],
      ['type text tap at 10, 20', 'input text'],
      ['open url myapp://open app com.x', 'open url'],
      ['update contacts /tmp/install app x', 'update contacts'],
      ['add media /Users/me/screenshot.png', 'add media'],
      ['record video /tmp/screenshot.mp4', 'record video'],
      ['open url https://example.com/screenshot', 'open url'],
      ['listar simuladores arrancados', 'list booted simulators'],
      ['mostrar simuladores arrancados', 'list booted simulators']
    ])('should pick the command the instruction starts with: "%s"', async (instruction, command) => {
      const result = await parser.parseInstruction(instruction);
      expect(result.command).toBe(command);
    });

    it('should handle unknown instructions', async () => {
      try {
        await parser.parseInstruction('invalid command here');
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
        expect(error.message).toContain('Could not understand the instruction');
      }
    });
  });

  describe('validateInstruction', () => {
    it('should validate a complete instruction', async () => {
      const parseResult: ParseResult = {
        command: 'launch app',
        parameters: {
          bundleId: 'com.example.app'
        },
        confidence: 1.0,
        originalText: 'launch app com.example.app'
      };

      const result = await parser.validateInstruction(parseResult);
      expect(result.isValid).toBe(true);
    });

    it('should detect missing required parameters', async () => {
      const parseResult: ParseResult = {
        command: 'launch app',
        parameters: {},
        confidence: 1.0,
        originalText: 'launch app'
      };

      const result = await parser.validateInstruction(parseResult);
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('Missing required parameters');
    });

    it('should detect unrecognized commands', async () => {
      const parseResult: ParseResult = {
        command: 'invalid-command',
        parameters: {},
        confidence: 0.0,
        originalText: 'invalid-command'
      };

      const result = await parser.validateInstruction(parseResult);
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('Unrecognized command');
    });
  });

  describe('normalizeParameters', () => {
    it('should normalize numeric string values to numbers', async () => {
      const parseResult: ParseResult = {
        command: 'set-location',
        parameters: {
          latitude: '37.7749',
          longitude: '-122.4194'
        },
        confidence: 1.0,
        originalText: 'set location 37.7749 -122.4194'
      };

      const result = await parser.normalizeParameters(parseResult);
      expect(typeof result.parameters.latitude).toBe('number');
      expect(typeof result.parameters.longitude).toBe('number');
      expect(result.parameters.latitude).toBe(37.7749);
      expect(result.parameters.longitude).toBe(-122.4194);
    });

    it('should normalize boolean string values to booleans', async () => {
      const parseResult: ParseResult = {
        command: 'set-preference',
        parameters: {
          enabled: 'true',
          disabled: 'false'
        },
        confidence: 1.0,
        originalText: 'set preference enabled true disabled false'
      };

      const result = await parser.normalizeParameters(parseResult);
      expect(typeof result.parameters.enabled).toBe('boolean');
      expect(typeof result.parameters.disabled).toBe('boolean');
      expect(result.parameters.enabled).toBe(true);
      expect(result.parameters.disabled).toBe(false);
    });

    it('should preserve non-numeric and non-boolean string values', async () => {
      const parseResult: ParseResult = {
        command: 'test-command',
        parameters: {
          text: 'hello world',
          mixedValue: '123abc'
        },
        confidence: 1.0,
        originalText: 'test command text "hello world" mixedValue 123abc'
      };

      const result = await parser.normalizeParameters(parseResult);
      expect(typeof result.parameters.text).toBe('string');
      expect(typeof result.parameters.mixedValue).toBe('string');
      expect(result.parameters.text).toBe('hello world');
      expect(result.parameters.mixedValue).toBe('123abc');
    });

    it('should preserve numeric display selectors as strings', async () => {
      const parsed = await parser.parseInstruction('take a screenshot of display 3');
      const normalized = await parser.normalizeParameters(parsed);
      expect(normalized.command).toBe('capture screen');
      expect(normalized.parameters.display).toBe('3');
      expect(typeof normalized.parameters.display).toBe('string');
    });
  });

  describe('foldable posture and display-selectable commands', () => {
    it.each([
      'fold to 1e2 degrees',
      'plegar a 120,5 grados',
      'set hinge angle to 120degrees extra',
      'fold to 120 degrees-ish',
      'fold opening',
      'take screenshot of the exterior',
      'take screenshot of outerwear',
      'take screenshot of all displays extra',
      'take screenshot of',
      'toma captura de todas las pantallas extra',
      'capturar pantalla exterior y algo más'
    ])('rejects partial hinge or capture instructions: %s', async instruction => {
      await expect(parser.parseInstruction(instruction)).rejects.toThrow('Could not understand the instruction');
    });

    it.each([
      'set orientation to portrait expecting angle banana',
      'set orientation to portrait expecting angle 120 and nonsense',
      'set orientation to portrait expecting',
      'rotar a vertical verificando pantalla exterior y cualquier cosa',
      'cambiar orientación a vertical esperando ángulo 200',
      'rotar a vertical verificando ángulo 90 y ángulo 120'
    ])('rejects the entire malformed expectation: %s', async instruction => {
      await expect(parser.parseInstruction(instruction)).rejects.toThrow('Invalid expected posture');
    });

    it.each([
      ['capturar pantalla en /ruta/Captura.png', 'capture screen', { outputPath: '/ruta/Captura.png' }],
      ['tomar una captura de la pantalla en /ruta/Captura.png', 'capture screen', { outputPath: '/ruta/Captura.png' }],
      ['input text set orientation to portrait expecting angle banana', 'input text', { text: 'set orientation to portrait expecting angle banana' }],
      ['fold to 120 degrees', 'set hinge angle', { angle: 120 }],
      ['fold to 120.5 degrees.', 'set hinge angle', { angle: 120.5 }],
      ['fold closed', 'set hinge angle', { angle: 0 }],
      ['fold half-open', 'set hinge angle', { angle: 90 }],
      ['plegar a 135.5°', 'set hinge angle', { angle: 135.5 }],
      ['desplegar el simulador', 'set hinge angle', { angle: 180 }],
      ['read posture', 'get posture', {}],
      ['leer la postura del dispositivo', 'get posture', {}],
      [
        'set orientation to portrait upside down expecting angle 120 and active display inner',
        'set orientation',
        {
          orientation: 'PORTRAIT_UPSIDE_DOWN',
          expectedPosture: { angle: 120, activeDisplay: 'inner' }
        }
      ],
      [
        'cambiar orientación a horizontal derecha verificando ángulo 90 y pantalla interior',
        'set orientation',
        {
          orientation: 'LANDSCAPE_RIGHT',
          expectedPosture: { angle: 90, activeDisplay: 'inner' }
        }
      ],
      ['take screenshot of all displays', 'capture screen', { display: 'all' }],
      ['take screenshot of outer display.', 'capture screen', { display: 'outer' }],
      ['toma captura de todas las pantallas', 'capture screen', { display: 'all' }],
      [
        'toma una captura de todas las pantallas en /tmp/duo.png',
        'capture screen',
        { display: 'all', outputPath: '/tmp/duo.png' }
      ],
      [
        'take screenshot of inner display',
        'capture screen',
        { display: 'inner' }
      ]
    ])('parses "%s" into %s', async (instruction, expectedCommand, expectedParams) => {
      const result = await parser.parseInstruction(instruction);
      expect(result.command).toBe(expectedCommand);
      expect(result.parameters).toEqual(expectedParams);
    });
  });

  describe('suggestCompletions', () => {
    it('should suggest completions for partial text', async () => {
      const suggestions = await parser.suggestCompletions('launch');
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.startsWith('launch'))).toBe(true);
    });

    it('should return empty array for completely irrelevant text', async () => {
      const suggestions = await parser.suggestCompletions('xyzabc123');
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBe(0);
    });
  });

  describe('getSupportedCommands', () => {
    it('should return a list of supported commands', async () => {
      const commands = await parser.getSupportedCommands();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
      
      // Check command structure
      const command = commands[0];
      expect(command).toHaveProperty('command');
      expect(command).toHaveProperty('description');
      expect(command).toHaveProperty('requiredParameters');
      expect(command).toHaveProperty('optionalParameters');
      expect(Array.isArray(command.requiredParameters)).toBe(true);
      expect(Array.isArray(command.optionalParameters)).toBe(true);
    });
  });
});
