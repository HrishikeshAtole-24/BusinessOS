import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint configuration.
 *
 * Flat config (ESLint 9+), which is why this is a `.js` module exporting an
 * array rather than a `.eslintrc`.
 *
 * The rules that earn their place here are the **type-aware** ones. Syntax
 * linting largely duplicates what `strict` TypeScript already catches; the
 * value is in rules that need the type checker — and those are the reason
 * ADR-014 pinned TypeScript 5.9 rather than adopting TS 7, whose type
 * information typescript-eslint cannot yet read.
 */

export const baseConfig = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },

    rules: {
      /**
       * The four that matter most in this codebase.
       *
       * The API is asynchronous almost end to end, and an unawaited promise
       * crossing a transaction boundary is the failure mode that actually
       * happens: the transaction commits while the work inside it is still
       * pending, and nothing reports an error.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      /**
       * `any` disables the type checker exactly where someone was least sure —
       * which is where checking is worth most. `unknown` plus narrowing is the
       * honest alternative.
       */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      // Underscore-prefixed args are the convention for deliberately unused
      // plugin parameters (`_opts`), which Fastify's signature requires.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `import type` keeps type-only imports out of emitted JS, which
      // `verbatimModuleSyntax` in the tsconfig also depends on.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // A template literal around an object prints "[object Object]" — always a
      // bug, never intent.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // Tests assert on loosely-typed fixtures and deliberately construct invalid
    // input; enforcing full type safety there fights the point of the test.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/seed.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);

export default baseConfig;
