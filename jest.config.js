/** @type {import('@jest/types').Config.InitialOptions} */
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
    '**/__tests__/**/*.test.ts',
    '!**/*.d.ts'
  ],
};
