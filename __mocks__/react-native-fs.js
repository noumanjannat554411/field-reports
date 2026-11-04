module.exports = {
  DocumentDirectoryPath: '/mock/documents',
  CachesDirectoryPath: '/mock/cache',

  exists: jest.fn(async () => false),
  mkdir: jest.fn(async () => {}),
  copyFile: jest.fn(async () => {}),
  unlink: jest.fn(async () => {}),
  stat: jest.fn(async () => ({size: 1000})),
  readFile: jest.fn(async () => ''),
};