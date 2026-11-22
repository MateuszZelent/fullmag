"use client";

import { BookOpen, Copy, Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";

import { copyScript, saveScriptFile } from "../model/scriptExport";
import {
  createScriptFromTemplate,
  templateCreateState,
  type ScriptSaver,
} from "../model/scriptOpen";
import { buildTemplateProjectSource, type ProjectCreator } from "../model/scriptProject";
import { startScreenStore } from "../model/startScreenState";
import { estimateFor, templateScript, templateScriptFileName, type StudyTemplate } from "../model/templates";
import type { ComputeProbeState } from "../model/types";
import { CreateProjectAction } from "../ui/CreateProjectAction";
import { SolverBadge } from "../ui/SolverBadge";
import { StartInspectorTemplateFrame } from "./StartScreenInspectorSpecs";

export function TemplateDetails({
  template,
  compute,
  scriptSaver = null,
  projectCreator = null,
}: {
  readonly template: StudyTemplate;
  readonly compute: ComputeProbeState;
  /** Saves the template script as a new file; null where there is no desktop host. */
  readonly scriptSaver?: ScriptSaver | null;
  /** Creates a project from the template script after consent; null without a project document service. */
  readonly projectCreator?: ProjectCreator | null;
}) {
  const estimate = estimateFor(template, compute);
  const create = templateCreateState(template, scriptSaver);
  const script = templateScript(template);
  const fileName = templateScriptFileName(template);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const createScript = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await createScriptFromTemplate(template, scriptSaver));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (script === null) return;
    setMessage(saveScriptFile(fileName, script) ? null : "Saving a file is not available here.");
  };
  const copy = async () => {
    if (script === null) return;
    setMessage((await copyScript(script)) ? null : "The clipboard is not available here.");
  };

  return (
    <StartInspectorTemplateFrame
      ariaLabel="Template details"
      breadcrumbs={["Start", "Templates", template.name]}
      customIdentity={
        <div className="fm-start-inspector__head">
          <h2 className="fm-start-inspector__name">{template.name}</h2>
          <div className="fm-start-chips">
            <SolverBadge solver={template.solver} />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="fm-start-chip">{estimate.text}</span>
              </TooltipTrigger>
              <TooltipContent>{estimate.note}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      }
      footer={
        <>
          <div className="fm-start-inspector__foot">
            <Button
              className="fm-start-inspector__open"
              disabled={!create.available || busy}
              onClick={() => void createScript()}
              type="button"
              variant="primary"
            >
              {busy ? "Waiting for the Save dialog…" : "Create script from template…"}
            </Button>
          </div>
          {create.reason ? (
            <p className="fm-start-inspector__note fm-start-inspector__footnote">{create.reason}</p>
          ) : null}
        </>
      }
      specId="start.template"
      title={template.name}
      typeLabel="Study template"
    >
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
          <Button
            className="fm-start-link fm-start-template__docs"
            onClick={() => startScreenStore.requestDocs(template.docsPage)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <BookOpen aria-hidden="true" size={12} /> Read the documentation
          </Button>
        </section>
        {script !== null ? (
          <section className="fm-start-kv">
            <h3 className="fm-start-kv__title">Python script</h3>
            <p className="fm-start-inspector__note">
              Canonical Fullmag Python, SI units. Create script asks where to save a copy, adds it to
              Recent scripts and selects it; nothing runs until you choose Run in new window. Or run
              it yourself with <code>{`fullmag ${fileName}`}</code>.
            </p>
            <p className="fm-start-inspector__note">
              Create project runs the script once, after you confirm, to read its model into a
              project that keeps the original script. It also works in the browser.
            </p>
            <div className="fm-start-report__actions">
              <Button onClick={save} size="sm" type="button" variant="secondary">
                <Download aria-hidden="true" size={12} /> {`Download ${fileName}`}
              </Button>
              <Button onClick={() => void copy()} size="sm" type="button" variant="secondary">
                <Copy aria-hidden="true" size={12} /> Copy script
              </Button>
              <CreateProjectAction
                creator={projectCreator}
                size="sm"
                source={buildTemplateProjectSource(template)}
                variant="secondary"
              />
            </div>
          </section>
        ) : null}
        <p className="fm-start-inspector__note">{estimate.note}</p>
        <div aria-live="polite" role="status">
          {message ? <p className="fm-start-notice fm-start-notice--warning">{message}</p> : null}
        </div>
      </div>
    </StartInspectorTemplateFrame>
  );
}
