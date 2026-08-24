import baseConfig from '@businessos/eslint-config';

/**
 * Web-specific ESLint configuration.
 *
 * The one meaningful relaxation is `checksVoidReturn.attributes`.
 *
 * React's event-handler props are typed as returning `void`, so the base rule
 * flags every `onClick={() => somethingAsync()}` — which is the idiomatic way
 * to write an async handler and is safe: React ignores the returned promise,
 * and the handler catches its own errors. Leaving the rule on here would mean
 * wrapping every handler in `void (...)` for no benefit, and blanket
 * `eslint-disable` comments would suppress the genuinely useful cases too.
 *
 * The rule stays fully on for RETURNS and ARGUMENTS, which is where an ignored
 * promise actually loses work.
 */
export default [
  ...baseConfig,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
            arguments: true,
            returns: true,
            variables: true,
            properties: true,
          },
        },
      ],
    },
  },
];
