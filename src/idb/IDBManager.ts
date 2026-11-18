// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { 
  IIDBManager, 
  SimulatorInfo, 
  AppInfo, 
  SessionConfig,
  ButtonType,
  DeviceOrientation,
  DisplayRole,
  SimulatorDisplayInfo,
  SimulatorPosture,
  ExpectedPosture,
  HingeAngleResult,
  LabelledScreenshot,
  SavedDisplayScreenshot,
  AccessibilityInfo,
  CrashLogInfo
} from './interfaces/IIDBManager.js';

const execFileAsync = promisify(execFile);

const VALID_ORIENTATIONS = new Set<DeviceOrientation>([
  'PORTRAIT',
  'PORTRAIT_UPSIDE_DOWN',
  'LANDSCAPE_LEFT',
  'LANDSCAPE_RIGHT'
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HINGE_TOLERANCE_DEGREES = 1.0;

interface ParsedScreenEntry {
  screenId: string;
  name: string;
  uniqueId: string;
  deviceName: string;
  screenType: string;
  width: number;
  height: number;
  uiOrientation?: string;
}

interface PngInspection {
  width?: number;
  height?: number;
  hasVisiblePixels?: boolean;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function inspectPngBuffer(buffer: Buffer): PngInspection {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {};
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];

  if (width === 0 || height === 0 || bitDepth !== 8 || interlace !== 0) {
    return { width, height };
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) {
    return { width, height };
  }

  const idatChunks: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      break;
    }
    if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (idatChunks.length === 0) {
    return { width, height };
  }

  try {
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const rowBytes = width * channels;
    const stride = 1 + rowBytes;
    if (raw.length < height * stride) {
      return { width, height };
    }

    let prevRow = new Uint8Array(rowBytes);
    let currRow = new Uint8Array(rowBytes);
    const colorChannels = channels >= 3 ? 3 : 1;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * stride;
      const filterType = raw[rowOffset];

      for (let i = 0; i < rowBytes; i++) {
        const xByte = raw[rowOffset + 1 + i];
        const left = i >= channels ? currRow[i - channels] : 0;
        const up = prevRow[i];
        const upLeft = i >= channels ? prevRow[i - channels] : 0;

        switch (filterType) {
          case 0:
            currRow[i] = xByte;
            break;
          case 1:
            currRow[i] = (xByte + left) & 0xff;
            break;
          case 2:
            currRow[i] = (xByte + up) & 0xff;
            break;
          case 3:
            currRow[i] = (xByte + ((left + up) >> 1)) & 0xff;
            break;
          case 4:
            currRow[i] = (xByte + paethPredictor(left, up, upLeft)) & 0xff;
            break;
          default:
            return { width, height };
        }
      }

      for (let px = 0; px < rowBytes; px += channels) {
        if ((colorType === 4 || colorType === 6) && currRow[px + channels - 1] === 0) continue;
        for (let c = 0; c < colorChannels; c++) {
          if (currRow[px + c] > 0) {
            return { width, height, hasVisiblePixels: true };
          }
        }
      }

      const swap = prevRow;
      prevRow = currRow;
      currRow = swap;
    }

    return { width, height, hasVisiblePixels: false };
  } catch {
    return { width, height };
  }
}

