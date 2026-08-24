import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataDir = join(tmpdir(), `frilvault-vscode-test-${process.pid}`);

export default defineConfig({
  tests: [{
    files: 'out/test/**/*.test.js',
    srcDir: 'out',
    launchArgs: [`--user-data-dir=${userDataDir}`],
  }],
  coverage: {
    include: '**/*.js',
    exclude: ['test/**'],
    includeAll: true,
    reporter: ['text-summary', 'lcov'],
    output: 'coverage',
  },
});
