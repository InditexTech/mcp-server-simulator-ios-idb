// SPDX-FileCopyrightText: © 2025 Industria de Diseño Textil S.A. INDITEX
// SPDX-License-Identifier: Apache-2.0

/**
 * Jest configuration for the opt-in real-simulator integration suite.
 *
 * This project is intentionally separate from jest.config.js: `npm test` runs
 * only the standard unit test directory and can never match the files declared
 * here, so the default suite never boots or mutates a simulator. The
 * integration suite only runs through `npm run test:integration` with
 * IOS_SIM_INTEGRATION=1 and every simulator interaction is scoped to the
 * disposable device created by src/__integration__/support/simulatorHarness.js.
 */

/** @type {import('@jest/types').Config.InitialOptions} */
export default (() => {
  if (process.env.IOS_SIM_INTEGRATION !== '1') {
    // Defense-in-depth: even a direct `jest -c jest.integration.config.js`
    // must refuse to touch a simulator without the explicit opt-in.
    throw new Error(
      'The integration suite mutates simulator state and requires explicit ' +
      'opt-in. Run it with: IOS_SIM_INTEGRATION=1 npm run test:integration'
    );
  }
  return {
    rootDir: '.',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
      '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {
      '^.+\\.(t|j)sx?$': ['@swc/jest', {
        jsc: {
          parser: { syntax: 'typescript' },
          target: 'es2020',
        },
        module: { type: 'es6' },
      }],
    },
    testMatch: [
      '**/__integration__/**/*.integration.test.js',
      '**/__integration__/**/*.integration.test.ts',
      '!**/fixtures/**',
      '!**/*.d.ts'
    ],
    // Serial only: one owned simulator serves the whole run.
    maxWorkers: 1,
    // Setup/teardown own boot waits and cleanup; per-test timeouts stay large
    // because idb and simulator operations are slow.
    testTimeout: 240000,
    globalSetup: '<rootDir>/src/__integration__/support/globalSetup.js',
    globalTeardown: '<rootDir>/src/__integration__/support/globalTeardown.js',
  };
})();