function appendSuffixBeforeExtension(filePath: string, suffix: string): string {
  const ext = path.extname(filePath);
  if (!ext) {
    return `${filePath}${suffix}.png`;
  }
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}${suffix}${ext}`;
}

interface IDBAppInfo {
  bundle_id: string;
  name?: string;
  install_path?: string;
  pid?: number | null;
}

interface IDBCrashLogInfo {
  name: string | null;
  bundle_id: string | null;
  timestamp: number | null;
}

/**
 * IDB manager implementation for interacting with iOS simulators
 */
export class IDBManager implements IIDBManager {
  private readonly sessions: Map<string, string> = new Map(); // sessionId -> udid
  private readonly multiDisplayUdids: Set<string> = new Set();
  private sessionCounter: number = 0;
  private settleMaxAttempts: number = 20;
  private settleIntervalMs: number = 250;

  private async executeCommand(command: string, args: string[] = [], timeout?: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout });
      return stdout.trim();
    } catch (error: any) {
      console.error(`Error executing command: ${command}`, args);
      console.error(error.message);
      throw new Error(`Error executing command: ${error.message}`);
    }
  }

  private parseAppList(output: string): IDBAppInfo[] {
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as IDBAppInfo);
  }

  private parseInstalledBundleId(output: string): string {
    try {
      const bundleId = JSON.parse(output).installedAppBundleId;
      if (typeof bundleId === 'string' && bundleId.length > 0) {
        return bundleId;
      }
    } catch {
      // Reported below
    }
    throw new Error(`Could not read the bundle ID from the idb install output: ${output}`);
  }

  private async verifyIDBAvailability(): Promise<void> {
    try {
      await this.executeCommand('idb', ['list-targets']);
    } catch (error) {
      throw new Error('idb is not installed or not available in PATH. Make sure idb-companion and fb-idb are properly installed.');
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${this.sessionCounter++}`;
  }

  async createSimulatorSession(config?: SessionConfig): Promise<string> {
    await this.verifyIDBAvailability();
    let selectedSimulator: SimulatorInfo;

    // Booted first: with several devices sharing a name (one per runtime),
    // reuse the one already running instead of booting another.
    const simulators = (await this.listAvailableSimulators())
      .sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted'));

    if (config?.deviceName) {
      // The parser may lowercase the instruction, so compare case-insensitively.
      // A UDID is accepted too, for when a name is ambiguous.
      const wanted = config.deviceName.trim().toLowerCase();
      const simulator = simulators.find(sim =>
        (sim.name.toLowerCase() === wanted || sim.udid.toLowerCase() === wanted) &&
        (!config.platformVersion || sim.os.includes(config.platformVersion))
      );

      if (!simulator) {
        throw new Error(`No simulator found with name ${config.deviceName}`);
      }
      selectedSimulator = simulator;
    } else {
      if (simulators.length === 0) {
        throw new Error('No available simulators found');
      }
      selectedSimulator = simulators[0];
    }

    const { udid } = selectedSimulator;
    if (config?.autoboot !== false) {
      await this.bootSimulatorByUDID(udid);
    }

    if (selectedSimulator.deviceType === 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo') {
      this.multiDisplayUdids.add(selectedSimulator.udid);
    }

    const sessionId = this.generateSessionId();
    this.sessions.set(sessionId, udid);
    return sessionId;
  }

  async terminateSimulatorSession(sessionId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
  }

  async listAvailableSimulators(): Promise<SimulatorInfo[]> {
    await this.verifyIDBAvailability();
    const output = await this.executeCommand('xcrun', ['simctl', 'list', 'devices', '--json']);
    const data = JSON.parse(output);
    const simulators: SimulatorInfo[] = [];
    
    Object.entries(data.devices).forEach(([runtimeName, devices]: [string, any]) => {
      devices.forEach((device: any) => {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state === 'Booted' ? 'Booted' : 
                 device.state === 'Shutdown' ? 'Shutdown' : 'Unknown',
          os: runtimeName.replace('com.apple.CoreSimulator.SimRuntime.', ''),
          deviceType: device.deviceTypeIdentifier || 'Unknown'
        });
      });
    });
    
    return simulators;
  }

  async listBootedSimulators(): Promise<SimulatorInfo[]> {
    const simulators = await this.listAvailableSimulators();
    return simulators.filter(sim => sim.state === 'Booted');
  }

  async bootSimulatorByUDID(udid: string): Promise<void> {
    await this.verifyIDBAvailability();
    const simulators = await this.listBootedSimulators();
    if (simulators.some(sim => sim.udid === udid)) {
      return;
    }
    
    await this.executeCommand('xcrun', ['simctl', 'boot', udid]);
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      try {
        const booted = await this.listBootedSimulators();
        if (booted.some(sim => sim.udid === udid)) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return;
        }
      } catch (error) {
        // Ignore errors during boot
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    throw new Error(`Timeout waiting for simulator ${udid} to boot`);
  }

  async shutdownSimulator(sessionId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.shutdownSimulatorByUDID(udid);
  }

  async shutdownSimulatorByUDID(udid: string): Promise<void> {
    await this.verifyIDBAvailability();
    await this.executeCommand('xcrun', ['simctl', 'shutdown', udid]);
  }

  async installApp(sessionId: string, appPath: string): Promise<AppInfo> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    if (!fs.existsSync(appPath)) {
      throw new Error(`File does not exist: ${appPath}`);
    }
    
    // idb prints the bundle ID of the installed app; with --json it is a single JSON line
    const output = await this.executeCommand('idb', ['install', '--udid', udid, '--json', '--', appPath]);
    
    return {
      bundleId: this.parseInstalledBundleId(output),
      name: path.basename(appPath, path.extname(appPath)),
      installedPath: appPath
    };
  }

  async launchApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['launch', '--udid', udid, '--', bundleId]);
  }

  async terminateApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['terminate', '--udid', udid, '--', bundleId]);
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['ui', 'tap', String(x), String(y), '--udid', udid]);
  }

  async swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number = 100
  ): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', [
      'ui',
      'swipe',
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      '--duration',
      String(duration / 1000),
      '--udid',
      udid
    ]);
  }

  private requireSessionUDID(sessionId: string): string {
    const udid = this.sessions.get(sessionId);
    if (!udid) throw new Error(`Session not found: ${sessionId}`);
    return udid;
  }

  private parseIntegratedDisplays(output: string): SimulatorDisplayInfo[] {
    const lines = output.split(/\r?\n/);
    const rawEntries: ParsedScreenEntry[] = [];
    let inConnectedScreens = false;
    let current: Partial<ParsedScreenEntry> | null = null;

    const flushCurrent = () => {
      if (
        current &&
        current.screenType?.toLowerCase() === 'integrated' &&
        current.screenId &&
        current.deviceName
      ) {
        rawEntries.push({
          screenId: current.screenId,
          name: current.name || current.deviceName,
          uniqueId: current.uniqueId || current.deviceName,
          deviceName: current.deviceName,
          screenType: current.screenType,
          width: current.width ?? 0,
          height: current.height ?? 0,
          uiOrientation: current.uiOrientation
        });
      }
      current = null;
    };

    for (const line of lines) {
      if (/^\s*Connected Screens:\s*$/.test(line)) {
        inConnectedScreens = true;
        continue;
      }
      if (!inConnectedScreens) {
        continue;
      }
      if (/^Port:\s*$/.test(line)) {
        flushCurrent();
        inConnectedScreens = false;
        continue;
      }

      const headerMatch = /^\s{4}\((\d+)\)\s+(.+?):\s*$/.exec(line);
      if (headerMatch) {
        flushCurrent();
        current = {
          screenId: headerMatch[1],
          name: headerMatch[2].trim()
        };
        continue;
      }

      if (!current) {
        continue;
      }

      const propMatch = /^\s{8}([^:]+):\s*(.*)$/.exec(line);
      if (!propMatch) {
        continue;
      }

      const key = propMatch[1].trim();
      const value = propMatch[2].trim();
      switch (key) {
        case 'Screen ID':
          current.screenId = value;
          break;
        case 'Name':
          current.name = value;
          break;
        case 'Unique ID':
          current.uniqueId = value;
          break;
        case 'Device Name':
          current.deviceName = value;
          break;
        case 'Screen Type':
          current.screenType = value;
          break;
        case 'Pixel Size': {
          const sizeMatch = /\{\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(value);
          if (sizeMatch) {
            current.width = Number.parseInt(sizeMatch[1], 10);
            current.height = Number.parseInt(sizeMatch[2], 10);
          }
          break;
        }
        case 'UI Orientation':
          current.uiOrientation = value;
          break;
      }
    }

    flushCurrent();

    if (rawEntries.length === 0) {
      return [];
    }

    if (rawEntries.length === 1) {
      const [only] = rawEntries;
      return [{
        screenId: only.screenId,
        name: only.name,
        uniqueId: only.uniqueId,
        deviceName: only.deviceName,
        role: 'main',
        width: only.width,
        height: only.height,
        uiOrientation: only.uiOrientation,
        active: true
      }];
    }

    const sorted = [...rawEntries].sort((a, b) => {
      if (a.deviceName === 'primary' && b.deviceName !== 'primary') return -1;
      if (b.deviceName === 'primary' && a.deviceName !== 'primary') return 1;
      return a.width * a.height - b.width * b.height;
    });

    return sorted.map((entry, idx) => {
      const role: DisplayRole = idx === 0 ? 'outer' : idx === 1 ? 'inner' : 'integrated';
      return {
        screenId: entry.screenId,
        name: entry.name,
        uniqueId: entry.uniqueId,
        deviceName: entry.deviceName,
        role,
        width: entry.width,
        height: entry.height,
        uiOrientation: entry.uiOrientation,
        active: false
      };
    });
  }

  private async enumerateIntegratedDisplays(udid: string): Promise<SimulatorDisplayInfo[]> {
    const output = await this.executeCommand('xcrun', ['simctl', 'io', udid, 'enumerate']);
    const displays = this.parseIntegratedDisplays(output);
    if (displays.length > 1) {
      this.multiDisplayUdids.add(udid);
    }
    return displays;
  }

  private async readHingeAngle(udid: string): Promise<number> {
    const output = await this.executeCommand('idb', ['hinge', '--udid', udid, '--json']);
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed.angle === 'number' && Number.isFinite(parsed.angle)) {
        return parsed.angle;
      }
    } catch {
      const numeric = Number.parseFloat(output);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    throw new Error(`Could not parse hinge angle from idb output: ${output}`);
  }

  private async readOrientation(udid: string): Promise<DeviceOrientation> {
    const output = await this.executeCommand('idb', ['rotation', '--udid', udid, '--json']);
    let rawOrientation = output.trim();
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed.orientation === 'string') {
        rawOrientation = parsed.orientation.trim();
      }
    } catch {
      // Plain text orientation output
    }
    const upper = rawOrientation.toUpperCase() as DeviceOrientation;
    if (VALID_ORIENTATIONS.has(upper)) {
      return upper;
    }
    throw new Error(`Unrecognized device orientation from idb: ${output}`);
  }

  private async captureDisplaySnapshots(
    udid: string,
    displays: SimulatorDisplayInfo[],
    deadline = Date.now() + 30_000
  ): Promise<{ displays: SimulatorDisplayInfo[]; buffers: Record<string, Buffer> }> {
    const buffers: Record<string, Buffer> = Object.create(null);
    const inspections: PngInspection[] = [];
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-sim-displays-'));

    try {
      for (const [index, display] of displays.entries()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Timed out capturing simulator displays');
        const shotPath = path.join(tempDir, `${index}.png`);
        await this.executeCommand('xcrun', [
          'simctl',
          'io',
          udid,
          'screenshot',
          '--type=png',
          `--display=${display.deviceName}`,
          shotPath
        ], remaining);
        const buf = await fs.promises.readFile(shotPath);
        const inspection = inspectPngBuffer(buf);
        if (inspection.hasVisiblePixels === undefined) {
          throw new Error(`Invalid or unsupported PNG for display ${display.deviceName}`);
        }
        buffers[display.deviceName] = buf;
        inspections.push(inspection);
      }
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    const uniqueVisible = inspections.filter(info => info.hasVisiblePixels).length === 1;
    const resolvedDisplays = displays.map((display, index) => ({
      ...display,
      width: inspections[index].width ?? display.width,
      height: inspections[index].height ?? display.height,
      active: displays.length === 1 ? true : uniqueVisible ? Boolean(inspections[index].hasVisiblePixels) : null
    }));

    return { displays: resolvedDisplays, buffers };
  }

  private async captureActiveDisplay(udid: string, displays: SimulatorDisplayInfo[]) {
    const deadline = Date.now() + 30_000;
    let snapshots = await this.captureDisplaySnapshots(udid, displays, deadline);
    if (!snapshots.displays.some(display => display.active) && Date.now() < deadline) {
      snapshots = await this.captureDisplaySnapshots(udid, displays, deadline);
    }
    return snapshots;
  }

  private normalizeDisplaySelector(raw: string): string {
    const cleaned = raw.trim().toLowerCase();
    if (
      cleaned === 'all' ||
      cleaned === 'all displays' ||
      cleaned === 'all screens' ||
      cleaned === 'both' ||
      cleaned === 'both displays' ||
      cleaned === 'todas' ||
      cleaned === 'todas las pantallas' ||
      cleaned === 'ambas' ||
      cleaned === 'ambas pantallas'
    ) {
      return 'all';
    }
    if (cleaned === 'outer' || cleaned === 'cover' || cleaned === 'exterior' || cleaned === 'externa') {
      return 'outer';
    }
    if (cleaned === 'inner' || cleaned === 'interior' || cleaned === 'interna') {
      return 'inner';
    }
    if (cleaned === 'active' || cleaned === 'activa' || cleaned === 'current' || cleaned === 'actual') {
      return 'active';
    }
    if (cleaned === 'main' || cleaned === 'principal') {
      return 'main';
    }
    return cleaned;
  }

  private matchesDisplaySelector(display: SimulatorDisplayInfo, normalizedSelector: string): boolean {
    if (normalizedSelector === 'active') {
      return display.active === true;
    }
    return (
      display.role.toLowerCase() === normalizedSelector ||
      display.deviceName.toLowerCase() === normalizedSelector ||
      display.screenId.toLowerCase() === normalizedSelector ||
      display.name.toLowerCase() === normalizedSelector ||
      display.uniqueId.toLowerCase() === normalizedSelector
    );
  }

  private selectDisplays(
    displays: SimulatorDisplayInfo[],
    normalizedSelector: string,
    rawSelector: string
  ): SimulatorDisplayInfo[] {
    if (normalizedSelector === 'all') {
      return displays;
    }
    if (normalizedSelector === 'active') {
      const active = displays.find(d => d.active);
      if (!active) throw new Error('Could not determine the active display');
      return [active];
    }
    const matched = displays.filter(d => this.matchesDisplaySelector(d, normalizedSelector));
    if (matched.length === 0) {
      const available = displays.map(d => `${d.role}:${d.deviceName}`).join(', ');
      throw new Error(`Display "${rawSelector}" not found on simulator (available: ${available})`);
    }
    return matched;
  }

  private describePostureMismatch(posture: SimulatorPosture, expected: ExpectedPosture): string | null {
    const reasons: string[] = [];

    if (expected.orientation !== undefined && posture.orientation !== expected.orientation) {
      reasons.push(`expected orientation ${expected.orientation}, got ${posture.orientation}`);
    }

    if (expected.angle !== undefined) {
      if (posture.angle === null) {
        reasons.push(`expected hinge angle ${expected.angle} degrees, but simulator is not foldable`);
      } else if (Math.abs(posture.angle - expected.angle) > HINGE_TOLERANCE_DEGREES) {
        reasons.push(`expected hinge angle ${expected.angle} degrees, got ${posture.angle} degrees`);
      }
    }

    if (expected.minAngle !== undefined) {
      if (posture.angle === null) {
        reasons.push(`expected hinge angle >= ${expected.minAngle} degrees, but simulator is not foldable`);
      } else if (posture.angle < expected.minAngle - HINGE_TOLERANCE_DEGREES) {
        reasons.push(`expected hinge angle >= ${expected.minAngle} degrees, got ${posture.angle} degrees`);
      }
    }

    if (expected.maxAngle !== undefined) {
      if (posture.angle === null) {
        reasons.push(`expected hinge angle <= ${expected.maxAngle} degrees, but simulator is not foldable`);
      } else if (posture.angle > expected.maxAngle + HINGE_TOLERANCE_DEGREES) {
        reasons.push(`expected hinge angle <= ${expected.maxAngle} degrees, got ${posture.angle} degrees`);
      }
    }

    if (expected.activeDisplay !== undefined) {
      const normalized = this.normalizeDisplaySelector(expected.activeDisplay);
      if (!posture.activeDisplay || !this.matchesDisplaySelector(posture.activeDisplay, normalized)) {
        const actualLabel = posture.activeDisplay
          ? `${posture.activeDisplay.role} (${posture.activeDisplay.deviceName})`
          : 'unknown';
        reasons.push(`expected active display "${expected.activeDisplay}", got "${actualLabel}"`);
      }
    }

    return reasons.length > 0 ? reasons.join('; ') : null;
  }

  async setHingeAngle(sessionId: string, angle: number): Promise<HingeAngleResult> {
    const udid = this.requireSessionUDID(sessionId);
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 180) {
      throw new Error('Hinge angle must be a finite number between 0 and 180 degrees');
    }

    await this.executeCommand('idb', ['hinge', String(angle), '--udid', udid]);

    const maxAttempts = Math.max(1, this.settleMaxAttempts);
    let lastMeasuredAngle = Number.NaN;
    let angleMatched = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      lastMeasuredAngle = await this.readHingeAngle(udid);
      if (Math.abs(lastMeasuredAngle - angle) <= HINGE_TOLERANCE_DEGREES) {
        angleMatched = true;
        break;
      }
      if (attempt < maxAttempts - 1 && this.settleIntervalMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.settleIntervalMs));
      }
    }

    if (!angleMatched) {
      throw new Error(
        `Hinge angle mismatch: requested ${angle} degrees, measured ${lastMeasuredAngle} degrees`
      );
    }

    const displays = await this.enumerateIntegratedDisplays(udid);
    if (displays.length === 0) {
      return { angle, measuredAngle: lastMeasuredAngle, activeDisplay: null };
    }

    const displayAttempts = displays.length > 1 ? Math.min(3, maxAttempts) : 1;
    let activeDisplay: SimulatorDisplayInfo | null = null;
    const deadline = Date.now() + 30_000;

    for (let dAttempt = 0; dAttempt < displayAttempts && Date.now() < deadline; dAttempt++) {
      const snapshots = await this.captureDisplaySnapshots(udid, displays, deadline);
      activeDisplay = snapshots.displays.find(d => d.active) ?? null;
      if (activeDisplay) {
        break;
      }
      if (dAttempt < displayAttempts - 1 && this.settleIntervalMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.settleIntervalMs * 2));
      }
    }

    return {
      angle,
      measuredAngle: lastMeasuredAngle,
      activeDisplay
    };
  }

  async getPosture(sessionId: string): Promise<SimulatorPosture> {
    const udid = this.requireSessionUDID(sessionId);
    const [displays, orientation] = await Promise.all([
      this.enumerateIntegratedDisplays(udid),
      this.readOrientation(udid)
    ]);

    if (displays.length > 1) {
      const angle = await this.readHingeAngle(udid);
      const snapshots = await this.captureDisplaySnapshots(udid, displays);
      const activeDisplay = snapshots.displays.find(d => d.active) ?? null;
      return {
        foldable: true,
        angle,
        orientation,
        activeDisplay,
        displays: snapshots.displays
      };
    }

    const singleDisplays = displays.map(d => ({ ...d, active: true }));
    return {
      foldable: false,
      angle: null,
      orientation,
      activeDisplay: singleDisplays[0] ?? null,
      displays: singleDisplays
    };
  }

  async setOrientation(
    sessionId: string,
    orientation: DeviceOrientation,
    expectedPosture?: ExpectedPosture
  ): Promise<SimulatorPosture> {
    const udid = this.requireSessionUDID(sessionId);
    if (!VALID_ORIENTATIONS.has(orientation)) {
      throw new Error(`Invalid device orientation: ${orientation}`);
    }

    await this.executeCommand('idb', ['rotation', orientation, '--udid', udid]);

    const orientationAttempts = Math.max(1, Math.min(this.settleMaxAttempts, 6));
    for (let attempt = 0; attempt < orientationAttempts; attempt++) {
      const currentOrientation = await this.readOrientation(udid);
      if (currentOrientation === orientation) {
        break;
      }
      if (attempt < orientationAttempts - 1 && this.settleIntervalMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.settleIntervalMs));
      }
    }

    const postureAttempts = expectedPosture?.activeDisplay ? Math.min(2, orientationAttempts) : 1;
    let lastMismatch = 'unknown posture state';

    for (let attempt = 0; attempt < postureAttempts; attempt++) {
      const posture = await this.getPosture(sessionId);
      const mismatch = this.describePostureMismatch(posture, {
        ...expectedPosture,
        orientation
      });
      if (!mismatch) {
        return posture;
      }
      lastMismatch = mismatch;
      if (attempt < postureAttempts - 1 && this.settleIntervalMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.settleIntervalMs * 2));
      }
    }

    throw new Error(`Posture mismatch: ${lastMismatch}`);
  }

  async takeScreenshot(
    sessionId: string,
    outputPath?: string,
    display?: string
  ): Promise<Buffer | string | LabelledScreenshot[] | SavedDisplayScreenshot[]> {
    const udid = this.requireSessionUDID(sessionId);
    const normalizedSelector = display !== undefined ? this.normalizeDisplaySelector(display) : undefined;

    if (normalizedSelector === undefined) {
      if (this.multiDisplayUdids.has(udid)) {
        const displays = await this.enumerateIntegratedDisplays(udid);
        if (!displays.length) throw new Error('No integrated displays reported by simulator');
        if (displays.length > 1) {
          const snapshots = await this.captureActiveDisplay(udid, displays);
          const [active] = this.selectDisplays(snapshots.displays, 'active', 'active');
          const buffer = snapshots.buffers[active.deviceName];
          if (outputPath) {
            await fs.promises.writeFile(outputPath, buffer);
            return outputPath;
          }
          return buffer;
        }
      }

      if (outputPath) {
        await this.executeCommand('idb', ['screenshot', '--udid', udid, '--', outputPath]);
        return outputPath;
      }

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-sim-screenshot-'));
      const tempPath = path.join(tempDir, 'screenshot.png');
      try {
        await this.executeCommand('idb', ['screenshot', '--udid', udid, '--', tempPath]);
        return await fs.promises.readFile(tempPath);
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }

    const displays = await this.enumerateIntegratedDisplays(udid);
    if (displays.length === 0) {
      throw new Error('No integrated displays reported by simulator');
    }

    const snapshots = normalizedSelector === 'active'
      ? await this.captureActiveDisplay(udid, displays)
      : await this.captureDisplaySnapshots(udid, displays);
    const selectedDisplays = this.selectDisplays(snapshots.displays, normalizedSelector, display!);

    const formatLabel = (d: SimulatorDisplayInfo): string =>
      `${d.role} (${d.deviceName}, ${d.width}x${d.height}, ${d.active === null ? 'activity unknown' : d.active ? 'active' : 'inactive'})`;

    if (outputPath) {
      let isDirectory = false;
      try {
        isDirectory = (await fs.promises.stat(outputPath)).isDirectory();
      } catch {
        isDirectory = false;
      }

      const multipleOutputs = normalizedSelector === 'all' || selectedDisplays.length > 1;
      const saved: SavedDisplayScreenshot[] = [];

      for (const d of selectedDisplays) {
        const buffer = snapshots.buffers[d.deviceName];
        const targetPath = isDirectory
          ? path.join(outputPath, `screenshot-${d.role}.png`)
          : multipleOutputs
            ? appendSuffixBeforeExtension(outputPath, `-${d.role}`)
            : outputPath;
        await fs.promises.writeFile(targetPath, buffer);
        saved.push({
          label: formatLabel(d),
          display: d,
          path: targetPath
        });
      }

      return saved;
    }

    return selectedDisplays.map(d => ({
      label: formatLabel(d),
      display: d,
      buffer: snapshots.buffers[d.deviceName],
      mimeType: 'image/png' as const
    }));
  }

  async getSystemLogs(sessionId: string, options?: { 
    bundle?: string;
    since?: Date;
    limit?: number;
  }): Promise<string> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    const args = ['log', '--udid', udid, '--', 'stream'];
    if (options?.bundle) {
      const output = await this.executeCommand('idb', ['list-apps', '--udid', udid, '--json']);
      const app = this.parseAppList(output).find(item => item.bundle_id === options.bundle);
      if (app?.pid === undefined || app.pid === null) {
        throw new Error(`Application is not running: ${options.bundle}`);
      }
      args.push('--process', String(app.pid));
    }
    args.push('--timeout', '5');
    const output = await this.executeCommand('idb', args);
    return options?.limit === undefined
      ? output
      : output.split('\n').slice(0, Math.max(0, options.limit)).join('\n');
  }

  async getAppLogs(sessionId: string, bundleId: string): Promise<string> {
    return this.getSystemLogs(sessionId, { bundle: bundleId });
  }

  async listSimulatorSessions(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async isSimulatorBooted(sessionId: string): Promise<boolean> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const simulators = await this.listBootedSimulators();
    return simulators.some(sim => sim.udid === udid);
  }

  async isAppInstalled(sessionId: string, bundleId: string): Promise<boolean> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // A failure to list the apps is not the same as the app being absent:
    // let it propagate so the caller can tell a missing app from a broken idb.
    const output = await this.executeCommand('idb', ['list-apps', '--udid', udid, '--json']);
    const apps = this.parseAppList(output);
    return apps.some(app => app.bundle_id === bundleId);
  }

  async focusSimulator(sessionId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['focus', '--udid', udid]);
  }

  async uninstallApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['uninstall', '--udid', udid, '--', bundleId]);
  }

  async listApps(sessionId: string): Promise<AppInfo[]> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const output = await this.executeCommand('idb', ['list-apps', '--udid', udid, '--json']);
    const apps = this.parseAppList(output);
    return apps.map(app => ({
      bundleId: app.bundle_id,
      name: app.name || app.bundle_id,
      installedPath: app.install_path
    }));
  }

  async pressButton(sessionId: string, button: ButtonType, duration?: number): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const args = ['ui', 'button', button];
    if (duration) args.push('--duration', String(duration / 1000));
    args.push('--udid', udid);
    await this.executeCommand('idb', args);
  }

  async inputText(sessionId: string, text: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['ui', 'text', '--udid', udid, '--', text]);
  }

  async pressKey(sessionId: string, keyCode: number, duration?: number): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const args = ['ui', 'key', String(keyCode)];
    if (duration) args.push('--duration', String(duration / 1000));
    args.push('--udid', udid);
    await this.executeCommand('idb', args);
  }

  async pressKeySequence(sessionId: string, keyCodes: number[]): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', [
      'ui',
      'key-sequence',
      ...keyCodes.map(String),
      '--udid',
      udid
    ]);
  }

  async getDebugServerStatus(sessionId: string): Promise<{ running: boolean; port?: number; bundleId?: string; }> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    try {
      const output = await this.executeCommand('idb', ['debugserver', 'status', '--udid', udid]);
      if (output === 'Not Running') {
        return { running: false };
      }
      const portMatch = /connect:\/\/[^:\s]+:(\d+)/.exec(output);
      return {
        running: true,
        port: portMatch ? Number.parseInt(portMatch[1], 10) : undefined
      };
    } catch (error) {
      return { running: false };
    }
  }

  async listCrashLogs(sessionId: string, options?: {
    bundleId?: string;
    before?: Date;
    since?: Date;
  }): Promise<CrashLogInfo[]> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const args = ['crash', 'list', '--udid', udid];
    if (options?.bundleId) args.push('--bundle-id', options.bundleId);
    if (options?.before) args.push('--before', String(Math.floor(options.before.getTime() / 1000)));
    if (options?.since) args.push('--since', String(Math.floor(options.since.getTime() / 1000)));
    const output = await this.executeCommand('idb', args);
    return output.split('\n').filter(Boolean).map(line => {
      const crash = JSON.parse(line) as IDBCrashLogInfo;
      return {
        name: crash.name ?? '',
        bundleId: crash.bundle_id ?? undefined,
        date: crash.timestamp === null ? new Date() : new Date(crash.timestamp * 1000),
        path: ''
      };
    });
  }

  async getCrashLog(sessionId: string, crashName: string): Promise<string> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.executeCommand('idb', ['crash', 'show', '--udid', udid, '--', crashName]);
  }

  async deleteCrashLogs(sessionId: string, options: {
    crashNames?: string[];
    bundleId?: string;
    before?: Date;
    since?: Date;
    all?: boolean;
  }): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (options.all) {
      await this.executeCommand('idb', ['crash', 'delete', '--udid', udid, '--all']);
      return;
    }
    if (options.crashNames?.length) {
      for (const crashName of options.crashNames) {
        await this.executeCommand('idb', ['crash', 'delete', '--udid', udid, '--', crashName]);
      }
      return;
    }
    const args = ['crash', 'delete', '--udid', udid];
    if (options.bundleId) args.push('--bundle-id', options.bundleId);
    if (options.before) args.push('--before', String(Math.floor(options.before.getTime() / 1000)));
    if (options.since) args.push('--since', String(Math.floor(options.since.getTime() / 1000)));
    await this.executeCommand('idb', args);
  }

  async installDylib(sessionId: string, dylibPath: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['dylib', 'install', '--udid', udid, '--', dylibPath]);
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['open', '--udid', udid, '--', url]);
  }

  async clearKeychain(sessionId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['clear-keychain', '--udid', udid]);
  }

  async setLocation(sessionId: string, latitude: number, longitude: number): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', [
      'set-location',
      '--udid',
      udid,
      String(latitude),
      String(longitude)
    ]);
  }

  async addMedia(sessionId: string, mediaPaths: string[]): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['add-media', '--udid', udid, '--', ...mediaPaths]);
  }

  async approvePermissions(sessionId: string, bundleId: string, permissions: string[]): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['approve', '--udid', udid, '--', bundleId, ...permissions]);
  }

  async updateContacts(sessionId: string, dbPath: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['contacts', 'update', '--udid', udid, '--', dbPath]);
  }
}
