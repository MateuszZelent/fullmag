"use client";

import { useSyncExternalStore, type KeyboardEvent } from "react";

import { cn } from "@/shared/utils/className";

import { startScreenStore } from "../model/startScreenState";
import { STUDY_TEMPLATES, estimateFor } from "../model/templates";
import type { ComputeProbeState } from "../model/types";
import { ProjectThumb } from "../ui/ProjectThumb";
import { SolverBadge } from "../ui/SolverBadge";

export function TemplatesSection({ compute }: { readonly compute: ComputeProbeState }) {
  const { selectedTemplateId } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const columns = Math.max(
      1,
      getComputedStyle(event.currentTarget.parentElement as Element).gridTemplateColumns
        .split(" ")
        .filter(Boolean).length,
    );
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "ArrowDown"
            ? index + columns
            : event.key === "ArrowUp"
              ? index - columns
              : null;
    if (next === null) return;
    const target = STUDY_TEMPLATES[next];
    if (!target) return;
    event.preventDefault();
    startScreenStore.setSelectedTemplate(target.id);
    document.getElementById(`fm-start-template-${target.id}`)?.focus();
  };

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Templates</h1>
          <p>
            Ready-made studies. Each one opens as a new project with geometry, materials and a
            configured solver.
          </p>
        </div>
      </div>
      <div aria-label="Study templates" className="fm-start-templates" role="listbox">
        {STUDY_TEMPLATES.map((template, index) => {
          const estimate = estimateFor(template, compute);
          const selected = template.id === selectedTemplateId;
          return (
            <div
              aria-selected={selected}
              className={cn("fm-start-card", selected && "fm-start-card--selected")}
              id={`fm-start-template-${template.id}`}
              key={template.id}
              onClick={() => startScreenStore.setSelectedTemplate(template.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              role="option"
              // A roving tab stop: one card is reachable, the arrows move between them.
              tabIndex={selected || (selectedTemplateId === null && index === 0) ? 0 : -1}
            >
              <span className="fm-start-card__media">
                <ProjectThumb size="card" status="ready" />
              </span>
              <span className="fm-start-card__name">
                <span className="fm-start-card__name-text">{template.name}</span>
              </span>
              <span className="fm-start-template__desc">{template.description}</span>
              <span className="fm-start-card__foot">
                <SolverBadge solver={template.solver} />
                <span className="fm-start-card__date" title={estimate.note}>
                  {estimate.text}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
