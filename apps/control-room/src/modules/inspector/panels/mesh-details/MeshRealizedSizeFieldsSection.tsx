import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  asRecord,
  formatLength,
  formatValue,
  MeshResourceEmpty,
  recordField,
} from "../MeshResourceView";
import { meshDetailKey, sizeFieldParamSummary } from "./meshDetailsSectionUtils";

export function MeshRealizedSizeFieldsSection({
  sizeFields,
}: {
  sizeFields: readonly unknown[];
}) {
  return (
    <InspectorGroup title="Realized Size Fields" badge={`${sizeFields.length}`} collapsible defaultOpen>
      {sizeFields.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {sizeFields.map((field, index) => {
            const record = asRecord(field);
            const kind = recordField(record, "kind");
            const reason = recordField(record, "reason");
            const source = recordField(record, "source");
            const status = recordField(record, "status");
            const paramSummary = sizeFieldParamSummary(
              recordField(record, "params"),
            );
            return (
              <div
                key={meshDetailKey("size-field", [kind, source, index])}
                className="fm-mesh-detail-list__item"
                data-status={formatValue(status)}
              >
                <strong>{formatValue(kind)}</strong>
                <span>{formatValue(status)}</span>
                <small>
                  {paramSummary ?? formatValue(reason ?? source ?? "applied")}
                </small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No realized size fields are available for the current build." />
      )}
    </InspectorGroup>
  );
}

export function OperationStatusesSection({
  operationStatuses,
}: {
  operationStatuses: readonly unknown[];
}) {
  return (
    <InspectorGroup title="Operation Statuses" badge={`${operationStatuses.length}`} collapsible defaultOpen={false}>
      {operationStatuses.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {operationStatuses.map((statusEntry, index) => {
            const record = asRecord(statusEntry);
            const kind = recordField(record, "kind");
            const reason = recordField(record, "reason");
            const scope = recordField(record, "scope");
            const status = recordField(record, "status");
            return (
              <div
                key={meshDetailKey("operation-status", [kind, scope, index])}
                className="fm-mesh-detail-list__item"
                data-status={formatValue(status)}
              >
                <strong>{formatValue(kind)}</strong>
                <span>{formatValue(status)}</span>
                <small>{formatValue(reason ?? scope)}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No operation statuses are present in the active build report." />
      )}
    </InspectorGroup>
  );
}

export function ThinFilmDiagnosticsSection({
  thinFilmDiagnostics,
}: {
  thinFilmDiagnostics: readonly unknown[];
}) {
  return (
    <InspectorGroup title="Thin-Film Diagnostics" badge={`${thinFilmDiagnostics.length}`} collapsible defaultOpen={false}>
      {thinFilmDiagnostics.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {thinFilmDiagnostics.map((diagnosticEntry) => {
            const record = asRecord(diagnosticEntry);
            const actualMethod = recordField(record, "actual_method");
            const geometryName = recordField(record, "geometry_name");
            const lateralSize = recordField(record, "lateral_size");
            const requestedMethod = recordField(record, "requested_method");
            const thickness = recordField(record, "thickness");
            const warnings = recordField(record, "warnings");
            return (
              <div
                key={meshDetailKey("thin-film-diagnostic", [
                  geometryName,
                  actualMethod,
                  requestedMethod,
                  thickness,
                  lateralSize,
                ])}
                className="fm-mesh-detail-list__item"
                data-status={Array.isArray(warnings) && warnings.length ? "warning" : "ready"}
              >
                <strong>{formatValue(geometryName)}</strong>
                <span>{formatValue(actualMethod ?? requestedMethod ?? "auto")}</span>
                <small>
                  thickness {formatLength(thickness)} / lateral {formatLength(lateralSize)}
                </small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No thin-film diagnostics are present in the active build report." />
      )}
    </InspectorGroup>
  );
}
