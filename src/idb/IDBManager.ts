// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { 
  IIDBManager, 
  SimulatorPlatform,
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

function classifySimulatorPlatform(
  sim: Pick<SimulatorInfo, 'os' | 'deviceType'>
): SimulatorPlatform {
  if (/^tvOS\b/i.test(sim.os) || /Apple-TV/i.test(sim.deviceType)) {
    return 'tvos';
  }
  if (/^iOS\b/i.test(sim.os) || /\b(iPhone|iPad)\b/i.test(sim.deviceType)) {
    return 'ios';
  }
  if (/^watchOS\b/i.test(sim.os) || /Apple-Watch/i.test(sim.deviceType)) {
    return 'watchos';
  }
  if (/^(visionOS|xrOS)\b/i.test(sim.os) || /Apple-Vision/i.test(sim.deviceType)) {
    return 'visionos';
  }
  return 'unknown';
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

interface VideoProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface ActiveVideoRecording {
  recordingId: string;
  sessionId: string;
  outputPath: string;
  process: ChildProcess;
  stderrTail: string;
  exitResult?: VideoProcessExit;
  exitPromise: Promise<VideoProcessExit>;
}

const VIDEO_START_TIMEOUT_MS = 15_000;
const VIDEO_STOP_TIMEOUT_MS = 15_000;
const MAX_STDERR_TAIL_CHARS = 4_096;

/**
 * IDB manager implementation for interacting with iOS simulators
 */
export class IDBManager implements IIDBManager {
  private readonly sessions: Map<string, string> = new Map(); // sessionId -> udid
  private readonly sessionPlatforms: Map<string, SimulatorPlatform> = new Map();
  private readonly activeRecordings: Map<string, ActiveVideoRecording> = new Map();
  private sessionCounter: number = 0;
  private recordingCounter: number = 0;
  private idbAvailabilityPromise: Promise<void> | null = null;
  private readonly multiDisplayUdids: Set<string> = new Set();
  private settleMaxAttempts: number = 20;
  private settleIntervalMs: number = 250;

  private async executeCommand(command: string, args: string[] = [], timeout?: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout });
      return stdout.trim();
    } catch (error: any) {
      console.error(`Error executing command: ${command}`, args);
      console.error(error.message);
      const wrappedError = new Error(`Error executing command: ${error.message}`) as NodeJS.ErrnoException;
      if (error?.code !== undefined) {
        wrappedError.code = error.code;
      }
      throw wrappedError;
    }
  }

  private async executeIDBCommand(args: string[]): Promise<string> {
    try {
      return await this.executeCommand('idb', args);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || /\bspawn\s+idb\s+ENOENT\b/.test(String(error?.message ?? ''))) {
        this.idbAvailabilityPromise = null;
      }
      throw error;
    }
  }

  private requireSessionUDID(sessionId: string): string {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return udid;
  }

  private assertTouchSupported(sessionId: string, operation: string): void {
    if (this.sessionPlatforms.get(sessionId) === 'tvos') {
      throw new Error(
        `Touch input (${operation}) is not supported on tvOS simulators (no touchscreen). ` +
        'Use Siri Remote navigation ("press remote up/down/left/right/select/menu") or ' +
        'accessibility element activation ("tap element ...") instead.'
      );
    }
  }

  private assertMobilePostureSupported(sessionId: string, operation: string): void {
    if (this.sessionPlatforms.get(sessionId) === 'tvos') {
      throw new Error(`${operation} is not supported on tvOS simulators.`);
    }
  }

  private spawnProcess(command: string, args: string[] = []): ChildProcess {
    return spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  private normalizeAccessibilityElement(raw: Record<string, any>): AccessibilityInfo {
    const frame = raw?.frame ?? {};
    const element: AccessibilityInfo = {
      frame: {
        x: Number(frame.x ?? 0),
        y: Number(frame.y ?? 0),
        width: Number(frame.width ?? 0),
        height: Number(frame.height ?? 0)
      }
    };
    const identifier = raw?.AXUniqueId ?? raw?.identifier;
    if (typeof identifier === 'string' && identifier.length > 0) {
      element.identifier = identifier;
    }
    const label = raw?.AXLabel ?? raw?.label;
    if (typeof label === 'string') {
      element.label = label;
    }
    const type = raw?.type ?? raw?.role;
    if (typeof type === 'string' && type.length > 0) {
      element.type = type;
    }
    const value = raw?.AXValue ?? raw?.value;
    if (value !== undefined && value !== null) {
      element.value = String(value);
    }
    if (Array.isArray(raw?.children)) {
      element.children = raw.children.map((child: Record<string, any>) =>
        this.normalizeAccessibilityElement(child)
      );
    }
    return element;
  }

  private async cleanupSessionRecordings(sessionId: string): Promise<void> {
    const sessionRecordings = Array.from(this.activeRecordings.values())
      .filter(recording => recording.sessionId === sessionId);
    await Promise.all(sessionRecordings.map(async recording => {
      try {
        await this.stopVideoRecording(sessionId, recording.recordingId);
      } catch {
        this.activeRecordings.delete(recording.recordingId);
      }
    }));
  }

  private parseAppList(output: string): IDBAppInfo[] {
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as IDBAppInfo);
  }

  private async fetchInstalledApps(udid: string): Promise<IDBAppInfo[]> {
    const output = await this.executeIDBCommand(['list-apps', '--udid', udid, '--json']);
    return this.parseAppList(output);
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

  private verifyIDBAvailability(): Promise<void> {
    if (!this.idbAvailabilityPromise) {
      this.idbAvailabilityPromise = (async () => {
        try {
          await this.executeIDBCommand(['list-targets', '--only', 'simulator']);
        } catch {
          this.idbAvailabilityPromise = null;
          throw new Error('idb is not installed or not available in PATH. Make sure idb-companion and fb-idb are properly installed.');
        }
      })();
    }
    return this.idbAvailabilityPromise;
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${this.sessionCounter++}`;
  }

  async createSimulatorSession(config?: SessionConfig): Promise<string> {
    // Booted first: with several devices sharing a name (one per runtime),
    // reuse the one already running instead of booting another.
    const simulators = (await this.listAvailableSimulators())
      .sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted'));

    const wantedPlatform = config?.platformVersion?.trim().toLowerCase();
    let selectedSimulator: SimulatorInfo | undefined;
    if (config?.deviceName) {
      // The parser may lowercase the instruction, so compare case-insensitively.
      // A UDID is accepted too, for when a name is ambiguous.
      const wanted = config.deviceName.trim().toLowerCase();
      selectedSimulator = simulators.find(sim =>
        (sim.name.toLowerCase() === wanted || sim.udid.toLowerCase() === wanted) &&
        (!wantedPlatform || sim.os.toLowerCase().includes(wantedPlatform))
      );

      if (!selectedSimulator) {
        throw new Error(`No simulator found with name ${config.deviceName}`);
      }
    } else if (wantedPlatform) {
      selectedSimulator = simulators.find(sim =>
        sim.os.toLowerCase().includes(wantedPlatform)
      );
      if (!selectedSimulator) {
        throw new Error(`No simulator found for platform ${config!.platformVersion}`);
      }
    } else {
      if (simulators.length === 0) {
        throw new Error('No available simulators found');
      }
      // Preserve iOS as the default target when tvOS/watchOS/visionOS runtimes
      // are also installed on the host; fall back only if no iOS simulator exists.
      selectedSimulator =
        simulators.find(sim => classifySimulatorPlatform(sim) === 'ios') ?? simulators[0];
    }

    if (config?.autoboot !== false && selectedSimulator.state !== 'Booted') {
      await this.bootAndAwaitSimulator(selectedSimulator.udid);
    }

    if (selectedSimulator.deviceType === 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo') {
      this.multiDisplayUdids.add(selectedSimulator.udid);
    }

    const sessionId = this.generateSessionId();
    this.sessions.set(sessionId, selectedSimulator.udid);
    this.sessionPlatforms.set(sessionId, classifySimulatorPlatform(selectedSimulator));
    return sessionId;
  }

  async terminateSimulatorSession(sessionId: string): Promise<void> {
    this.requireSessionUDID(sessionId);
    await this.cleanupSessionRecordings(sessionId);
    this.sessions.delete(sessionId);
    this.sessionPlatforms.delete(sessionId);
  }

  async listAvailableSimulators(): Promise<SimulatorInfo[]> {
    await this.verifyIDBAvailability();
    const output = await this.executeCommand('xcrun', ['simctl', 'list', 'devices', '--json']);
    const data = JSON.parse(output);
    const simulators: SimulatorInfo[] = [];
    
    Object.entries(data.devices).forEach(([runtimeName, devices]: [string, any]) => {
      devices.forEach((device: any) => {
        if (device.isAvailable === false) {
          return;
        }
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

    await this.bootAndAwaitSimulator(udid);
  }

  private async bootAndAwaitSimulator(udid: string): Promise<void> {
    await this.executeCommand('xcrun', ['simctl', 'boot', udid]);
    const maxAttempts = 30;

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      try {
        const booted = await this.listBootedSimulators();
        if (booted.some(sim => sim.udid === udid)) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return;
        }
      } catch {
        // Ignore errors during boot
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error(`Timeout waiting for simulator ${udid} to boot`);
  }

  async shutdownSimulator(sessionId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.cleanupSessionRecordings(sessionId);
    await this.shutdownSimulatorByUDID(udid);
  }

  async shutdownSimulatorByUDID(udid: string): Promise<void> {
    await this.verifyIDBAvailability();
    await this.executeCommand('xcrun', ['simctl', 'shutdown', udid]);
  }

  async installApp(sessionId: string, appPath: string): Promise<AppInfo> {
    const udid = this.requireSessionUDID(sessionId);
    
    if (!fs.existsSync(appPath)) {
      throw new Error(`File does not exist: ${appPath}`);
    }
    
    // idb prints the bundle ID of the installed app; with --json it is a single JSON line
    const output = await this.executeIDBCommand(['install', '--udid', udid, '--json', '--', appPath]);
    
    return {
      bundleId: this.parseInstalledBundleId(output),
      name: path.basename(appPath, path.extname(appPath)),
      installedPath: appPath
    };
  }

  async launchApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['launch', '--udid', udid, '--', bundleId]);
  }

  async terminateApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['terminate', '--udid', udid, '--', bundleId]);
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    this.assertTouchSupported(sessionId, 'tap');
    await this.executeIDBCommand(['ui', 'tap', String(x), String(y), '--udid', udid]);
  }

  async swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number = 100
  ): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    this.assertTouchSupported(sessionId, 'swipe');
    await this.executeIDBCommand([
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
    const output = await this.executeIDBCommand(['hinge', '--udid', udid, '--json']);
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
    const output = await this.executeIDBCommand(['rotation', '--udid', udid, '--json']);
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
    this.assertMobilePostureSupported(sessionId, 'Hinge angle control');
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 180) {
      throw new Error('Hinge angle must be a finite number between 0 and 180 degrees');
    }

    await this.executeIDBCommand(['hinge', String(angle), '--udid', udid]);

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
    this.assertMobilePostureSupported(sessionId, 'Device orientation control');
    if (!VALID_ORIENTATIONS.has(orientation)) {
      throw new Error(`Invalid device orientation: ${orientation}`);
    }

    await this.executeIDBCommand(['rotation', orientation, '--udid', udid]);

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
        await this.executeIDBCommand(['screenshot', '--udid', udid, '--', outputPath]);
        return outputPath;
      }

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-sim-screenshot-'));
      const tempPath = path.join(tempDir, 'screenshot.png');
      try {
        await this.executeIDBCommand(['screenshot', '--udid', udid, '--', tempPath]);
        return await fs.promises.readFile(tempPath);
      } finally {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup: do not mask a screenshot or read error.
        }
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
    const udid = this.requireSessionUDID(sessionId);
    
    const args = ['log', '--udid', udid, '--', 'stream'];
    if (options?.bundle) {
      const apps = await this.fetchInstalledApps(udid);
      const app = apps.find(item => item.bundle_id === options.bundle);
      if (app?.pid === undefined || app.pid === null) {
        throw new Error(`Application is not running: ${options.bundle}`);
      }
      args.push('--process', String(app.pid));
    }
    args.push('--timeout', '5');
    const output = await this.executeIDBCommand(args);
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
    const udid = this.requireSessionUDID(sessionId);
    const simulators = await this.listBootedSimulators();
    return simulators.some(sim => sim.udid === udid);
  }

  async isAppInstalled(sessionId: string, bundleId: string): Promise<boolean> {
    const udid = this.requireSessionUDID(sessionId);
    // A failure to list the apps is not the same as the app being absent:
    // let it propagate so the caller can tell a missing app from a broken idb.
    const apps = await this.fetchInstalledApps(udid);
    return apps.some(app => app.bundle_id === bundleId);
  }

  async focusSimulator(sessionId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['focus', '--udid', udid]);
  }

  async uninstallApp(sessionId: string, bundleId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['uninstall', '--udid', udid, '--', bundleId]);
  }

  async listApps(sessionId: string): Promise<AppInfo[]> {
    const udid = this.requireSessionUDID(sessionId);
    const apps = await this.fetchInstalledApps(udid);
    return apps.map(app => ({
      bundleId: app.bundle_id,
      name: app.name || app.bundle_id,
      installedPath: app.install_path
    }));
  }

  async pressButton(sessionId: string, button: ButtonType, duration?: number): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    const args = ['ui', 'button', button];
    if (duration) args.push('--duration', String(duration / 1000));
    args.push('--udid', udid);
    await this.executeIDBCommand(args);
  }

  async inputText(sessionId: string, text: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['ui', 'text', '--udid', udid, '--', text]);
  }

  async pressKey(sessionId: string, keyCode: number, duration?: number): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    const args = ['ui', 'key', String(keyCode)];
    if (duration) args.push('--duration', String(duration / 1000));
    args.push('--udid', udid);
    await this.executeIDBCommand(args);
  }

  async pressKeySequence(sessionId: string, keyCodes: number[]): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand([
      'ui',
      'key-sequence',
      ...keyCodes.map(String),
      '--udid',
      udid
    ]);
  }

  async describeAllElements(sessionId: string): Promise<AccessibilityInfo[]> {
    const udid = this.requireSessionUDID(sessionId);
    const output = await this.executeIDBCommand(['ui', 'describe-all', '--udid', udid, '--json']);
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.map((item: Record<string, any>) => this.normalizeAccessibilityElement(item));
    }
    if (parsed && typeof parsed === 'object') {
      return [this.normalizeAccessibilityElement(parsed)];
    }
    return [];
  }

  async describePointElement(sessionId: string, x: number, y: number): Promise<AccessibilityInfo | null> {
    const udid = this.requireSessionUDID(sessionId);
    const output = await this.executeIDBCommand([
      'ui',
      'describe-point',
      '--udid',
      udid,
      '--json',
      '--',
      String(x),
      String(y)
    ]);
    if (!output) {
      return null;
    }
    const parsed = JSON.parse(output);
    if (parsed === null) {
      return null;
    }
    if (Array.isArray(parsed)) {
      return parsed.length > 0 ? this.normalizeAccessibilityElement(parsed[0]) : null;
    }
    if (typeof parsed === 'object') {
      return this.normalizeAccessibilityElement(parsed);
    }
    return null;
  }

  async startVideoRecording(sessionId: string, outputPath: string): Promise<string> {
    const udid = this.requireSessionUDID(sessionId);

    for (const existing of this.activeRecordings.values()) {
      if (existing.sessionId === sessionId && !existing.exitResult) {
        throw new Error(`Video recording is already active for session ${sessionId}: ${existing.recordingId}`);
      }
    }

    const recordingId = `recording_${Date.now()}_${this.recordingCounter++}`;
    const child = this.spawnProcess('idb', ['video', '--udid', udid, '--', outputPath]);

    let resolveExit!: (exit: VideoProcessExit) => void;
    const exitPromise = new Promise<VideoProcessExit>(resolve => {
      resolveExit = resolve;
    });

    const entry: ActiveVideoRecording = {
      recordingId,
      sessionId,
      outputPath,
      process: child,
      stderrTail: '',
      exitPromise
    };

    const recordExit = (exit: VideoProcessExit) => {
      if (!entry.exitResult) {
        entry.exitResult = exit;
        resolveExit(exit);
      }
    };

    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Best-effort cleanup on startup timeout
        }
        rejectReady(new Error(`Timeout waiting for video recording to start: ${entry.stderrTail.trim() || outputPath}`));
      }, VIDEO_START_TIMEOUT_MS);
      timer.unref?.();

      const finishReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveReady();
      };

      const finishError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectReady(error);
      };

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        entry.stderrTail = (entry.stderrTail + text).slice(-MAX_STDERR_TAIL_CHARS);
        // idb.common.signal prints "Running video until ^C" to stderr right after
        // installing its SIGINT/SIGTERM handlers on the asyncio loop.
        if (entry.stderrTail.includes('Running video')) {
          finishReady();
        }
      });

      child.once('error', (err: NodeJS.ErrnoException) => {
        if (err?.code === 'ENOENT' || /\bspawn\s+idb\s+ENOENT\b/.test(String(err?.message ?? ''))) {
          this.idbAvailabilityPromise = null;
        }
        recordExit({ code: null, signal: null, error: err });
        finishError(new Error(`Error executing command: ${err.message}`));
      });

      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        recordExit({ code, signal });
        finishError(new Error(
          `Video recording exited before becoming ready (code ${code ?? 'null'}): ${entry.stderrTail.trim() || 'no output'}`
        ));
      });
    });

    this.activeRecordings.set(recordingId, entry);
    return recordingId;
  }

  async stopVideoRecording(sessionId: string, recordingId?: string): Promise<void> {
    this.requireSessionUDID(sessionId);

    let entry: ActiveVideoRecording | undefined;
    if (recordingId !== undefined) {
      const candidate = this.activeRecordings.get(recordingId);
      if (candidate?.sessionId !== sessionId) {
        throw new Error(`Video recording not found for session ${sessionId}: ${recordingId}`);
      }
      entry = candidate;
    } else {
      entry = Array.from(this.activeRecordings.values())
        .find(candidate => candidate.sessionId === sessionId);
      if (!entry) {
        throw new Error(`No active video recording for session: ${sessionId}`);
      }
    }

    try {
      if (!entry.exitResult) {
        entry.process.kill('SIGINT');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          entry.exitPromise.then(() => false),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(true), VIDEO_STOP_TIMEOUT_MS);
            timer.unref?.();
          })
        ]);
        if (timer) {
          clearTimeout(timer);
        }

        if (timedOut) {
          try {
            entry.process.kill('SIGKILL');
          } catch {
            // Best-effort force kill
          }
          await entry.exitPromise;
          throw new Error(`Timeout waiting for video recording to stop: ${entry.recordingId}`);
        }
      }

      const exit = await entry.exitPromise;
      if (exit.error) {
        throw new Error(`Error stopping video recording: ${exit.error.message}`);
      }
      if (exit.code !== 0 && exit.code !== null) {
        throw new Error(`Video recording exited with code ${exit.code}: ${entry.stderrTail.trim()}`);
      }
    } finally {
      this.activeRecordings.delete(entry.recordingId);
    }
  }

  async startDebugServer(sessionId: string, bundleId: string): Promise<number> {
    const udid = this.requireSessionUDID(sessionId);
    const output = await this.executeIDBCommand(['debugserver', 'start', '--udid', udid, '--', bundleId]);
    const portMatch = /connect:\/\/[^:\s]+:(\d+)/.exec(output);
    if (!portMatch) {
      throw new Error(`Could not read the debug server port from idb output: ${output}`);
    }
    return Number.parseInt(portMatch[1], 10);
  }

  async stopDebugServer(sessionId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['debugserver', 'stop', '--udid', udid]);
  }

  async getDebugServerStatus(sessionId: string): Promise<{ running: boolean; port?: number; bundleId?: string; }> {
    const udid = this.requireSessionUDID(sessionId);
    try {
      const output = await this.executeIDBCommand(['debugserver', 'status', '--udid', udid]);
      if (output === 'Not Running') {
        return { running: false };
      }
      const portMatch = /connect:\/\/[^:\s]+:(\d+)/.exec(output);
      return {
        running: true,
        port: portMatch ? Number.parseInt(portMatch[1], 10) : undefined
      };
    } catch {
      return { running: false };
    }
  }

  async listCrashLogs(sessionId: string, options?: {
    bundleId?: string;
    before?: Date;
    since?: Date;
  }): Promise<CrashLogInfo[]> {
    const udid = this.requireSessionUDID(sessionId);
    const args = ['crash', 'list', '--udid', udid];
    if (options?.bundleId) args.push('--bundle-id', options.bundleId);
    if (options?.before) args.push('--before', String(Math.floor(options.before.getTime() / 1000)));
    if (options?.since) args.push('--since', String(Math.floor(options.since.getTime() / 1000)));
    const output = await this.executeIDBCommand(args);
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
    const udid = this.requireSessionUDID(sessionId);
    return this.executeIDBCommand(['crash', 'show', '--udid', udid, '--', crashName]);
  }

  async deleteCrashLogs(sessionId: string, options: {
    crashNames?: string[];
    bundleId?: string;
    before?: Date;
    since?: Date;
    all?: boolean;
  }): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    if (options.all) {
      await this.executeIDBCommand(['crash', 'delete', '--udid', udid, '--all']);
      return;
    }
    if (options.crashNames?.length) {
      for (const crashName of options.crashNames) {
        await this.executeIDBCommand(['crash', 'delete', '--udid', udid, '--', crashName]);
      }
      return;
    }
    const args = ['crash', 'delete', '--udid', udid];
    if (options.bundleId) args.push('--bundle-id', options.bundleId);
    if (options.before) args.push('--before', String(Math.floor(options.before.getTime() / 1000)));
    if (options.since) args.push('--since', String(Math.floor(options.since.getTime() / 1000)));
    await this.executeIDBCommand(args);
  }

  async installDylib(sessionId: string, dylibPath: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['dylib', 'install', '--udid', udid, '--', dylibPath]);
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['open', '--udid', udid, '--', url]);
  }

  async clearKeychain(sessionId: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['clear-keychain', '--udid', udid]);
  }

  async setLocation(sessionId: string, latitude: number, longitude: number): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand([
      'set-location',
      '--udid',
      udid,
      String(latitude),
      String(longitude)
    ]);
  }

  async addMedia(sessionId: string, mediaPaths: string[]): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['add-media', '--udid', udid, '--', ...mediaPaths]);
  }

  async approvePermissions(sessionId: string, bundleId: string, permissions: string[]): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['approve', '--udid', udid, '--', bundleId, ...permissions]);
  }

  async updateContacts(sessionId: string, dbPath: string): Promise<void> {
    const udid = this.requireSessionUDID(sessionId);
    await this.executeIDBCommand(['contacts', 'update', '--udid', udid, '--', dbPath]);
  }
}
