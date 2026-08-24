import { apiFetch } from '../../../lib/api';
import { requireSession } from '../../../lib/session';
import { AttendanceClock, type AttendanceToday } from '../../../components/AttendanceClock';

export const metadata = { title: 'Attendance — BusinessOS' };

/**
 * Attendance.
 *
 * Every figure here is the output of interval arithmetic in
 * `@businessos/domain`: sessions merged, breaks clamped inside them and
 * subtracted, then compared against the expected day.
 */
export default async function AttendancePage() {
  const session = await requireSession();
  const today = await apiFetch<AttendanceToday>('/v1/attendance/today');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            {today.workDate ? `Working day ${today.workDate}` : 'Today'} · {session.user.name}
          </p>
        </div>
      </div>

      {today.summary ? (
        <div className="stat-grid">
          <Stat label="Worked" value={today.summary.net} meta="breaks removed" />
          <Stat label="Gross" value={today.summary.gross} meta="clock-in to clock-out" />
          <Stat label="Breaks" value={today.summary.breaks} meta="merged, not double-counted" />
          <Stat
            label={today.summary.overtime !== '0h 0m' ? 'Overtime' : 'Short by'}
            value={
              today.summary.overtime !== '0h 0m' ? today.summary.overtime : today.summary.shortfall
            }
            meta="against an 8h day"
          />
        </div>
      ) : null}

      <AttendanceClock today={today} />

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Sessions today</h2>
          <span className="badge">{today.sessions.length}</span>
        </div>
        {today.sessions.length === 0 ? (
          <div className="card-body">
            <div className="empty">
              <div className="empty-title">Nothing recorded yet</div>
              <p>Check in above to start the day.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>In</th>
                  <th>Out</th>
                  <th>Breaks</th>
                  <th>Source</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {today.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="nums">{s.checkInAt.slice(11, 16)}</td>
                    <td className="nums">
                      {s.checkOutAt ? (
                        s.checkOutAt.slice(11, 16)
                      ) : (
                        <span className="badge badge-warning">open</span>
                      )}
                    </td>
                    <td>
                      {s.breaks.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <span style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                          {s.breaks.map((b) => (
                            <span className="badge" key={b.id}>
                              {b.startAt.slice(11, 16)}–{b.endAt ? b.endAt.slice(11, 16) : '…'}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="muted">{s.source.toLowerCase()}</td>
                    <td className="muted">
                      {s.corrected ? (
                        <span
                          className="badge badge-warning"
                          title="Edited by HR — the before and after are in the audit log"
                        >
                          corrected
                        </span>
                      ) : null}
                      {s.notes ? ` ${s.notes}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
        Hours come from merging work intervals and subtracting breaks clamped inside them, so a
        duplicate punch cannot inflate the total — it is reported as an overlap to correct instead.
      </p>
    </div>
  );
}

function Stat({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value nums">{value}</div>
      <div className="stat-meta">{meta}</div>
    </div>
  );
}
