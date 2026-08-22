/**
 * Foundation status page.
 *
 * A Server Component that calls the API's readiness endpoint (report Section
 * 24.1: "dashboard initial view -> Server Component"). It exists to prove the
 * web -> API path end to end and will be replaced by the real dashboard.
 *
 * Note what it does NOT do: reach into the database directly. Section 24.1 is
 * explicit that the API stays the business boundary and Server Components must
 * not become a second, inconsistent place where authorization lives.
 */

interface DependencyResult {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
}

interface ReadyResponse {
  status: string;
  checks: { database: DependencyResult; cache: DependencyResult };
}

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

async function fetchHealth(): Promise<ReadyResponse | null> {
  try {
    const res = await fetch(`${API_URL}/health/ready`, {
      // Always live: a cached health check is worse than none.
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()) as ReadyResponse;
  } catch {
    // The API being unreachable is itself the status, not a crash.
    return null;
  }
}

function Row({ name, result }: { name: string; result: DependencyResult | undefined }) {
  const status = result?.status ?? 'down';
  const tone = status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'down';

  return (
    <div className="row">
      <span className="name">{name}</span>
      <span className="badge">
        {/* Status is carried by text as well as colour — Section 24.3 requires
            non-colour status indicators for accessibility. */}
        <span className={`dot ${tone}`} aria-hidden="true" />
        <span>{status}</span>
        {result ? <span className="latency">{result.latencyMs}ms</span> : null}
      </span>
    </div>
  );
}

export default async function HomePage() {
  const health = await fetchHealth();

  return (
    <main>
      <h1>BusinessOS</h1>
      <p className="sub">Multi-tenant company operations platform — foundation</p>

      <div className="panel">
        <Row name="API" result={health ? { status: 'ok', latencyMs: 0 } : undefined} />
        <Row name="PostgreSQL (Neon)" result={health?.checks.database} />
        <Row name="Redis (Upstash)" result={health?.checks.cache} />
      </div>

      <p className="note">
        {health ? `Readiness: ${health.status}` : `API unreachable at ${API_URL}. Start it with `}
        {!health ? <code>pnpm --filter @businessos/api dev</code> : null}
      </p>
    </main>
  );
}
