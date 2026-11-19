// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * IIDBManager - Interface for managing iOS simulators through idb
 * 
 * This interface defines the necessary methods to interact with iOS simulators
 * using the idb tool (https://fbidb.io/docs/commands).
 */

export interface SimulatorInfo {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | 'Unknown';
  os: string;
  deviceType: string;
}

export interface AppInfo {
  bundleId: string;
  name: string;
  installedPath?: string;
}

export interface SessionConfig {
  deviceName?: string;
  platformVersion?: string;
  timeout?: number;
  autoboot?: boolean;
}

export type ButtonType = 'APPLE_PAY' | 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI';

export interface CrashLogInfo {
  name: string;
  bundleId?: string;
  date: Date;
  path: string;
}

export interface AccessibilityInfo {
  identifier?: string;
  label?: string;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  type?: string;
  value?: string;
  children?: AccessibilityInfo[];
}

export interface IIDBManager {
  // === Simulator Management ===
  
  /**
   * Initializes a new simulator session
   * @param config Optional configuration for the session
   * @returns Created session ID
   */
  createSimulatorSession(config?: SessionConfig): Promise<string>;

  /**
   * Terminates an existing simulator session
   * @param sessionId Session ID to terminate
   */
  terminateSimulatorSession(sessionId: string): Promise<void>;

  /**
   * Lists all available simulators
   * @returns List of simulator information
   */
  listAvailableSimulators(): Promise<SimulatorInfo[]>;

  /**
   * Lists currently booted simulators
   * @returns List of booted simulator information
   */
  listBootedSimulators(): Promise<SimulatorInfo[]>;

  /**
   * Boots a simulator by its UDID
   * @param udid UDID of the simulator to boot
   */
  bootSimulatorByUDID(udid: string): Promise<void>;

  /**
   * Shuts down a simulator by its UDID
   * @param udid UDID of the simulator to shut down
   */
  shutdownSimulatorByUDID(udid: string): Promise<void>;

  /**
   * Shuts down a simulator by its session ID
   * @param sessionId Session ID of the simulator to shut down
   */
  shutdownSimulator(sessionId: string): Promise<void>;

  /**
   * Lists active simulator sessions
   * @returns List of active session IDs
   */
  listSimulatorSessions(): Promise<string[]>;

  /**
   * Verifies if a simulator is booted
   * @param sessionId Session ID of the simulator
   * @returns true if booted, false otherwise
   */
  isSimulatorBooted(sessionId: string): Promise<boolean>;

  /**
   * Focuses the simulator window
   * @param sessionId Session ID of the simulator
   */
  focusSimulator?(sessionId: string): Promise<void>;

  // === Application Management ===

  /**
   * Installs an application on the simulator
   * @param sessionId Session ID of the simulator
   * @param appPath Path to the .app or .ipa file to install
   * @returns Information about the installed application
   */
  installApp(sessionId: string, appPath: string): Promise<AppInfo>;

  /**
   * Launches an application on the simulator
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application to launch
   * @param env Environment variables (optional)
   * @param args Launch arguments (optional)
   */
  launchApp(
    sessionId: string, 
    bundleId: string, 
    env?: Record<string, string>,
    args?: string[]
  ): Promise<void>;

  /**
   * Terminates a running application
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application to terminate
   */
  terminateApp(sessionId: string, bundleId: string): Promise<void>;

  /**
   * Uninstalls an application
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application to uninstall
   */
  uninstallApp?(sessionId: string, bundleId: string): Promise<void>;

  /**
   * Lists installed applications
   * @param sessionId Session ID of the simulator
   * @returns List of application information
   */
  listApps?(sessionId: string): Promise<AppInfo[]>;

  /**
   * Verifies if an application is installed
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application
   * @returns true if installed, false otherwise
   */
  isAppInstalled(sessionId: string, bundleId: string): Promise<boolean>;

  // === UI Interaction ===

  /**
   * Performs a tap at the specified coordinates
   * @param sessionId Session ID of the simulator
   * @param x X coordinate
   * @param y Y coordinate
   * @param duration Tap duration in milliseconds (optional)
   */
  tap(sessionId: string, x: number, y: number, duration?: number): Promise<void>;

  /**
   * Performs a swipe on the screen
   * @param sessionId Session ID of the simulator
   * @param startX Initial X coordinate
   * @param startY Initial Y coordinate
   * @param endX Final X coordinate
   * @param endY Final Y coordinate
   * @param duration Swipe duration in milliseconds (optional)
   * @param delta Size of each swipe step (optional)
   */
  swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
    delta?: number
  ): Promise<void>;

  /**
   * Presses a device button
   * @param sessionId Session ID of the simulator
   * @param button Type of button to press
   * @param duration Press duration in milliseconds (optional)
   */
  pressButton?(
    sessionId: string,
    button: ButtonType,
    duration?: number
  ): Promise<void>;

  /**
   * Inputs text into the simulator
   * @param sessionId Session ID of the simulator
   * @param text Text to input
   */
  inputText?(sessionId: string, text: string): Promise<void>;

  /**
   * Presses a specific key by its code
   * @param sessionId Session ID of the simulator
   * @param keyCode Key code
   * @param duration Press duration in milliseconds (optional)
   */
  pressKey?(
    sessionId: string,
    keyCode: number,
    duration?: number
  ): Promise<void>;

  /**
   * Presses a sequence of keys
   * @param sessionId Session ID of the simulator
   * @param keyCodes List of key codes to press sequentially
   */
  pressKeySequence?(
    sessionId: string,
    keyCodes: number[]
  ): Promise<void>;

  // === Accessibility ===

  /**
   * Describes all accessibility elements on the screen
   * @param sessionId Session ID of the simulator
   * @returns Accessibility information for all elements
   */
  describeAllElements?(sessionId: string): Promise<AccessibilityInfo[]>;

  /**
   * Describes the accessibility element at a specific point
   * @param sessionId Session ID of the simulator
   * @param x X coordinate
   * @param y Y coordinate
   * @returns Accessibility information for the element at the point
   */
  describePointElement?(
    sessionId: string,
    x: number,
    y: number
  ): Promise<AccessibilityInfo | null>;

  // === Screenshots and Logs ===

  /**
   * Takes a screenshot of the simulator
   * @param sessionId Session ID of the simulator
   * @param outputPath Path where to save the screenshot (optional)
   * @returns Buffer with the image or path to the saved file
   */
  takeScreenshot(sessionId: string, outputPath?: string): Promise<any | string>;

  /**
   * Starts video recording of the simulator
   * @param sessionId Session ID of the simulator
   * @param outputPath Path where to save the video
   * @returns Recording ID
   */
  startVideoRecording?(sessionId: string, outputPath: string): Promise<string>;

  /**
   * Stops video recording of the simulator
   * @param sessionId Session ID of the simulator
   * @param recordingId Recording ID to stop (optional; defaults to active recording for session)
   */
  stopVideoRecording?(sessionId: string, recordingId?: string): Promise<void>;

  /**
   * Gets simulator system logs
   * @param sessionId Session ID of the simulator
   * @param options Filtering options (optional)
   * @returns System logs
   */
  getSystemLogs(sessionId: string, options?: { 
    bundle?: string;
    since?: Date;
    limit?: number;
  }): Promise<string>;

  /**
   * Gets logs for a specific application
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application
   * @returns Application logs
   */
  getAppLogs(sessionId: string, bundleId: string): Promise<string>;

  // === Debug ===

  /**
   * Starts a debug session for an application
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application to debug
   * @returns Connection port for the debugger
   */
  startDebugServer?(sessionId: string, bundleId: string): Promise<number>;

  /**
   * Stops a debug session
   * @param sessionId Session ID of the simulator
   */
  stopDebugServer?(sessionId: string): Promise<void>;

  /**
   * Gets the debug session status
   * @param sessionId Session ID of the simulator
   * @returns Information about the debug session
   */
  getDebugServerStatus?(sessionId: string): Promise<{
    running: boolean;
    port?: number;
    bundleId?: string;
  }>;

  // === Crash Logs ===

  /**
   * Lists available crash logs
   * @param sessionId Session ID of the simulator
   * @param options Filtering options (optional)
   * @returns List of crash log information
   */
  listCrashLogs?(sessionId: string, options?: {
    bundleId?: string;
    before?: Date;
    since?: Date;
  }): Promise<CrashLogInfo[]>;

  /**
   * Gets the content of a crash log
   * @param sessionId Session ID of the simulator
   * @param crashName Name of the crash log
   * @returns Content of the crash log
   */
  getCrashLog?(sessionId: string, crashName: string): Promise<string>;

  /**
   * Deletes crash logs
   * @param sessionId Session ID of the simulator
   * @param options Options for deleting logs (optional)
   */
  deleteCrashLogs?(sessionId: string, options: {
    crashNames?: string[];
    bundleId?: string;
    before?: Date;
    since?: Date;
    all?: boolean;
  }): Promise<void>;

  // === Miscellaneous ===

  /**
   * Installs a dynamic library (.dylib)
   * @param sessionId Session ID of the simulator
   * @param dylibPath Path to the .dylib library
   */
  installDylib?(sessionId: string, dylibPath: string): Promise<void>;

  /**
   * Opens a URL in the simulator
   * @param sessionId Session ID of the simulator
   * @param url URL to open
   */
  openUrl?(sessionId: string, url: string): Promise<void>;

  /**
   * Clears the simulator keychain
   * @param sessionId Session ID of the simulator
   */
  clearKeychain?(sessionId: string): Promise<void>;

  /**
   * Sets the simulator location
   * @param sessionId Session ID of the simulator
   * @param latitude Latitude
   * @param longitude Longitude
   */
  setLocation?(
    sessionId: string,
    latitude: number,
    longitude: number
  ): Promise<void>;

  /**
   * Adds media files to the simulator camera roll
   * @param sessionId Session ID of the simulator
   * @param mediaPaths Paths to media files
   */
  addMedia?(sessionId: string, mediaPaths: string[]): Promise<void>;

  /**
   * Approves permissions for an application
   * @param sessionId Session ID of the simulator
   * @param bundleId Bundle ID of the application
   * @param permissions Permissions to approve (photos, camera, contacts, etc.)
   */
  approvePermissions?(
    sessionId: string,
    bundleId: string,
    permissions: string[]
  ): Promise<void>;

  /**
   * Updates the simulator contacts database
   * @param sessionId Session ID of the simulator
   * @param dbPath Path to the contacts database
   */
  updateContacts?(sessionId: string, dbPath: string): Promise<void>;
}
