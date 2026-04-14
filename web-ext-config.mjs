export default {
  sourceDir: '.',
  ignoreFiles: [
    '.git/**',
    '.github/**',
    '.claude/**',
    'node_modules/**',
    'artifacts/**',
    '*.xpi',
    '*.zip',
    'web-ext-config.mjs',
    'package-lock.json',
    'manifest.xml',
    'taskpane.*'
  ],
  build: {
    overwriteDest: true
  }
};
