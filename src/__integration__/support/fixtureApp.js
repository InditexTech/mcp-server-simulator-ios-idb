// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the minimal SwiftUI fixture app used to prove install/uninstall,
 * real bundle ID, and text input behavior on the owned disposable simulator.
 *
 * The fixture is a macOS-source test asset compiled with the iOS simulator
 * SDK via xcrun swiftc: no Xcode project, no CocoaPods, no external tools.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_BUNDLE_ID = 'com.inditex.mcp.fixture.demo';

const SWIFT_SOURCES = {
  'main.swift': `import SwiftUI

@main
struct FixtureApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`,
  'ContentView.swift': `import SwiftUI

struct ContentView: View {
    @State private var enteredText: String = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("MCP Fixture")
                .font(.title)
            TextField("Enter text here", text: $enteredText)
                .textFieldStyle(.roundedBorder)
                .padding()
                .accessibilityIdentifier("fixtureTextField")
            Text("Value: \\(enteredText)")
                .accessibilityIdentifier("fixtureEchoLabel")
        }
        .padding(24)
    }
}
`,
  'Info.plist': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>MCP Fixture</string>
    <key>CFBundleExecutable</key>
    <string>FixtureApp</string>
    <key>CFBundleIdentifier</key>
    <string>${FIXTURE_BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>MCPFixture</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>UILaunchScreen</key>
    <dict/>
    <key>LSRequiresIPhoneOS</key>
    <true/>
</dict>
</plist>
`
};

/**
 * Compiles the fixture sources into a .app bundle for the iOS simulator.
 * @param {string} outDir Directory to place the bundle in
 * @returns {Promise<string>} Absolute path of the built .app
 */
export async function buildFixtureApp(outDir) {
  const srcDir = path.join(outDir, 'fixture-src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [name, content] of Object.entries(SWIFT_SOURCES)) {
    fs.writeFileSync(path.join(srcDir, name), content);
  }

  const appPath = path.join(outDir, 'FixtureApp.app');
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(appPath, { recursive: true });
  const binaryPath = path.join(appPath, 'FixtureApp');
  const swiftSources = ['main.swift', 'ContentView.swift'].map(f => path.join(srcDir, f));

  await execFileAsync('xcrun', [
    '-sdk', 'iphonesimulator', 'swiftc',
    '-swift-version', '5',
    '-parse-as-library',
    '-target', 'arm64-apple-ios15.0-simulator',
    '-o', binaryPath,
    ...swiftSources
  ], { timeout: 300_000 });

  fs.copyFileSync(path.join(srcDir, 'Info.plist'), path.join(appPath, 'Info.plist'));
  return appPath;
}
