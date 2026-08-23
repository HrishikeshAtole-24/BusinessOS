import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BusinessOS',
  description: 'Multi-tenant company operations platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning covers exactly one thing: browser extensions
    // that mutate <html>/<body> before React hydrates. Grammarly adds
    // data-gr-ext-installed, password managers add their own attributes, and
    // the resulting mismatch is unfixable from our side because the server
    // never saw those attributes.
    //
    // It suppresses only attribute diffs on THESE two elements and does not
    // cascade to children, so real hydration bugs inside the app still surface.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
