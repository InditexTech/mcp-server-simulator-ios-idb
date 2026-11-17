// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { jest } from '@jest/globals';
import { NLParser } from '../NLParser.js';
import { ParseResult } from '../interfaces/IParser.js';
import { ParserToOrchestrator } from '../../adapters/ParserToOrchestrator.js';
import { MCPOrchestrator } from '../../orchestrator/MCPOrchestrator.js';
import { CommandFactory, CommandType } from '../../orchestrator/interfaces/IOrchestratorCommand.js';
import { IIDBManager } from '../../idb/interfaces/IIDBManager.js';

const parser = new NLParser();

const commandFactory = {
  createCommand: (type: CommandType, parameters: Record<string, any>) => ({
    type,
    parameters,
    id: 'test-command'
  })
} as CommandFactory;

const convert = (parseResult: ParseResult) =>
  new ParserToOrchestrator(commandFactory).convertToCommand(parseResult);

describe('verification commands', () => {
  describe('parser', () => {
    it.each([
      ['check app com.example.app', 'com.example.app'],
      ['check if the app com.example.app is installed', 'com.example.app'],
      ['is app com.example.app installed', 'com.example.app'],
      ['verificar app com.example.app', 'com.example.app'],
      ['comprobar si la app com.example.app está instalada', 'com.example.app']
    ])('parses "%s" as a check app command', async (instruction, bundleId) => {
      const result = await parser.parseInstruction(instruction);

      expect(result.command).toBe('check app');
      expect(result.parameters).toEqual({ bundleId });
    });

    it.each([
      'check simulator',
      'verify the simulator is booted',
      'is simulator booted',
      'verificar simulador',
      'comprobar si el simulador está arrancado'
    ])('parses "%s" as a check simulator command', async (instruction) => {
      const result = await parser.parseInstruction(instruction);

      expect(result.command).toBe('check simulator');
      expect(result.parameters).toEqual({});
    });

    it('keeps the bundle ID case and does not require the word installed', async () => {
      const result = await parser.parseInstruction('check app com.example.MyApp');

      expect(result.parameters).toEqual({ bundleId: 'com.example.MyApp' });
    });

    it('parses an instruction with if but without the article', async () => {
      const result = await parser.parseInstruction('check if app com.example.app');

      expect(result.command).toBe('check app');
      expect(result.parameters).toEqual({ bundleId: 'com.example.app' });
    });

    it('parses an unaccented Spanish simulator check', async () => {
      const result = await parser.parseInstruction('comprobar si el simulador esta arrancado');

      expect(result.command).toBe('check simulator');
      expect(result.parameters).toEqual({});
    });

    it('rejects an app check without a bundle ID', async () => {
      await expect(parser.parseInstruction('check the app is installed'))
        .rejects.toThrow('Could not understand the instruction');
    });

    it('rejects a simulator check with a trailing UDID', async () => {
      await expect(parser.parseInstruction('check simulator 5A321B8F-4D85-4267-9F79-2F5C91D142C2'))
        .rejects.toThrow('Could not understand the instruction');
    });
  });

  describe('adapter', () => {
    it('maps check app to isAppInstalled', async () => {
      const command = convert(await parser.parseInstruction('check app com.example.app'));

      expect(command.type).toBe(CommandType.IS_APP_INSTALLED);
      expect(command.parameters).toEqual({ bundleId: 'com.example.app' });
    });

    it('maps check simulator to isSimulatorBooted', async () => {
      const command = convert(await parser.parseInstruction('check simulator'));

      expect(command.type).toBe(CommandType.IS_SIMULATOR_BOOTED);
    });
  });

  describe('orchestrator', () => {
    it('returns the installed state from the IDB manager', async () => {
      const idbManager = {
        isAppInstalled: jest.fn(async () => false),
        isSimulatorBooted: jest.fn(async () => true)
      };
      const orchestrator = new MCPOrchestrator(parser, idbManager as unknown as IIDBManager);

      const result = await orchestrator.processInstruction('is app com.example.app installed');

      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
      expect(idbManager.isAppInstalled).toHaveBeenCalledWith('', 'com.example.app');
    });

    it('returns the booted state from the IDB manager', async () => {
      const idbManager = {
        isAppInstalled: jest.fn(async () => true),
        isSimulatorBooted: jest.fn(async () => false)
      };
      const orchestrator = new MCPOrchestrator(parser, idbManager as unknown as IIDBManager);

      const result = await orchestrator.processInstruction('check simulator');

      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
      expect(idbManager.isSimulatorBooted).toHaveBeenCalledWith('');
    });
  });
});
