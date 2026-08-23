'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

/**
 * Sign-up form.
 *
 * Creates the user and their first organization in one request — the API does
 * both in a single transaction, so there is no state where an account exists
 * without the tenant it was meant to own.
 */

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  organizationName?: string;
}

/** Mirrors the server rule in `passwordSchema`. */
const MIN_PASSWORD_LENGTH = 12;

/** The field paths this form renders an inline error for. */
const FIELD_NAMES: Array<keyof FieldErrors> = ['name', 'email', 'password', 'organizationName'];

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    // Client-side checks are for fast feedback only. The API validates the same
    // rules again, because anything a browser enforces can be bypassed.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldErrors({ password: `Use at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    setPending(true);
    try {
      const response = await fetch(`${API_URL}/v1/auth/signup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          ...(organizationName.trim() ? { organizationName: organizationName.trim() } : {}),
        }),
      });

      const body = (await response.json()) as {
        error?: {
          message: string;
          details?: { issues?: Array<{ path: string; message: string }> };
        };
      };

      if (!response.ok) {
        // Map field-level issues back onto their inputs; fall back to a
        // form-level message when the failure is not about one field.
        const issues = body.error?.details?.issues;
        if (issues?.length) {
          const mapped: FieldErrors = {};
          for (const issue of issues) {
            // Allowlist the paths we render. An unrecognised path from the
            // server would otherwise be written into state under a key nothing
            // displays, silently swallowing the message.
            if (FIELD_NAMES.includes(issue.path as keyof FieldErrors)) {
              mapped[issue.path as keyof FieldErrors] = issue.message;
            }
          }
          setFieldErrors(mapped);
        }
        setError(body.error?.message ?? 'Something went wrong. Try again.');
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Cannot reach the API. Is it running on port 4000?');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-panel" onSubmit={handleSubmit} noValidate>
      <div className="auth-heading">
        <h1 style={{ fontSize: 'var(--text-lg)' }}>Create your workspace</h1>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          You will be the owner of the organization you create
        </p>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="name">
          Your name
        </label>
        <input
          id="name"
          className="input"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldErrors.name ? 'true' : undefined}
          aria-describedby={fieldErrors.name ? 'name-error' : undefined}
        />
        {fieldErrors.name ? (
          <span className="field-error" id="name-error">
            {fieldErrors.name}
          </span>
        ) : null}
      </div>

      <div className="field">
        <label className="label" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={fieldErrors.email ? 'true' : undefined}
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
        />
        {fieldErrors.email ? (
          <span className="field-error" id="email-error">
            {fieldErrors.email}
          </span>
        ) : null}
      </div>

      <div className="field">
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={fieldErrors.password ? 'true' : undefined}
          aria-describedby={fieldErrors.password ? 'password-error' : 'password-hint'}
        />
        {fieldErrors.password ? (
          <span className="field-error" id="password-error">
            {fieldErrors.password}
          </span>
        ) : (
          <span className="field-hint" id="password-hint">
            At least {MIN_PASSWORD_LENGTH} characters. Length beats symbols.
          </span>
        )}
      </div>

      <div className="field">
        <label className="label" htmlFor="organizationName">
          Company name
        </label>
        <input
          id="organizationName"
          className="input"
          name="organizationName"
          required
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          placeholder="Acme Industries"
          aria-describedby="org-hint"
        />
        <span className="field-hint" id="org-hint">
          Creates the organization with six roles and makes you its owner.
        </span>
      </div>

      <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}
