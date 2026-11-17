// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { buildToolResult } from '../toolResponse.js';

interface ContentBlock {
  type: string;
  data?: string;
  mimeType?: string;
  text?: string;
}

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

describe('buildToolResult', () => {
  it('returns a single JSON text block for a regular result', () => {
    const result = {
      success: true,
      data: { sessionId: 'session_1', booted: true },
      timestamp: 1700000000000
    };

    const response = buildToolResult(result);

    expect(response.content).toHaveLength(1);
    const [block] = response.content as ContentBlock[];
    expect(block.type).toBe('text');
    expect(JSON.parse(block.text as string)).toEqual(result);
  });

  it('returns a screenshot Buffer as base64 image content', () => {
    const result = {
      success: true,
      data: pngHeader,
      timestamp: 1700000000000
    };

    const response = buildToolResult(result);

    expect(response.content).toHaveLength(2);
    const [image, text] = response.content as ContentBlock[];
    expect(image).toEqual({
      type: 'image',
      data: pngHeader.toString('base64'),
      mimeType: 'image/png'
    });
    expect(Buffer.from(image.data as string, 'base64')).toEqual(pngHeader);
    expect(JSON.parse(text.text as string)).toEqual({
      success: true,
      timestamp: 1700000000000,
      data: {
        mimeType: 'image/png',
        byteLength: pngHeader.byteLength
      }
    });
  });

  it('does not serialize the screenshot bytes as a Buffer JSON object', () => {
    const result = {
      success: true,
      data: pngHeader,
      timestamp: 1700000000000
    };

    const response = buildToolResult(result);
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain('"type":"Buffer"');
    expect(serialized).not.toContain(`"data":[${pngHeader[0]},`);
  });

  it('returns a single JSON text block when a screenshot command fails or writes to a path', () => {
    const failedResult = {
      success: false,
      error: 'Error executing command: idb companion is not running',
      timestamp: 1700000000000
    };
    const savedPathResult = {
      success: true,
      data: '/tmp/screenshot.png',
      timestamp: 1700000000000
    };

    const failedResponse = buildToolResult(failedResult);
    const savedPathResponse = buildToolResult(savedPathResult);

    expect(failedResponse.content).toHaveLength(1);
    expect(failedResponse.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(failedResult)
    });
    expect(savedPathResponse.content).toHaveLength(1);
    expect(savedPathResponse.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(savedPathResult)
    });
  });
});
