// Flat ESLint config (ESLint 9+), the same rule set as signalk-parquet:
// TypeScript recommended + Prettier, with `any` and console kept as
// warnings and intentional empty catch blocks allowed.
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  {
    // public/ol.js and public/remoteEntry.js are vendored / built, not ours.
    ignores: ['dist/', 'node_modules/', 'coverage/', 'public/ol.js', 'public/remoteEntry.js', 'test-data/', 'data/'],
  },
  js.configs.recommended,
  {
    // Node scripts: the Node globals they use.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript itself reports use of undeclared identifiers.
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      // Empty catch blocks intentionally swallow best-effort operations.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'warn',
    },
  },
  {
    // The CLI prints by design; tests print timings the runner would otherwise hide.
    // The warning stays for plugin code, where the Signal K log is the right place.
    files: ['src/cli.ts', 'src/**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  prettierRecommended,
  {
    // The web app: ES modules (rp-plan.js and rp-settings.js are the
    // entries; rp-layers.js and rp-core.js below them). Only the browser
    // and the vendored OpenLayers (`ol`) are globals. Not formatted by
    // Prettier.
    files: ['public/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: Object.fromEntries(
        [
          'window', 'document', 'console', 'navigator', 'localStorage', 'fetch', 'alert', 'confirm',
          'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
          'encodeURIComponent', 'AbortController', 'CustomEvent', 'DOMException', 'Event', 'EventSource', 'ImageData',
          'MutationObserver', 'ResizeObserver', 'Uint8Array', 'Uint8ClampedArray', 'Blob', 'URL', 'ol',
        ].map(g => [g, 'readonly'])
      ),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prettier/prettier': 'off',
    },
  },
];
