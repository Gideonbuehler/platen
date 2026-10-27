// Lints every TypeScript project in the repo, the mobile app included.
//
// Deliberately the untyped rule sets: they catch real mistakes (unused code,
// hooks called conditionally, stale effect dependencies) in a couple of
// seconds, where type-aware linting would re-run the compiler that
// `npm run typecheck` already runs.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'server/public/**',
      'mobile/android/**',
      'mobile/ios/**',
      'mobile/.expo/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_` marks a parameter that has to exist for its position.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'branding/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The server logs through Fastify's logger, which the container's log
    // collection understands; a stray console.log bypasses it.
    files: ['server/src/**/*.ts'],
    ignores: ['server/src/**/*.test.ts', 'server/src/tools/**'],
    rules: { 'no-console': 'error' },
  },
  {
    // Both wrap optional native ML libraries loaded with a dynamic import(),
    // whose types are not there to name when the optional install is skipped.
    files: ['server/src/services/ml.ts', 'server/src/services/faces.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['web/**/*.{ts,tsx}', 'mobile/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // `require('./image.png')` is how React Native bundles a static asset.
    files: ['mobile/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['mobile/*.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
