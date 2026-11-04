const connection = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};

module.exports = {
  __esModule: true,
  default: {
    fetch: jest.fn(async () => connection),
    addEventListener: jest.fn(() => jest.fn()),
  },
};