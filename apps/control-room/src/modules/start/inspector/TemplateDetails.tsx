import { BookOpen } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { startScreenStore } from "../model/startScreenState";
import { estimateFor, type StudyTemplate } from "../model/templates";
import type { ComputeProbeState } from "../model/types";
import { SolverBadge } from "../ui/SolverBadge";

/** Until the host can instantiate a template, opening is honest about it. */
const OPEN_UNAVAILABLE =
  "Template projects ship with the desktop host and are not available in this build yet.";

export function TemplateDetails({
  template,
  compute,
}: {
  readonly template: StudyTemplate;
  readonly compute: ComputeProbeState;
}) {
  const estimate = estimateFor(template, compute);
  return (
    <aside aria-label="Template details" className="fm-start__inspector fm-start-inspector">
      <header className="fm-start-inspector__head">
        <h2 className="fm-start-inspector__name">{template.name}</h2>
        <div className="fm-start-chips">
          <SolverBadge solver={template.solver} />
          <span className="fm-start-chip" title={estimate.note}>
            {estimate.text}
          </span>
        </div>
      </header>
      <div className="fm-start-inspector__body">
        <p className="fm-start-inspector__note">{template.description}</p>
        <section className="fm-start-kv">
          <h3 className="fm-start-kv__title">Model</h3>
          <dl className="fm-start-kv__grid">
            {template.model.map((row) => (
              <div className="fm-start-kv__row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="fm-start-kv">
          <h3 className="fm-start-kv__title">Reproduces</h3>
          <p className="fm-start-inspector__note">{template.reference}</p>
          <button
            className="fm-start-link fm-start-template__docs"
            onClick={() => startScreenStore.requestDocs(template.docsPage)}
            type="button"
          >
            <BookOpen aria-hidden="true" size={12} /> Read the documentation
          </button>
        </section>
        <p className="fm-start-inspector__note">{estimate.note}</p>
      </div>
      <footer className="fm-start-inspector__foot">
        <Button
          className="fm-start-inspector__open"
          disabled
          title={OPEN_UNAVAILABLE}
          type="button"
          variant="primary"
        >
          Create project from template
        </Button>
      </footer>
      <p className="fm-start-inspector__note fm-start-inspector__footnote">{OPEN_UNAVAILABLE}</p>
    </aside>
  );
}
