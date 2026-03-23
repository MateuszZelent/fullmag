export default function DashboardPage() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          Session-backed execution overview and recent activity
        </p>
      </div>

      <div className="metric-grid">
        <MetricCard label="Active Runs" value="0" />
        <MetricCard label="Completed" value="0" accent="success" />
        <MetricCard label="Failed" value="0" accent="error" />
        <MetricCard label="GPU Status" value="—" accent="info" />
      </div>

      <section style={{ marginTop: 'var(--sp-8)' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Recent Runs</h2>
              <p className="card-subtitle">Last simulation executions</p>
            </div>
            <span className="badge badge-info">
              <span className="badge-dot" />
              Phase 1
            </span>
          </div>
          <div className="card-body">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 'var(--sp-12) var(--sp-6)',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-base)',
                textAlign: 'center',
                gap: 'var(--sp-3)',
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>
                No session-backed runs yet. Execute a simulation through the Rust host to see results here.
              </span>
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                  background: 'var(--bg-raised)',
                  padding: 'var(--sp-2) var(--sp-4)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--accent)',
                }}
              >
                fullmag examples/exchange_relax.py --until 2e-9
              </code>
            </div>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 'var(--sp-6)' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Platform Status</h2>
              <p className="card-subtitle">Current capabilities and backend readiness</p>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
              <span className="badge badge-success">
                <span className="badge-dot" />
                Exchange
              </span>
              <span className="badge badge-success">
                <span className="badge-dot" />
                LLG (Heun)
              </span>
              <span className="badge badge-success">
                <span className="badge-dot" />
                FDM / strict
              </span>
              <span className="badge badge-success">
                <span className="badge-dot" />
                Box geometry
              </span>
              <span className="badge badge-accent">
                <span className="badge-dot" />
                CPU reference
              </span>
              <span className="badge badge-success">
                <span className="badge-dot" />
                Rust host + Python helper
              </span>
              <span className="badge badge-success">
                <span className="badge-dot" />
                Session manifests
              </span>
              <span className="badge badge-warning">
                <span className="badge-dot" />
                CUDA FDM calibration
              </span>
              <span className="badge badge-info">
                <span className="badge-dot" />
                FEM (Phase 3)
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function MetricCard({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: 'success' | 'error' | 'warning' | 'info';
}) {
  const accentColor = accent
    ? `var(--${accent})`
    : 'var(--text-primary)';

  return (
    <div className="card metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color: accentColor }}>
        {value}
        {unit && <span className="metric-unit"> {unit}</span>}
      </div>
    </div>
  );
}
