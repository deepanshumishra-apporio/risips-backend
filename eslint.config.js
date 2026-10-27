// ESLint: type-aware checks on top of tsc. The important ones for this code base: no promise left un-awaited
// (every database and FP call is async) and no awaiting of something that isn't a promise.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'state-production/', 'data/', 'test/smoke-onboard.cjs', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // node:test's describe()/it() return promises the runner itself waits on
      '@typescript-eslint/no-floating-promises': ['error', { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'] }] }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off', // FP's replies are typed loosely on purpose (FpObject / JsonObject)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
    },
  },
);
