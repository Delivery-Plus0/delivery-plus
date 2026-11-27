module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^@food-delivery/shared$': '<rootDir>/../../../shared/src/index.ts',
  },
};
