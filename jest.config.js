module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  resolver: 'react-native-worklets/jest/resolver',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-native-firebase|@react-native-google-signin|react-native-calendars|react-native-safe-area-context|react-native-swipe-gestures|recyclerlistview|memoize-one|react-native-reanimated|react-native-worklets|react-native-svg|@react-navigation|@notifee|@invertase)/)',
  ],
  // Exclude e2e tests — they require a running device/emulator and are not
  // part of the unit test suite.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/e2e/',
    // KAN-294: abandoned git worktrees live under .claude/worktrees/. They're
    // git-ignored via .git/info/exclude, which keeps them out of `git status`
    // but has no effect on Jest's file crawl — without this, Jest discovers
    // and runs a duplicate copy of every suite from each stale worktree.
    '<rootDir>/\\.claude/worktrees/',
  ],
  // KAN-294: also exclude the worktrees from the Haste module map. Ignoring
  // them for test discovery alone is not enough — the haste map still crawls
  // them for modules and emits duplicate-name collision warnings ('brush',
  // 'brush-functions', src/services/__mocks__/*) on every run.
  modulePathIgnorePatterns: [
    '<rootDir>/\\.claude/worktrees/',
  ],
  moduleNameMapper: {
    // Binary model asset — stub so Jest doesn't try to parse it as a module.
    '\\.tflite$': '<rootDir>/__mocks__/tfliteAsset.js',
  },
};
