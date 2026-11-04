module.exports = {
  preset: '@react-native/jest-preset',

  testPathIgnorePatterns: [
    '/node_modules/',
    '/server/',
  ],

  moduleNameMapper: {
    '^react-native-image-picker$':
      '<rootDir>/__mocks__/react-native-image-picker.js',

    '^@bam.tech/react-native-image-resizer$':
      '<rootDir>/__mocks__/react-native-image-resizer.js',

    '^@react-native-async-storage/async-storage$':
      '<rootDir>/__mocks__/async-storage.js',

    '^@dr.pogodin/react-native-fs$':
      '<rootDir>/__mocks__/react-native-fs.js',

    '^@react-native-community/netinfo$':
      '<rootDir>/__mocks__/netinfo.js',
  },
};