import { redirect } from 'next/navigation';
import Link from 'next/link';
import { SignupForm } from '../../../components/SignupForm';
import { getSession } from '../../../lib/session';

export const metadata = { title: 'Create account — BusinessOS' };

export default async function SignupPage() {
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

        <SignupForm />

        <p className="auth-footer">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
