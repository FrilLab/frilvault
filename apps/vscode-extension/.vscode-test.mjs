import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  tests: [{
    files: 'out/test/**/*.test.js',
    srcDir: 'out',
  }],
  coverage: {
    include: '**/*.js',
    exclude: ['test/**'],
    includeAll: true,
    reporter: ['text-summary', 'lcov'],
    output: 'coverage',
  },
});
