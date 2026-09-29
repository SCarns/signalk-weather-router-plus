// Flat ESLint config (ESLint 9+), the same rule set as signalk-parquet:
// TypeScript recommended + Prettier, with `any` and console kept as
// warnings and intentional empty catch blocks allowed.
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'public/', 'test-data/', 'data/'],
  },
  js.configs.recommended,
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
  prettierRecommended,
];
