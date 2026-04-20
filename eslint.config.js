// ESLint flat config. Runs typescript-eslint with the type-checked
// preset — the big win is `no-floating-promises`, which catches
// async calls that forgot an `await` (a common Playwright fixture
// bug). Everything else in the preset is cosmetic by comparison.
//
// Scope is limited to src/ and tests/ .ts files. Generated output
// (dist/) is ignored so we don't drag the type-checker across code
// it doesn't own.

const tseslint = require('typescript-eslint');

module.exports = [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'heal-playwright-tracer-*.tgz',
      'eslint.config.js',
      '**/*.d.ts',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['src/**/*.ts', 'tests/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.lint.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The Babel plugin and recorder cross a lot of `unknown` boundaries;
      // requiring full type narrowing on every access would be noisy.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // The error/value serializers call String(unknown) on purpose —
      // [object Object] is an acceptable fallback for malformed throws.
      '@typescript-eslint/no-base-to-string': 'off',
      // We intentionally save raw method references for monkey-patching
      // (test-stdout-capture) and re-invoke them via .call.
      '@typescript-eslint/unbound-method': 'off',
      // Intentional redundancy in a couple of places (e.g. unknown | Page).
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      // Legacy perf-hooks-clock uses a runtime require; not worth rewriting.
      '@typescript-eslint/no-require-imports': 'off',
      // The codebase has intentional `any` in a handful of cross-boundary
      // spots; type-safety is enforced by `unknown` elsewhere.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
