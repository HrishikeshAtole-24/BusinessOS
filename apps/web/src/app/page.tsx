import { redirect } from 'next/navigation';
import { getSession } from '../lib/session';

/**
 * Root route. Sends signed-in users to the dashboard and everyone else to the
 * sign-in screen, so `/` is never a dead end.
 */
export default async function RootPage() {
  const session = await getSession();
  redirect(session ? '/dashboard' : '/login');
}
