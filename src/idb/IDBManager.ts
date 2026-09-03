// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * IDB manager implementation for interacting with iOS simulators
 */
export class IDBManager implements IIDBManager {
  private sessions: Map<string, string> = new Map(); // sessionId -> udid
  private sessionCounter: number = 0;

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

  private parseAppList(output: string): any[] {
    return output
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        const app = JSON.parse(line);
        return Array.isArray(app) ? app : [app];
      });
  }

  private async verifyIDBAvailability(): Promise<void> {
    try {
      await this.executeCommand('idb', ['--version']);
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

    if (config?.deviceName) {
      const simulators = await this.listAvailableSimulators();
      const simulator = simulators.find(sim => 
        sim.name === config.deviceName && 
        (!config.platformVersion || sim.os.includes(config.platformVersion))
      );

      if (!simulator) {
        throw new Error(`No simulator found with name ${config.deviceName}`);
      }
      udid = simulator.udid;
    } else {
      const simulators = await this.listAvailableSimulators();
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
    
    await this.executeCommand('idb', ['install', '--udid', udid, '--', appPath]);
    
    const appName = path.basename(appPath, path.extname(appPath));
    const bundleId = `com.example.${appName}`;
    
    return {
      bundleId,
      name: appName,
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
      String(duration),
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
    
    const args = ['log', '--udid', udid, '--'];
    if (options?.bundle) args.push('--bundle', options.bundle);
    if (options?.limit) args.push('--limit', String(options.limit));
    args.push('--timeout', '5');
    return this.executeCommand('idb', args);
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
    try {
      const output = await this.executeCommand('idb', ['list-apps', '--udid', udid, '--json']);
      const apps = this.parseAppList(output);
      return apps.some((app: any) => app.bundle_id === bundleId);
    } catch (error) {
      return false;
    }
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
    return apps.map((app: any) => ({
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
    if (duration) args.push('--duration', String(duration));
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
    if (duration) args.push('--duration', String(duration));
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
      if (output.includes("No debug server running")) {
        return { running: false };
      }
      const portMatch = output.match(/port: (\d+)/);
      const bundleMatch = output.match(/bundle_id: ([^\s]+)/);
      return {
        running: true,
        port: portMatch ? parseInt(portMatch[1], 10) : undefined,
        bundleId: bundleMatch ? bundleMatch[1] : undefined
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
    if (options?.before) args.push('--before', options.before.toISOString());
    if (options?.since) args.push('--since', options.since.toISOString());
    const output = await this.executeCommand('idb', args);
    const lines = output.split('\n').filter(Boolean);
    return lines.map(line => {
      const parts = line.split(' - ');
      return {
        name: parts[0].trim(),
        bundleId: parts[1]?.trim(),
        date: new Date(parts[2]?.trim() || Date.now()),
        path: parts[3]?.trim() || ''
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
    if (options.before) args.push('--before', options.before.toISOString());
    if (options.since) args.push('--since', options.since.toISOString());
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
    await this.executeCommand('idb', ['clear_keychain', '--udid', udid]);
  }

  async setLocation(sessionId: string, latitude: number, longitude: number): Promise<void> {
    const udid = this.sessions.get(sessionId);
    if (!udid) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.executeCommand('idb', [
      'set_location',
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
