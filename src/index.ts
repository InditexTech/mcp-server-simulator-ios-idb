#!/usr/bin/env node
// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

// IMMEDIATELY disable all console output to avoid interfering with stdio transport
// This must come before any other imports to ensure nothing writes to stdout
console.log = () => {}; 
console.info = () => {};
console.warn = () => {};
console.error = (msg) => {
  // Only log errors to stderr, not stdout
  process.stderr.write(`${msg}\n`);
};
console.debug = () => {};

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mcpServer from './mcp/mcp-server.js';

/**
 * MCP Server for iOS simulator
 * 
 * This file exports all the components needed to use the MCP Server
 * for iOS simulator automation through idb.
 * 
 * It also serves as the entry point for starting the MCP server.
 */

// Export interfaces
export { IIDBManager, SimulatorInfo, AppInfo, SessionConfig } from './idb/interfaces/IIDBManager.js';
export { IParser, ParseResult, ValidationResult } from './parser/interfaces/IParser.js';
export { 
  IOrchestratorCommand,
  CommandType,
  CommandResult,
  CommandContext,
  SequenceCommand,
  ConditionalCommand,
  CommandFactory
} from './orchestrator/interfaces/IOrchestratorCommand.js';

// Export implementations
export { IDBManager } from './idb/IDBManager.js';
export { NLParser } from './parser/NLParser.js';
export { MCPOrchestrator } from './orchestrator/MCPOrchestrator.js';

// Export adapters
export { ParserToOrchestrator } from './adapters/ParserToOrchestrator.js';
export { OrchestratorToIDB } from './adapters/OrchestratorToIDB.js';

/**
 * Main entry point for the MCP server
 * 
 * This code runs when the server is started directly.
 * It sets up the environment and launches the MCP server.
 */

// Create logs directory with error handling
try {
  // Get the directory name using ESM approach
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Go up one level from the src directory to the project root
  const logsDir = path.join(__dirname, '..', 'logs');
  
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (err) {
  process.stderr.write(`Error creating logs directory: ${err}\n`);
}

async function start() {
  try {
    // Start MCP server
    await mcpServer.start();
  } catch (error) {
    process.stderr.write(`Error starting MCP server: ${error}\n`);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${error.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason}\n`);
  process.exit(1);
});

// Start the server
start();
