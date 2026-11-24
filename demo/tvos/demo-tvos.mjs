// Demo driver: runs real natural-language instructions through the built MCP
// server (dist/index.js over stdio) against ONE disposable Apple TV simulator,
// records a video, captures a screenshot per step and writes a transcript.
// Run from the repository root after `npm run build`:  node demo/tvos/demo-tvos.mjs <outDir>
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const imp = p => import(path.join(root, 'src/__integration__/support', p));
const { createOwnedSimulator, connectOwnedSimulator, cleanupOwnedSimulator, cleanupOwnedCompanions } = await imp('simulatorHarness.js');
const { buildFixtureApp, FIXTURE_BUNDLE_ID } = await imp('fixtureApp.js');
const { startMcpServer, stopMcpServer, processInstruction } = await imp('mcpClient.js');

const out = path.resolve(process.argv[2]);
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const transcript = ['# tvOS demo transcript', '', 'Every line is a natural-language instruction sent to the MCP `process-instruction` tool.', ''];
let shotIndex = 0;
let created; let client; let transport;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvos-demo-'));

async function run(instruction, { shot, wait = 0 } = {}) {
  const { structured } = await processInstruction(client, instruction);
  const ok = structured?.success === true;
  const detail = ok ? JSON.stringify(structured.data ?? null) : structured?.error;
  transcript.push(`- \`${instruction}\` → **${ok ? 'success' : 'error'}**${detail && detail !== 'null' ? ` — \`${String(detail).slice(0, 220)}\`` : ''}`);
  console.log(`${ok ? 'OK ' : 'ERR'} ${instruction}`);
  if (wait) await sleep(wait);
  if (shot) {
    const f = path.join(out, `${String(++shotIndex).padStart(2, '0')}-${shot}.png`);
    await processInstruction(client, `take screenshot to ${f}`);
  }
  return structured;
}

try {
  created = await createOwnedSimulator(randomUUID().slice(0, 8), { platform: 'tvos' });
  await connectOwnedSimulator(created.udid, tmp);
  const appPath = await buildFixtureApp(tmp, { platform: 'tvos' });
  ({ client, transport } = await startMcpServer());

  await run(`create session with ${created.name}`);
  await run(`install app ${appPath}`);
  await run(`launch app ${FIXTURE_BUNDLE_ID}`, { shot: 'launched-primary-focused', wait: 4000 });
  await run(`record video ${path.join(out, 'tvos-demo.mp4')}`, { wait: 1500 });
  await run('press remote down', { shot: 'focus-moved-to-secondary', wait: 2500 });
  await run('press remote select', { shot: 'secondary-activated', wait: 2500 });
  await run('pulsar mando arriba', { shot: 'focus-back-to-primary-ES', wait: 2500 });
  await run('press remote select', { shot: 'primary-activated', wait: 2500 });
  await run('press device button PLAY_PAUSE', { wait: 1000 });
  transcript.push('', '## Guardrails (honest errors on a device without a touchscreen)', '');
  await run('tap at 100, 200');
  await run('swipe from 100, 100 to 300, 300');
  await run('set orientation to landscape left');
  await run('stop recording');
  await run('press remote menu', { shot: 'menu-pressed', wait: 1500 });
  fs.writeFileSync(path.join(out, 'transcript.md'), transcript.join('\n') + '\n');
} finally {
  if (client && transport && !transport.__closed) await stopMcpServer(transport, client).catch(() => {});
  if (created?.udid) await Promise.allSettled([cleanupOwnedSimulator(created.udid), cleanupOwnedCompanions(created.udid)]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
