"use client";

import { useState } from "react";

import type { StudyStageResult } from "@/kernel/api/apiTypes";
import {
  studyResultCompletionLabel, studyResultDomainLabel, studyResultInitialStateLabel, studyResultPredecessorLabel,
} from "@/kernel/api/studyResultPlayback";
import { useStudyStageResultsResource } from "@/kernel/resources/studyStageResultsResource";
import {
  stageInitialStateRequest,
  type PreparedStageInitialState,
  type StageInitialStateChoice,
} from "@/kernel/runtime/studyStageInitialState";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";

type ResultChoice = Extract<StageInitialStateChoice, { kind: "stage_result" }>;

export function stageResultInitialState(result: StudyStageResult): ResultChoice | null {
  if (!result.supports_magnetization_input) return null;
  const request = stageInitialStateRequest({
    kind: "stage_result",
    run_id: result.source.run_id,
    step_id: result.source.step_id,
    case_id: result.source.case_id,
    artifact_id: result.artifact_id,
    content_sha256: result.artifact_sha256,
    allow_stale_model: false,
  }, result.source.step_id, 0);
  return request?.kind === "stage_result" ? request : null;
}

function choiceKey(choice: StageInitialStateChoice): string {
  if (choice.kind === "prepared") {
    return JSON.stringify([choice.kind, choice.scene_revision, choice.initial_state_revision, choice.publication_id]);
  }
  if (choice.kind !== "stage_result") return choice.kind;
  return JSON.stringify([choice.run_id, choice.step_id, choice.case_id, choice.artifact_id, choice.content_sha256]);
}

function describeRelation(relation: StudyStageResult["authored_relation"]): string {
  switch (relation) {
    case "matching_authored_input": return "matches the current authored stage recipe";
    case "authored_input_changed": return "authored inputs for this stage changed";
    case "stage_absent": return "stage is absent from the current Study";
    case "authoring_unavailable": return "authoring comparison unavailable";
  }
}

function resultTitle(result: StudyStageResult): string {
  return `${result.authored_stage_id ?? result.source.step_id} · ${result.source.run_id} · ${result.accepted_at}`;
}

