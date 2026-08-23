'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

/**
 * Organization settings, with optimistic concurrency (report Section 11.2).
 *
 * The form holds the `version` it was rendered with and sends it back on save.
 * The API matches on that version and increments it; a stale value matches zero
 * rows and returns 409 rather than silently discarding whatever someone else
 * saved in between.
 *
 * The 409 branch is the interesting one, and it is easy to demonstrate: open
 * this page in two tabs, save in one, then save in the other.
 */

interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  version: number;
}

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
];

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];

export function OrganizationSettingsForm({ organization }: { organization: Organization }) {
  const router = useRouter();
  const [name, setName] = useState(organization.name);
  const [timezone, setTimezone] = useState(organization.timezone);
  const [currency, setCurrency] = useState(organization.currency);
  const [version, setVersion] = useState(organization.version);

  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== organization.name ||
    timezone !== organization.timezone ||
    currency !== organization.currency;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setConflict(false);
    setSaved(false);
    setPending(true);

    try {
      const response = await fetch(`${API_URL}/v1/organizations/current`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, timezone, currency, version }),
      });

      const body = (await response.json()) as {
        error?: { code: string; message: string };
        version?: number;
      };

      if (response.status === 409 && body.error?.code === 'VERSION_CONFLICT') {
        // Someone else saved first. Do not overwrite them and do not silently
        // reload either — the user has unsaved edits in front of them and
        // deserves to decide.
        setConflict(true);
        return;
      }

      if (!response.ok) {
        setError(body.error?.message ?? 'Could not save changes.');
        return;
      }

      // Adopt the new version so a second save from this same form works
      // without a page reload.
      if (typeof body.version === 'number') setVersion(body.version);
      setSaved(true);
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Organization</h2>
        <span className="badge" title="Optimistic concurrency version">
          v{version}
        </span>
      </div>

      <form className="card-body stack" onSubmit={handleSubmit}>
        {conflict ? (
          <div className="alert alert-danger" role="alert">
            <div className="stack-sm" style={{ display: 'flex', flexDirection: 'column' }}>
              <strong>Someone else changed this first</strong>
              <span style={{ fontSize: 'var(--text-sm)' }}>
                Your copy is out of date. Reload to see their changes — your edits here are not
                saved.
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ alignSelf: 'flex-start', marginTop: 'var(--space-2)' }}
                onClick={() => router.refresh()}
              >
                Reload
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}

        {saved ? (
          <div className="alert alert-success" role="status">
            Changes saved.
          </div>
        ) : null}

        <div className="field">
          <label className="label" htmlFor="org-name">
            Name
          </label>
          <input
            id="org-name"
            className="input"
            value={name}
            required
            minLength={2}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="org-slug">
            URL name
          </label>
          <input id="org-slug" className="input" value={organization.slug} disabled readOnly />
          <span className="field-hint">
            Fixed after creation — it appears in links that may already be shared.
          </span>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label className="label" htmlFor="org-timezone">
              Timezone
            </label>
            <select
              id="org-timezone"
              className="input"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: '1 1 140px' }}>
            <label className="label" htmlFor="org-currency">
              Currency
            </label>
            <select
              id="org-currency"
              className="input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save changes'}
          </button>
          {dirty ? <span className="subtle">Unsaved changes</span> : null}
        </div>
      </form>
    </section>
  );
}
