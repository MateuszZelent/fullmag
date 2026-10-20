import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { readPiecewiseDrivePoints, piecewiseDrivePointErrors, type PiecewiseDrivePointDraft } from "./SolvedAntennaDriveEditorModel";

const PAGE_SIZE = 12;

export function AntennaPiecewisePointsEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  let points: PiecewiseDrivePointDraft[] = [], failure: string | null = null;
  try { points = readPiecewiseDrivePoints(value); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const prefix = useId(), inputs = useRef(new Map<number, HTMLInputElement>());
  const focusTarget = useRef<number | null>(null);
  // Keys identify mounted controls only; authored values remain in the parent draft.
  const [identity, setIdentity] = useState(() => ({ keys: points.map((_, index) => index), next: points.length }));
  const [page, setPage] = useState(0);
  let active = identity;
  if (identity.keys.length !== points.length) {
    const added = Math.max(0, points.length - identity.keys.length);
    active = { keys: [...identity.keys.slice(0, points.length), ...Array.from({ length: added }, (_, index) => identity.next + index)], next: identity.next + added };
    setIdentity(active);
  }
  const currentPage = Math.min(page, Math.max(0, Math.ceil(points.length / PAGE_SIZE) - 1));
  const first = currentPage * PAGE_SIZE, visible = points.slice(first, first + PAGE_SIZE);
  const errors = piecewiseDrivePointErrors(points);
  useLayoutEffect(() => {
    if (focusTarget.current === null) return;
    const input = inputs.current.get(focusTarget.current);
    if (input) { input.focus(); focusTarget.current = null; }
  }, [active, currentPage]);
  function update(index: number, column: 0 | 1, text: string) {
    onChange(JSON.stringify(points.map((point, row) => row === index ? point.map((cell, col) => col === column ? text : cell) : point)));
  }
  function remove(index: number) {
    if (points.length <= 2) return;
    focusTarget.current = active.keys[index + 1] ?? active.keys[index - 1];
    const nextIndex = Math.min(index, points.length - 2);
    setPage(Math.floor(nextIndex / PAGE_SIZE));
    setIdentity({ ...active, keys: active.keys.filter((_, row) => row !== index) });
    onChange(JSON.stringify(points.filter((_, row) => row !== index)));
  }
  return <section className="fm-antenna-points" aria-label="Piecewise waveform points" data-testid="antenna-piecewise-points">
    <p className="fm-inspector-hint">Time uses the selected waveform clock. The dimensionless multiplier scales the signed current. Values are interpolated linearly; the first and last values are held outside the knot interval.</p>
    {failure ? <FeedbackBanner kind="warning" message={failure} /> : <>
      <div className="fm-antenna-points__scroll">
        <table className="fm-antenna-points__table">
          <caption className="fm-visually-hidden">Authored piecewise waveform. At least two finite points with strictly increasing times.</caption>
          <thead><tr><th scope="col">Point</th><th scope="col">Time [s]</th><th scope="col">Multiplier [1]</th><th scope="col"><span className="fm-visually-hidden">Actions</span></th></tr></thead>
          <tbody>{visible.map((point, offset) => {
            const index = first + offset, rowKey = active.keys[index];
            return <tr key={rowKey} data-point-key={rowKey}>
              <th scope="row">{index + 1}</th>
              {([0, 1] as const).map(column => {
                const errorId = `${prefix}-${rowKey}-${column}-error`, error = errors[index][column];
                return <td key={column}>
                  <Input aria-label={`Point ${index + 1} ${column === 0 ? "time" : "multiplier"}`} aria-invalid={Boolean(error)} aria-describedby={errorId}
                    inputMode="decimal" value={point[column]} onChange={event => update(index, column, event.currentTarget.value)}
                    ref={column === 0 ? node => { if (node) inputs.current.set(rowKey, node); else inputs.current.delete(rowKey); } : undefined} />
                  <p className="fm-antenna-points__error" id={errorId}>{error ?? ""}</p>
                </td>;
              })}
              <td><Button type="button" size="sm" variant="ghost" aria-label={`Remove point ${index + 1}`} disabled={points.length <= 2} onClick={() => remove(index)}>Remove</Button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="fm-inspector-toolbar">
        <Button type="button" size="sm" onClick={() => {
          setIdentity({ keys: [...active.keys, active.next], next: active.next + 1 });
          setPage(Math.floor(points.length / PAGE_SIZE));
          onChange(JSON.stringify([...points, ["", "0"]]));
        }}>Add waveform point</Button>
        <span className="fm-antenna-points__count">{points.length ? first + 1 : 0}–{Math.min(first + PAGE_SIZE, points.length)} of {points.length} points</span>
        <Button type="button" size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous points</Button>
        <Button type="button" size="sm" variant="ghost" disabled={first + PAGE_SIZE >= points.length} onClick={() => setPage(currentPage + 1)}>Next points</Button>
      </div>
    </>}
  </section>;
}