export function StageInitialStateSelector({
  stageId, sceneRevision, choice, preparedSource, stale, hasAuthoredReset, disabled, onChange, onPreviewResult,
}: {
  stageId: string;
  sceneRevision: number | null;
  choice: StageInitialStateChoice;
  preparedSource: PreparedStageInitialState | null;
  stale: boolean;
  hasAuthoredReset: boolean;
  disabled: boolean;
  onChange: (choice: StageInitialStateChoice) => void;
  onPreviewResult?: (result: StudyStageResult) => void;
}) {
  const [page, setPage] = useState<{ revision: number | null; cursors: string[] }>({
    revision: sceneRevision, cursors: [],
  });
  const cursors = page.revision === sceneRevision ? page.cursors : [];
  const catalog = useStudyStageResultsResource({
    limit: 25, cursor: cursors.at(-1), sceneRevision, enabled: sceneRevision !== null,
  });
  const last = useStudyStageResultsResource({ stageId, limit: 1, sceneRevision, enabled: sceneRevision !== null });
  const catalogData = catalog.data?.scene_revision === sceneRevision ? catalog.data : null;
  const lastResult = last.data?.scene_revision === sceneRevision ? last.data.results[0] : undefined;
  const completion = lastResult?.completion;
  const metricUnit = completion?.metric_unit === "1" ? "" : completion?.metric_unit;

  const choices: { choice: StageInitialStateChoice; label: string }[] = [
    { choice: { kind: "default_for_target" }, label: "From the configured Study flow" },
    { choice: { kind: "authored_study" }, label: "Study initial texture (m₀)" },
    { choice: { kind: "latest_compatible_state" }, label: "Latest compatible state at start" },
  ];
  if (hasAuthoredReset) {
    choices.push({ choice: { kind: "authored_stage" }, label: "Start all objects from this stage's authored state" });
  }
  if (preparedSource) {
    choices.push({ choice: preparedSource, label: "Prepared magnetization from the live preview" });
  }
  const selected = choiceKey(choice);
  let selectedResult: StudyStageResult | undefined;
  for (const result of catalogData?.results ?? []) {
    const source = stageResultInitialState(result);
    if (source) {
      if (choiceKey(source) === selected) selectedResult = result;
      const relation = result.authored_relation === "matching_authored_input"
        ? ""
        : ` · ${describeRelation(result.authored_relation)}`;
      choices.push({ choice: source, label: `${resultTitle(result)}${relation}` });
    }
  }

  const selectedPredecessor = selectedResult ? studyResultPredecessorLabel(selectedResult) : null;
  const savedPredecessor = lastResult ? studyResultPredecessorLabel(lastResult) : null;
  const missing = !choices.some((option) => choiceKey(option.choice) === selected);
  const pinnedLabel = choice.kind === "stage_result"
    ? `${choice.step_id} · ${choice.run_id} · pinned result`
    : choice.kind === "prepared" ? "Previously selected preview" : "Previously selected source";
  return (
    <>
      <FormField
        type="select"
        label="Initial magnetization"
        value={stale ? "stale" : selected}
        disabled={disabled || sceneRevision === null}
        error={stale ? "The saved scene or preview changed. Choose a source again before starting." : undefined}
        hint={hasAuthoredReset
          ? "The configured flow applies the authored texture change at this stage."
          : "The configured flow uses the required predecessor where applicable."}
        onChange={(event) => {
          const selected = choices.find((option) => choiceKey(option.choice) === event.target.value);
          if (selected) onChange(selected.choice);
        }}
      >
        {stale ? <option value="stale" disabled>{pinnedLabel} · review source</option> : null}
        {missing && !stale ? <option value={selected}>{pinnedLabel}</option> : null}
        {choices.map((option) => (
          <option key={choiceKey(option.choice)} value={choiceKey(option.choice)}>{option.label}</option>
        ))}
      </FormField>
      {choice.kind === "stage_result" ? (
        <>
          <FieldRow label="Pinned initial state" value={`${choice.step_id} · ${choice.run_id} · ${choice.artifact_id}`} />
          {selectedResult ? (
            <FieldRow
              label="Pinned source comparison"
              value={`${describeRelation(selectedResult.authored_relation)} · ${studyResultDomainLabel(selectedResult.domain_relation)}`}
            />
          ) : null}
          {selectedPredecessor ? <FieldRow label="Pinned predecessor" value={selectedPredecessor} /> : null}
          <FormField
            type="checkbox"
            label="Use as a saved seed"
            checked={choice.allow_stale_model === true}
            disabled={disabled || stale || sceneRevision === null}
            hint="Allows this exact saved state after the model or predecessor changes. Compute still checks its identity and the target layout."
            onChange={(event) => onChange({ ...choice, allow_stale_model: event.currentTarget.checked })}
          />
        </>
      ) : null}
      {catalog.status === "error" ? (
        <div className="fm-inspector-toolbar">
          <span role="status">Result history is unavailable.</span>
          <Button size="sm" type="button" onClick={catalog.refetch}>Retry history</Button>
        </div>
      ) : catalog.status === "loading" && !catalogData ? (
        <p role="status">Loading saved results…</p>
      ) : null}
      {cursors.length > 0 || catalogData?.next_cursor ? (
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            disabled={disabled || cursors.length === 0}
            onClick={() => setPage({ revision: sceneRevision, cursors: cursors.slice(0, -1) })}
          >Newer results</Button>
          <Button
            size="sm"
            type="button"
            disabled={disabled || !catalogData?.next_cursor}
            onClick={() => {
              if (catalogData?.next_cursor) {
                setPage({ revision: sceneRevision, cursors: [...cursors, catalogData.next_cursor] });
              }
            }}
          >Older results</Button>
        </div>
      ) : null}
      <FieldRow label="Last saved result" value={lastResult
        ? resultTitle(lastResult)
        : last.status === "loading" ? "Loading…" : last.status === "error" ? "Unavailable" : "No saved result"} />
      {lastResult ? (
        <>
          <FieldRow label="Authored stage recipe" value={describeRelation(lastResult.authored_relation)} />
          <FieldRow label="Magnetization layout" value={studyResultDomainLabel(lastResult.domain_relation)} />
          <FieldRow label="Saved initial magnetization" value={studyResultInitialStateLabel(lastResult.initial_state)} />
          {savedPredecessor ? <FieldRow label="Saved predecessor" value={savedPredecessor} /> : null}
          {lastResult.initial_state?.reset_scopes.length ? (
            <FieldRow label="Saved reset scopes" value={lastResult.initial_state.reset_scopes.map(({ object_id, region_id }) =>
              region_id ? `${object_id} / ${region_id}` : object_id,
            ).join(", ")} />
          ) : null}
          <FieldRow label="Saved completion" value={studyResultCompletionLabel(completion)} />
          {completion?.metric_value !== undefined && metricUnit !== undefined ? (
            <FieldRow label="Saved stop metric" value={`${completion.metric_value} ${metricUnit}`.trimEnd()} />
          ) : null}
          {completion?.threshold !== undefined && metricUnit !== undefined ? (
            <FieldRow label="Saved threshold" value={`${completion.threshold} ${metricUnit}`.trimEnd()} />
          ) : null}
        </>
      ) : null}
      {onPreviewResult && lastResult?.supports_magnetization_input ? (
        <Button size="sm" variant="secondary" type="button" onClick={() => onPreviewResult(lastResult)}>
          Preview last saved result
        </Button>
      ) : null}
    </>
  );
}
