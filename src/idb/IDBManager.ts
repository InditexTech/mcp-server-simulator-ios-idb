// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { 
  IIDBManager, 
  SimulatorInfo, 
  AppInfo, 
  SessionConfig,
  ButtonType,
  AccessibilityInfo,
  CrashLogInfo
} from './interfaces/IIDBManager.js';

const execFileAsync = promisify(execFile);

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
  private readonly activeRecordings: Map<string, ActiveVideoRecording> = new Map();
  private sessionCounter: number = 0;
  private recordingCounter: number = 0;
  private idbAvailabilityPromise: Promise<void> | null = null;

  private async executeCommand(command: string, args: string[] = []): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args);
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

    let selectedSimulator: SimulatorInfo | undefined;
    if (config?.deviceName) {
      // The parser may lowercase the instruction, so compare case-insensitively.
      // A UDID is accepted too, for when a name is ambiguous.
      const wanted = config.deviceName.trim().toLowerCase();
      selectedSimulator = simulators.find(sim =>
        (sim.name.toLowerCase() === wanted || sim.udid.toLowerCase() === wanted) &&
        (!config.platformVersion || sim.os.includes(config.platformVersion))
      );

      if (!selectedSimulator) {
        throw new Error(`No simulator found with name ${config.deviceName}`);
      }
    } else {
      if (simulators.length === 0) {
        throw new Error('No available simulators found');
      }
      selectedSimulator = simulators[0];
    }

    if (config?.autoboot !== false && selectedSimulator.state !== 'Booted') {
      await this.bootAndAwaitSimulator(selectedSimulator.udid);
    }

    const sessionId = this.generateSessionId();
    this.sessions.set(sessionId, selectedSimulator.udid);
    return sessionId;
  }

  async terminateSimulatorSession(sessionId: string): Promise<void> {
    this.requireSessionUDID(sessionId);
    await this.cleanupSessionRecordings(sessionId);
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

  async takeScreenshot(sessionId: string, outputPath?: string): Promise<Buffer | string> {
    const udid = this.requireSessionUDID(sessionId);

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
        // Best-effort temp cleanup: never mask a primary screenshot or read error
      }
    }
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
