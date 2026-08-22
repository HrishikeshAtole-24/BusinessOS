import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Fail the production build on type errors. This is Next's default, but
  // stating it prevents a future "just ship it" flag from being added quietly.
  // (Next 16 removed the `eslint` key from this config; linting runs in CI.)
  typescript: { ignoreBuildErrors: false },

  // The web app renders HTML, so unlike the API it needs a real CSP rather than
  // a deny-all one. Section 18.4.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
