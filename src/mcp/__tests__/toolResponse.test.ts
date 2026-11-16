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

  it('keeps the failure state of a failed command next to the image', () => {
    const result = {
      success: false,
      data: pngHeader,
      error: 'Command failed after the screenshot was taken',
      timestamp: 1700000000000
    };

    const [, text] = buildToolResult(result).content as ContentBlock[];

    expect(JSON.parse(text.text as string)).toEqual({
      success: false,
      error: 'Command failed after the screenshot was taken',
      timestamp: 1700000000000,
      data: {
        mimeType: 'image/png',
        byteLength: pngHeader.byteLength
      }
    });
  });
});
