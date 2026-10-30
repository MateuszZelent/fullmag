import { resolveFieldMapAuxiliaryDiagnostics } from "../model/fieldMapRenderModel";

export function FieldMapAuxiliaryDiagnostics({
  layers,
}: {
  layers: readonly {
    label: string;
    requested: boolean;
    resource: { data: ArrayBuffer | null; error: Error | null; status: "error" | "idle" | "loading" | "ready" | "stale" };
  }[];
}) {
  const diagnostics = resolveFieldMapAuxiliaryDiagnostics(
    layers.map(({ label, requested, resource }) => ({
      errorMessage: resource.error?.message ?? null,
      hasData: resource.data !== null,
      label,
      requested,
      status: resource.status,
    })),
  );
  if (diagnostics.length === 0) return null;
  return (
    <div className="fm-field-map__diagnostics" role="status" aria-label="Planar layer diagnostics">
      {diagnostics.map((message) => <p key={message}>{message}</p>)}
    </div>
  );
}
