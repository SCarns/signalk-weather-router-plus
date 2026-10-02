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
    // The web app: classic scripts sharing one global scope (rp-core.js
    // defines what the others use), so `no-undef` cannot judge them.
    // Not formatted by Prettier.
    files: ['public/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    rules: {
      'no-undef': 'off',
      // Top-level names are the shared scope (used from other files and index.html): only locals are checked.
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prettier/prettier': 'off',
    },
  },
];
