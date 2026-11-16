/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'typescript' },
        target: 'es2020',
      },
      module: { type: 'es6' },
    }],
  },
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '!**/*.d.ts'
  ],
};
