// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
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

  private async executeCommand(command: string, args: string[] = []): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args);
      return stdout.trim();
    } catch (error: any) {
      console.error(`Error executing command: ${command}`, args);
      console.error(error.message);
      throw new Error(`Error executing command: ${error.message}`);
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
    for (const recording of sessionRecordings) {
      try {
        await this.stopVideoRecording(sessionId, recording.recordingId);
      } catch {
        this.activeRecordings.delete(recording.recordingId);
      }
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
    let udid: string;

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
      udid = simulator.udid;
    } else {
      if (simulators.length === 0) {
        throw new Error('No available simulators found');
      }
      udid = simulators[0].udid;
    }

    if (config?.autoboot !== false) {
      await this.bootSimulatorByUDID(udid);
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
    await this.cleanupSessionRecordings(sessionId);
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

  async takeScreenshot(sessionId: string, outputPath?: string): Promise<Buffer | string> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    const tempPath = outputPath || path.join(process.cwd(), `screenshot_${Date.now()}.png`);
    await this.executeCommand('idb', ['screenshot', '--udid', udid, '--', tempPath]);
    
    if (outputPath) {
      return outputPath;
    } else {
      const buffer = fs.readFileSync(tempPath);
      fs.unlinkSync(tempPath);
      return buffer;
    }
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

  async describeAllElements(sessionId: string): Promise<AccessibilityInfo[]> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const output = await this.executeCommand('idb', ['ui', 'describe-all', '--udid', udid, '--json']);
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
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const output = await this.executeCommand('idb', [
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
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }

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

      child.once('error', (err: Error) => {
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
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let entry: ActiveVideoRecording | undefined;
    if (recordingId !== undefined) {
      const candidate = this.activeRecordings.get(recordingId);
      if (!candidate || candidate.sessionId !== sessionId) {
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
        let timedOut = false;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            timedOut = true;
            try {
              entry!.process.kill('SIGKILL');
            } catch {
              // Best-effort force kill
            }
            resolve();
          }, VIDEO_STOP_TIMEOUT_MS);
          timer.unref?.();

          entry!.exitPromise.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });

        if (timedOut) {
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
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const output = await this.executeCommand('idb', ['debugserver', 'start', '--udid', udid, '--', bundleId]);
    const portMatch = /connect:\/\/[^:\s]+:(\d+)/.exec(output);
    if (!portMatch) {
      throw new Error(`Could not read the debug server port from idb output: ${output}`);
    }
    return Number.parseInt(portMatch[1], 10);
  }

  async stopDebugServer(sessionId: string): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', ['debugserver', 'stop', '--udid', udid]);
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
