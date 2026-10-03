interface KeyGroup {
  readonly title: string;
  readonly rows: readonly { readonly action: string; readonly keys: string }[];
}

/** The map the interaction spec documents; every action is also in the palette. */
const KEY_GROUPS: readonly KeyGroup[] = [
  {
    title: "Anywhere on the start screen",
    rows: [
      { action: "Command search", keys: "Ctrl ⇧ P" },
      { action: "New FDM simulation", keys: "Ctrl N" },
      { action: "New FEM simulation", keys: "Ctrl ⇧ N" },
      { action: "Open project…", keys: "Ctrl O" },
      { action: "Browse templates", keys: "Ctrl T" },
      { action: "Import model", keys: "Ctrl I" },
      { action: "Settings", keys: "Ctrl ," },
      { action: "Sections Home, Templates, Import, Learn", keys: "Ctrl 1 … Ctrl 4" },
    ],
  },
  {
    title: "Recent projects list",
    rows: [
      { action: "Focus the filter", keys: "/" },
      { action: "Move selection", keys: "↑ ↓ (grid: ← → too)" },
      { action: "Jump a group", keys: "PgUp PgDn" },
      { action: "First / last", keys: "Home End" },
      { action: "Open", keys: "Enter" },
      { action: "Pin / unpin", keys: "Ctrl P" },
      { action: "Remove from recent", keys: "Del" },
    ],
  },
  {
    title: "Inspector",
    rows: [{ action: "Move between tabs", keys: "← →" }],
  },
];

export function LearnSection() {
  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Learn</h1>
          <p>The things you look up rather than memorise.</p>
        </div>
      </div>

      <section aria-labelledby="fm-start-keys-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-keys-title">
          Keyboard map
        </h2>
        {KEY_GROUPS.map((group) => (
          <div className="fm-start-keys" key={group.title}>
            <h3 className="fm-start-kv__title">{group.title}</h3>
            <dl className="fm-start-kv__grid">
              {group.rows.map((row) => (
                <div className="fm-start-kv__row" key={row.action}>
                  <dt>{row.action}</dt>
                  <dd>{row.keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <p className="fm-start-notice">
        Release notes are not bundled with this build yet. Every start-screen action is also
        listed in the command palette.
      </p>
    </>
  );
}
