// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CommandResult } from '../orchestrator/interfaces/IOrchestratorCommand.js';
import { LabelledScreenshot } from '../idb/interfaces/IIDBManager.js';

const PNG_MIME_TYPE = 'image/png';

function isLabelledScreenshotArray(value: unknown): value is LabelledScreenshot[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      item =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as LabelledScreenshot).label === 'string' &&
        Buffer.isBuffer((item as LabelledScreenshot).buffer)
    )
  );
}

/**
 * Builds the MCP tool result for a processed instruction.
 *
 * A screenshot taken without an output path comes back from IDBManager as a
 * PNG Buffer (or an array of LabelledScreenshot entries when a display selector
 * is used). JSON.stringify would turn Buffers into numeric byte arrays, which
 * no client can render, so images are sent as base64 image content alongside
 * text metadata blocks. Every other result stays a single JSON text block.
 * @param result Orchestrator command result
 * @returns MCP tool result
 */
export function buildToolResult(result: CommandResult): CallToolResult {
  if (isLabelledScreenshotArray(result.data)) {
    const { data, ...metadata } = result;
    const content: CallToolResult['content'] = [];

    for (const item of data) {
      const mimeType = item.mimeType || PNG_MIME_TYPE;
      content.push({
        type: 'text',
        text: item.label
      });
      content.push({
        type: 'image',
        data: item.buffer.toString('base64'),
        mimeType
      });
    }

    content.push({
      type: 'text',
      text: JSON.stringify({
        ...metadata,
        data: data.map(({ buffer, ...rest }) => ({
          ...rest,
          mimeType: rest.mimeType || PNG_MIME_TYPE,
          byteLength: buffer.byteLength
        }))
      })
    });

    return { content };
  }

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
