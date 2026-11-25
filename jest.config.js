const common = {
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js'],
  resolver: 'ts-jest-resolver',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }]
  }
}

export default {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/__tests__/unit/**/*.test.ts']
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/__tests__/integration/**/*.test.ts']
    }
  ]
}
