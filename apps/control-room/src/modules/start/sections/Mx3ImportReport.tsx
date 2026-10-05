import { Copy, Download } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { importSaveState, type ScriptSaver } from "../model/scriptOpen";
import type { Mx3Translation } from "../model/mx3Import";
import { buildMx3ProjectSource, type ProjectCreator } from "../model/scriptProject";
import { CreateProjectAction } from "../ui/CreateProjectAction";

export interface Mx3ImportReportProps {
  readonly fileName: string;
  readonly translation: Mx3Translation;
  readonly saver: ScriptSaver | null;
  readonly busy: boolean;
  /** Opens the native Save dialog for the translated script. */
  readonly onCreate: () => void;
  readonly onSave: () => void;
  readonly onCopy: () => void;
  readonly onDiscard: () => void;
  /** Creates a project from the translated script after consent; null without a project document service. */
  readonly projectCreator?: ProjectCreator | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the importer mapped and what it did not, shown before anything is
 * written. Nothing here is a success claim: every untranslated statement is
 * listed with its line and reason.
 */
export function Mx3ImportReport({
  fileName,
  translation,
  saver,
  busy,
  onCreate,
  onSave,
  onCopy,
  onDiscard,
  projectCreator = null,
}: Mx3ImportReportProps) {
  const { supported, unsupported } = translation;
  const save = importSaveState(saver);
  return (
    <section aria-label="Import report" className="fm-start-report">
      <h2 className="fm-start-report__title">Import report: {fileName}</h2>
      <p className="fm-start-inspector__note">
        {plural(supported.length, "statement")} translated, {plural(unsupported.length, "statement")} not
        translated. Nothing is written until you confirm.
      </p>

      {unsupported.length > 0 ? (
        <>
          <p className="fm-start-notice fm-start-notice--warning" role="alert">
            The statements below are not in the translated script, so the Fullmag model differs from
            the mumax3 original. The same list is written at the top of the script.
          </p>
          <table className="fm-start-formats fm-start-report__unsupported">
            <caption className="fm-start-visually-hidden">Statements that were not translated</caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Statement</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {unsupported.map((item, index) => (
                <tr key={`${item.line}-${index}`}>
                  <th scope="row">{item.line > 0 ? item.line : "n/a"}</th>
                  <td className="fm-start-formats__ext">{item.text}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="fm-start-inspector__note">Every statement in the source was translated.</p>
      )}

      {!translation.runnable ? (
        <p className="fm-start-notice fm-start-notice--warning" role="alert">
          The script is incomplete and stops when run: {translation.blockers.join("; ")}. You can still save it and finish it by hand.
        </p>
      ) : null}

      {supported.length > 0 ? (
        <details className="fm-start-report__translated">
          <summary>Translated statements ({supported.length})</summary>
          <ul className="fm-start-report__list">
            {supported.map((entry) => (
              <li className="fm-start-formats__ext" key={entry}>
                {entry}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="fm-start-report__actions">
        <Button
          disabled={!save.available || busy}
          onClick={onCreate}
          title={save.reason ?? undefined}
          type="button"
          variant="primary"
        >
          {busy ? "Waiting for the Save dialog…" : "Save translated script…"}
        </Button>
        <Button onClick={onSave} type="button" variant="secondary">
          <Download aria-hidden="true" size={12} /> Download script
        </Button>
        <Button onClick={onCopy} type="button" variant="secondary">
          <Copy aria-hidden="true" size={12} /> Copy script
        </Button>
        <CreateProjectAction
          creator={projectCreator}
          disabled={busy}
          source={buildMx3ProjectSource(fileName, translation)}
          variant="secondary"
        />
        <Button disabled={busy} onClick={onDiscard} type="button" variant="ghost">
          Discard
        </Button>
      </div>
      {save.reason ? <p className="fm-start-inspector__note">{save.reason}</p> : null}
      <p className="fm-start-inspector__note">
        Save translated script asks where to save the .py file, lists it under Recent scripts and
        selects it. Nothing runs until you choose Run in new window. Create project runs the
        translated script once, after you confirm, to read its model into a project that keeps the
        script.
      </p>
    </section>
  );
}
