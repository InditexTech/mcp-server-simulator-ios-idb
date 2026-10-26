/**
 * Integration tests against a real iOS Simulator.
 * Opt-in: they only run when IOS_SIM_INTEGRATION=1 (see AGENTS.md).
 * @type {import('@jest/types').Config.InitialOptions}
 */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': '@swc/jest',
  },
  testMatch: [
    '**/__integration__/**/*.test.ts'
  ],
  globalSetup: './src/__integration__/globalSetup.ts',
  globalTeardown: './src/__integration__/globalTeardown.ts',
  testTimeout: 120000,
  maxWorkers: 1,
};
