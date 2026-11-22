"use client";

import { Layers, Ruler } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import {
  SpecInspectorHost,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";

import { sizeFieldParamSummary } from "../../panels/mesh-details/meshDetailsSectionUtils";
import {
  sanitizeMeshDisplayText,
  ThinFilmDiagnosticsSpecView,
} from "../../panels/mesh-details/MeshQualityAndHistorySpecViews";
import { asRecord, asString } from "./meshShared";

export interface SizeFieldsDraft {
  sourceFilter: string;
}

export function MeshSizeFieldsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const sizeFieldsRes =
    geometryLifecycleResources.useMeshSharedDomainRealizedSizeFieldsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();

  const rawFields = useMemo(() => {
    const rec = asRecord(sizeFieldsRes.data);
    const nested = asRecord(rec?.realized_size_fields);
    const list = Array.isArray(nested?.fields)
      ? nested.fields
      : Array.isArray(rec?.fields)
        ? rec.fields
        : Array.isArray(rec?.size_fields)
          ? rec.size_fields
          : [];
    return list.map((item, index) => {
      const r = asRecord(item) ?? {};
      const params = r.params;
      const summary = sizeFieldParamSummary(params);
      const source =
        asString(r.source) ??
        asString(r.owner_object_id) ??
        asString(r.owner) ??
        "shared-domain";
      const objectMatch = source.match(/^(?:object|object_mesh):(.+)$/);
      return {
        id: asString(r.id) ?? `${asString(r.kind) ?? "field"}-${source}-${index}`,
        kind: asString(r.kind) ?? "SizeField",
        objectId: objectMatch?.[1] ?? asString(r.owner_object_id) ?? null,
        paramSummary: summary ?? sanitizeMeshDisplayText(r.reason ?? source, "applied"),
        source,
        status: sanitizeMeshDisplayText(r.status, "applied"),
      };
    });
  }, [sizeFieldsRes.data]);

  const thinFilmDiagnostics = useMemo(
    () =>
      activeBuild.data?.shared_domain_build_report?.thin_film_diagnostics ?? [],
    [activeBuild.data],
  );

  const sourceOptions = useMemo(() => {
    const sources = Array.from(new Set(rawFields.map((f) => f.source)));
    return [
      { label: "All sources", value: "all" },
      ...sources.map((src) => ({ label: src, value: src })),
    ];
  }, [rawFields]);

  const baseline = useMemo<SizeFieldsDraft>(() => ({ sourceFilter: "all" }), []);

  const spec = useMemo<InspectorSpec<SizeFieldsDraft>>(
    () => ({
      id: "mesh.size-fields",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "size-fields", label: "Size Fields" },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:size-fields",
        icon: Ruler,
        kindLabel: "Realized Gmsh size fields & thin-film diagnostics",
        statePill: () =>
          rawFields.length > 0
            ? { label: `${rawFields.length} active`, tone: "ok" }
            : { label: "No fields realized", tone: "neutral" },
        title: () => "Realized Size Fields",
      },
      facts: () => [
        { id: "count", label: "Realized fields", value: String(rawFields.length) },
        {
          id: "sources",
          label: "Distinct sources",
          value: String(Math.max(0, sourceOptions.length - 1)),
        },
        {
          id: "thin-film",
          label: "Thin-film checks",
          value: String(thinFilmDiagnostics.length),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          emptyState: () =>
            rawFields.length === 0
              ? {
                  description:
                    "Build the shared-domain FEM mesh to materialize distance, curvature, and object size fields.",
                  icon: Ruler,
                  title: "No realized size fields yet",
                }
              : null,
          icon: Ruler,
          id: "fields-table",
          rows: [
            {
              key: "sourceFilter",
              label: "Filter by source",
              options: sourceOptions,
              showWhen: () => rawFields.length > 0,
              type: "select",
            },
            {
              columns: [
                {
                  header: "Kind & source",
                  id: "kind",
                  renderCell: (row) => {
                    const r = row as (typeof rawFields)[number];
                    return `${r.kind} · ${r.source}`;
                  },
                },
                {
                  header: "Status",
                  id: "status",
                  renderCell: (row) => (row as (typeof rawFields)[number]).status,
                },
                {
                  align: "right",
                  header: "Parameters",
                  id: "params",
                  mono: true,
                  renderCell: (row) => (row as (typeof rawFields)[number]).paramSummary,
                },
              ],
              label: "Realized size fields",
              onSelectRow: (row, ctx) => {
                const r = row as (typeof rawFields)[number];
                if (r.objectId) {
                  ctx.selectNode({
                    kind: "object.mesh",
                    label: "Mesh",
                    nodeId: `model:object:${r.objectId}:mesh`,
                    objectId: r.objectId,
                    ref: null,
                  });
                }
              },
              rowKey: (row) => (row as (typeof rawFields)[number]).id,
              rows: (d) =>
                d.sourceFilter === "all"
                  ? rawFields
                  : rawFields.filter((f) => f.source === d.sourceFilter),
              showWhen: () => rawFields.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Realized size fields",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "thin-film-diagnostics",
          rows: [
            {
              render: () => (
                <ThinFilmDiagnosticsSpecView diagnostics={thinFilmDiagnostics} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Thin-film diagnostics",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Click an object-scoped row to edit its source mesh policy",
      },
    }),
    [rawFields, sourceOptions, thinFilmDiagnostics],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
