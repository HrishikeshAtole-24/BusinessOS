import Link from 'next/link';
import { API_URL } from '../../../lib/api';
import { AcceptInviteForm } from '../../../components/AcceptInviteForm';

export const metadata = { title: 'Accept invitation — BusinessOS' };

interface InvitePreview {
  email: string;
  organization: { name: string; slug: string };
  role: { key: string; name: string };
  requiresAccount: boolean;
}

/**
 * Invitation landing page.
 *
 * Unauthenticated by design — the token in the URL is the credential. The
 * preview is fetched server-side so an invalid or expired link shows a clear
 * message instead of an empty form that fails on submit.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let preview: InvitePreview | null = null;
  try {
    const response = await fetch(`${API_URL}/v1/invitations/preview/${token}`, {
      cache: 'no-store',
    });
    if (response.ok) preview = (await response.json()) as InvitePreview;
  } catch {
    // API unreachable — handled by the null branch below.
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sidebar-mark" aria-hidden="true">
            B
          </span>
          BusinessOS
        </div>

        {preview ? (
          <AcceptInviteForm token={token} preview={preview} />
        ) : (
          <div className="auth-panel">
            <div className="auth-heading">
              <h1 style={{ fontSize: 'var(--text-lg)' }}>This invitation is not valid</h1>
            </div>
            <p className="muted" style={{ textAlign: 'center' }}>
              It may have expired, already been used, or been revoked. Ask whoever invited you to
              send a new one.
            </p>
            <Link className="btn btn-secondary btn-block" href="/login">
              Go to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
