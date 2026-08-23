import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LoginForm } from '../../../components/LoginForm';
import { getSession } from '../../../lib/session';

export const metadata = { title: 'Sign in — BusinessOS' };

export default async function LoginPage() {
  // Already signed in: skip the form rather than showing it and confusing them.
  const session = await getSession();
  if (session) redirect('/dashboard');

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="sidebar-mark" aria-hidden="true">
            B
          </span>
          BusinessOS
        </div>

        <LoginForm />

        <p className="auth-footer">
          No account? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </main>
  );
}
