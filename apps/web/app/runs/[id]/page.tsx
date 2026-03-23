type RunDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Run {id}</h1>
        <p className="page-subtitle">
          Bootstrap control-room view for one Fullmag session-backed run
        </p>
      </div>

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Runtime Contract</h2>
            <p className="card-subtitle">
              This page is the first stable target for the session/run control room
            </p>
          </div>
          <span className="badge badge-info">
            <span className="badge-dot" />
            Session-based
          </span>
        </div>
        <div className="card-body">
          <p style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
            The browser should consume session and run metadata from the Rust control plane.
            It does not parse Python and it does not infer physics locally.
          </p>
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--sp-4)',
          marginTop: 'var(--sp-6)',
        }}
      >
        <RunPanel title="Planner">
          backend / mode / precision badges
        </RunPanel>
        <RunPanel title="Scalars">
          E_ex(t), solver_dt, and later live progress
        </RunPanel>
        <RunPanel title="Fields">
          Latest m / H_ex snapshot viewer
        </RunPanel>
        <RunPanel title="Artifacts">
          metadata.json, scalars.csv, field snapshots, later zarr/h5
        </RunPanel>
      </section>
    </>
  );
}

function RunPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
      </div>
      <div className="card-body" style={{ color: 'var(--text-muted)' }}>
        {children}
      </div>
    </div>
  );
}
