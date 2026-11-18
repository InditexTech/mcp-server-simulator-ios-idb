// SPDX-FileCopyrightText: © 2026 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression contract for the integration harness's MCP request timeout
 * (PR #78 stabilization of issue #76's flaky failures).
 *
 * Root cause proven on cold-boot runs: the MCP SDK applies request timeouts
 * PER CALL via RequestOptions — the object handed to the Client constructor
 * only carries ProtocolOptions, so a `timeout` there is silently ignored and
 * every callTool falls back to the SDK's 60 s default (the failed run showed
 * both MCP -32001 errors exactly ~62 s into requests the companion completed
 * successfully at 163 s / 160 s). The harness must therefore pass its 180 s
 * budget on every single callTool invocation.
 *
 * Loading pattern: the harness lives under src/__integration__ as ESM
 * JavaScript, so the unit suite (CommonJS pipeline) loads it through a child
 * Node process with --experimental-vm-modules — the same "spawn one node,
 * import ESM" probe pattern used by simulatorHarnessCleanup.test.ts. No
 * simulator, no MCP server subprocess, and no real process side effects are
 * involved: processInstruction is called against a recording fake client.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_URL = new URL('../__integration__/support/mcpClient.js', import.meta.url).href;

const runClientProbe = (call: string, ...args: unknown[]): Promise<any> => {
  const script = `
    const mod = await import(${JSON.stringify(HARNESS_URL)});
    const calls = [];
    const fakeClient = {
      callTool: async (params, resultSchema, options) => {
        calls.push({ params, resultSchema, options });
        return { content: [{ type: 'text', text: '{"success":true,"data":null}' }] };
      }
    };
    const result = await mod[${JSON.stringify(call)}](fakeClient, ...${JSON.stringify(args)});
    process.stdout.write(JSON.stringify({ result, calls, budget: mod.MCP_REQUEST_TIMEOUT_MS }));
  `;
  // Positional note: processInstruction(client, instruction) takes the client
  // FIRST, so the probe prepends the recording fake client before the
  // forwarded instruction.
  const probe = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--input-type=module', '-e', script
  ], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`harness probe failed: ${probe.stderr}`);
  }
  return JSON.parse(probe.stdout);
};

describe('mcpClient per-call request timeout contract', () => {
  it('exports the 180 s per-request budget as harness metadata', () => {
    // GIVEN/WHEN
    const probeScript = `
      const mod = await import(${JSON.stringify(HARNESS_URL)});
      process.stdout.write(JSON.stringify({ budget: mod.MCP_REQUEST_TIMEOUT_MS }));
    `;
    const probe = spawnSync(process.execPath, [
      '--experimental-vm-modules', '--input-type=module', '-e', probeScript
    ], { encoding: 'utf8' });
    if (probe.status !== 0) {
      throw new Error(`harness probe failed: ${probe.stderr}`);
    }

    // THEN
    // The budget must be exported and MUST exceed the SDK's silent 60 s
    // default that demonstrably killed cold-boot launch/install requests.
    expect(JSON.parse(probe.stdout).budget).toBe(180_000);
  });

  it('forwards the 180 s per-call timeout on every processInstruction callTool', async () => {
    // GIVEN
    // WHEN
    const { calls } = await runClientProbe('processInstruction', 'list simulators');

    // THEN
    expect(calls).toHaveLength(1);
    expect(calls[0].params.name).toBe('process-instruction');
    expect(calls[0].params.arguments.instruction).toBe('list simulators');
    // Per-call RequestOptions, not constructor options: exactly the contract
    // the previous tree missed (its 60 s default produced MCP -32001).
    expect(calls[0].options?.timeout).toBe(180_000);
  });

  it('applies the same per-call timeout to each sequential call, not just the first', async () => {
    // GIVEN
    // WHEN
    const first = await runClientProbe('processInstruction', 'create session with owned');
    const second = await runClientProbe('processInstruction', 'list apps');

    // THEN
    expect(first.calls[0].options?.timeout).toBe(180_000);
    expect(second.calls[0].options?.timeout).toBe(180_000);
    // The parsed success contract stays intact through the extra argument.
    expect(first.result.structured.success).toBe(true);
    expect(second.result.structured.success).toBe(true);
  });
});
