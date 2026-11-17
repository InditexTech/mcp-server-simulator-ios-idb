// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CommandResult } from '../orchestrator/interfaces/IOrchestratorCommand.js';

const PNG_MIME_TYPE = 'image/png';

/**
 * Builds the MCP tool result for a processed instruction.
 *
 * A screenshot taken without an output path comes back from IDBManager as a
 * PNG Buffer. JSON.stringify would turn it into a
 * `{"type":"Buffer","data":[137,80,...]}` object, which no client can render,
 * so the image is sent as base64 image content and the rest of the result as a
 * text block. Every other result stays a single JSON text block.
 * @param result Orchestrator command result
 * @returns MCP tool result
 */
export function buildToolResult(result: CommandResult): CallToolResult {
  if (!Buffer.isBuffer(result.data)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    };
  }

  const { data, ...metadata } = result;
  return {
    content: [
      {
        type: 'image',
        data: data.toString('base64'),
        mimeType: PNG_MIME_TYPE
      },
      {
        type: 'text',
        text: JSON.stringify({
          ...metadata,
          data: {
            mimeType: PNG_MIME_TYPE,
            byteLength: data.byteLength
          }
        })
      }
    ]
  };
}
