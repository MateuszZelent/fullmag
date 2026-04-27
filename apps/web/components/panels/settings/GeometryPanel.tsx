"use client";

import { startTransition, useCallback, useMemo, useState } from "react";

import { useModel } from "../../runs/control-room/ControlRoomContext";
import { extractGeometryBoundsFromParams, fmtSI } from "../../runs/control-room/shared";
import { useSceneAuthoringActions } from "@/src/hooks/resources/useSceneDocument";
import { TextField } from "../../ui/TextField";
import SelectField from "../../ui/SelectField";
import { Button } from "../../ui/button";
import type {
  MagnetizationAsset,
  SceneMaterialAsset,
  SceneObject,
  ScriptBuilderGeometryEntry,
} from "../../../lib/session/types";
import { ensureObjectPhysicsStack } from "../../../lib/session/magneticPhysics";
import {
  defaultSceneMagnetizationId,
  defaultSceneMaterialId,
  findSceneObjectByNodeId,
} from "./objectSelection";
import {
  defaultSceneMagnetizationAsset,
  defaultSceneMaterialAsset,
  makeUniqueSceneObjectName,
} from "@/lib/session/sceneObjectFactory";
import {
  SidebarSection,
  SubSectionHeader,
  PropertyRow,
  StatusBadge,
  InfoRow,
  ToggleRow,
  CompactInputGrid,
} from "./primitives";
import { GEOMETRY_PRESET_CATALOG, evaluateGeometryPreset, type GeometryPresetKind } from "../../../lib/geometryPresetCatalog";
import GeometryPresetLibraryPanel from "../GeometryPresetLibraryPanel";
import { PresetParameterField } from "../../ui/PresetParameterField";

function defaultGeometryParams(kind: string, name: string): Record<string, unknown> {
  switch (kind) {
    case "Cylinder":
      return { radius: 10e-9, height: 20e-9, name };
    case "Ellipsoid":
      return { rx: 10e-9, ry: 10e-9, rz: 20e-9, name };
    case "Ellipse":
      return { rx: 10e-9, ry: 10e-9, height: 5e-9, name };
    case "ImportedGeometry":
      return { source: "", scale: 1.0, volume: "full", name };
    case "Difference":
      return {
        base: {
          geometry_kind: "Box",
          geometry_params: { size: [20e-9, 20e-9, 10e-9], name: `${name}_base` },
        },
        tool: {
          geometry_kind: "Cylinder",
          geometry_params: { radius: 5e-9, height: 10e-9, name: `${name}_tool` },
        },
      };
    case "Union":
    case "Intersection":
      return {
        a: {
          geometry_kind: "Box",
          geometry_params: { size: [20e-9, 20e-9, 10e-9], name: `${name}_a` },
        },
        b: {
          geometry_kind: "Cylinder",
          geometry_params: { radius: 5e-9, height: 10e-9, name: `${name}_b` },
        },
      };
    case "Box":
    default:
      return { size: [20e-9, 20e-9, 10e-9], name };
  }
}

function readTranslation(object: SceneObject): [number, number, number] {
  const raw = object.transform.translation ?? [0, 0, 0];
  return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0];
}

function readRotationQuat(object: SceneObject): [number, number, number, number] {
  const raw = object.transform.rotation_quat ?? [0, 0, 0, 1];
  return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0, Number(raw[3]) || 1];
}

/** Convert quaternion [x, y, z, w] → Euler angles [rx, ry, rz] in degrees (XYZ intrinsic). */
function quatToEulerDeg(q: [number, number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  // Roll (X)
  const sinr_cosp = 2 * (w * x + y * z);
  const cosr_cosp = 1 - 2 * (x * x + y * y);
  const rx = Math.atan2(sinr_cosp, cosr_cosp);
  // Pitch (Y) — clamp to avoid NaN at poles
  const sinp = 2 * (w * y - z * x);
  const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  // Yaw (Z)
  const siny_cosp = 2 * (w * z + x * y);
  const cosy_cosp = 1 - 2 * (y * y + z * z);
  const rz = Math.atan2(siny_cosp, cosy_cosp);

  const toDeg = 180 / Math.PI;
  return [rx * toDeg, ry * toDeg, rz * toDeg];
}

/** Convert Euler angles [rx, ry, rz] in degrees → quaternion [x, y, z, w] (XYZ intrinsic). */
function eulerDegToQuat(euler: [number, number, number]): [number, number, number, number] {
  const toRad = Math.PI / 180;
  const [rx, ry, rz] = [euler[0] * toRad, euler[1] * toRad, euler[2] * toRad];
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function buildProjectedGeometryEntry(
  object: SceneObject,
  material?: SceneMaterialAsset,
  magnetization?: MagnetizationAsset,
): ScriptBuilderGeometryEntry {
  const geometryParams = { ...object.geometry.geometry_params };
  const translation = readTranslation(object);
  if (translation.some((component) => Math.abs(component) > Number.EPSILON)) {
    geometryParams.translation = [...translation];
  }
  return {
    name: object.name || object.id,
    region_name: object.region_name,
    geometry_kind: object.geometry.geometry_kind,
    geometry_params: geometryParams,
    bounds_min: object.geometry.bounds_min ?? null,
    bounds_max: object.geometry.bounds_max ?? null,
    material: material?.properties ?? {
      Ms: null,
      Aex: null,
      alpha: 0.01,
      Dind: null,
    },
    physics_stack: ensureObjectPhysicsStack(
      object.physics_stack,
      material?.properties?.Dind ?? null,
    ),
    magnetization: {
      kind: magnetization?.kind ?? "uniform",
      value: magnetization?.value ?? [0, 0, 1],
      seed: magnetization?.seed ?? null,
      source_path: magnetization?.source_path ?? null,
      source_format: magnetization?.source_format ?? null,
      dataset: magnetization?.dataset ?? null,
      sample_index: magnetization?.sample_index ?? null,
    },
    mesh: object.mesh_override,
  };
}

function cloneSceneObject(source: SceneObject, nextName: string): SceneObject {
  const nextRegionName =
    !source.region_name || source.region_name === source.name
      ? null
      : `${source.region_name}_${nextName}`;
  return {
    ...source,
    id: nextName,
    name: nextName,
    material_ref: defaultSceneMaterialId(nextName),
    magnetization_ref: defaultSceneMagnetizationId(nextName),
    region_name: nextRegionName,
    geometry: {
      ...source.geometry,
      geometry_params: {
        ...source.geometry.geometry_params,
        name: nextName,
      },
    },
  };
}

function formatBounds(
  min: [number, number, number] | null | undefined,
  max: [number, number, number] | null | undefined,
): string {
  if (!min || !max) return "—";
  return `x ${fmtSI(min[0], "m")} → ${fmtSI(max[0], "m")} | y ${fmtSI(min[1], "m")} → ${fmtSI(max[1], "m")} | z ${fmtSI(min[2], "m")} → ${fmtSI(max[2], "m")}`;
}

function formatExtent(
  min: [number, number, number] | null | undefined,
  max: [number, number, number] | null | undefined,
): string {
  if (!min || !max) return "—";
  return [
    fmtSI(max[0] - min[0], "m"),
    fmtSI(max[1] - min[1], "m"),
    fmtSI(max[2] - min[2], "m"),
  ].join(" · ");
}

function describeGeometryDescriptor(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "unknown";
  const entry = raw as { geometry_kind?: unknown; geometry_params?: unknown };
  const kind = typeof entry.geometry_kind === "string" ? entry.geometry_kind : "unknown";
  const params =
    entry.geometry_params && typeof entry.geometry_params === "object"
      ? (entry.geometry_params as Record<string, unknown>)
      : {};
  if (kind === "Box" && Array.isArray(params.size)) {
    return `Box ${params.size.map((value) => `${(Number(value) * 1e9).toFixed(1)}nm`).join(" × ")}`;
  }
  if (kind === "Cylinder") {
    return `Cylinder r=${((Number(params.radius ?? 0)) * 1e9).toFixed(1)}nm h=${((Number(params.height ?? 0)) * 1e9).toFixed(1)}nm`;
  }
  if (kind === "Ellipsoid") {
    return `Ellipsoid ${["rx", "ry", "rz"].map((key) => `${key}=${((Number(params[key] ?? 0)) * 1e9).toFixed(1)}nm`).join(" ")}`;
  }
  if (kind === "ImportedGeometry") {
    return `Imported ${(String(params.source ?? "") || "mesh").split("/").pop()}`;
  }
  if (kind === "Translate") {
    return `Translate ${describeGeometryDescriptor(params.base)} by ${Array.isArray(params.translation) ? params.translation.map((value) => `${(Number(value) * 1e9).toFixed(1)}nm`).join(", ") : "?"}`;
  }
  if (kind === "Difference") {
    return `Difference(${describeGeometryDescriptor(params.base)} - ${describeGeometryDescriptor(params.tool)})`;
  }
  if (kind === "Union") {
    return `Union(${describeGeometryDescriptor(params.a)} + ${describeGeometryDescriptor(params.b)})`;
  }
  if (kind === "Intersection") {
    return `Intersection(${describeGeometryDescriptor(params.a)} & ${describeGeometryDescriptor(params.b)})`;
  }
  return kind;
}

export default function GeometryPanel({ nodeId }: { nodeId?: string }) {
  const model = useModel();
  const sceneAuthoring = useSceneAuthoringActions();

  const { object: sceneObject, index: objectIndex, material, magnetization } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.sceneDocument),
    [model.sceneDocument, nodeId],
  );

  const geo = useMemo(
    () =>
      sceneObject
        ? buildProjectedGeometryEntry(sceneObject, material, magnetization)
        : undefined,
    [magnetization, material, sceneObject],
  );

  const isGeometryPreset = sceneObject?.geometry.preset_kind != null;
  const geometryPresetDescriptor = useMemo(
    () => isGeometryPreset ? GEOMETRY_PRESET_CATALOG.find((d) => d.kind === sceneObject?.geometry.preset_kind) : null,
    [isGeometryPreset, sceneObject?.geometry]
  );
  const [geometryPresetLibraryOpen, setGeometryPresetLibraryOpen] = useState(false);

  const updateObject = useCallback(
    (updater: (object: SceneObject) => SceneObject, options?: { meshDirty?: boolean }) => {
      if (objectIndex < 0 || !model.sceneDocument) return;
      const nextObjects = [...model.sceneDocument.objects];
      const target = nextObjects[objectIndex];
      if (!target) return;
      const updated = updater(target);
      nextObjects[objectIndex] =
        options?.meshDirty === false
          ? updated
          : {
              ...updated,
              tags: Array.from(new Set([...(updated.tags ?? []), "mesh:dirty"])),
            };
      model.setSceneDocument({
        ...model.sceneDocument,
        revision: model.sceneDocument.revision + 1,
        objects: nextObjects,
      });
      void sceneAuthoring
        .updateSceneMergePatch({ objects: nextObjects })
        .catch((error) => {
          console.error("failed to patch authoring geometry object", error);
        });
    },
    [model, objectIndex, sceneAuthoring],
  );

  const handleBoxSize = (idx: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    updateObject((object) => {
      const size = Array.isArray(object.geometry.geometry_params.size)
        ? [...object.geometry.geometry_params.size]
        : [20e-9, 20e-9, 10e-9];
      size[idx] = val * 1e-9;
      return {
        ...object,
        geometry: {
          ...object.geometry,
          geometry_params: { ...object.geometry.geometry_params, size },
        },
      };
    });
  };

  const handleParamNum = (key: string, valStr: string) => {
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    updateObject((object) => ({
      ...object,
      geometry: {
        ...object.geometry,
        geometry_params: {
          ...object.geometry.geometry_params,
          [key]: val * 1e-9,
        },
      },
    }));
  };

  const handleTranslation = (idx: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    startTransition(() => {
      updateObject((object) => {
        const translation = [...readTranslation(object)] as [number, number, number];
        translation[idx] = val * 1e-9;
        return {
          ...object,
          transform: {
            ...object.transform,
            translation,
          },
        };
      });
    });
  };

  const handleScaleComponent = (idx: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    updateObject((object) => {
      const currentScale = object.geometry.geometry_params.scale;
      const scale = Array.isArray(currentScale)
        ? [...currentScale]
        : [Number(currentScale ?? 1), Number(currentScale ?? 1), Number(currentScale ?? 1)];
      scale[idx] = val;
      return {
        ...object,
        geometry: {
          ...object.geometry,
          geometry_params: { ...object.geometry.geometry_params, scale },
        },
      };
    });
  };

  const handleRotation = (idx: number, valStr: string) => {
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    startTransition(() => {
      updateObject((object) => {
        const currentQuat = readRotationQuat(object);
        const euler = quatToEulerDeg(currentQuat);
        euler[idx] = val;
        const newQuat = eulerDegToQuat(euler);
        return {
          ...object,
          transform: {
            ...object.transform,
            rotation_quat: newQuat,
          },
        };
      });
    });
  };

  const assignGeometryPreset = (presetKind: GeometryPresetKind) => {
    setGeometryPresetLibraryOpen(false);
    updateObject((object) => {
      const descriptor = GEOMETRY_PRESET_CATALOG.find((d) => d.kind === presetKind);
      if (!descriptor) return object;
      const evaluated = evaluateGeometryPreset(presetKind, descriptor.defaultParams);
      return {
        ...object,
        geometry: {
          ...object.geometry,
          preset_kind: presetKind,
          preset_params: { ...descriptor.defaultParams },
          geometry_kind: evaluated.geometry_kind,
          geometry_params: { ...evaluated.geometry_params, name: object.name },
        },
      };
    });
  };

  const updateGeometryPresetParam = (key: string, value: unknown) => {
    updateObject((object) => {
      if (!object.geometry.preset_kind || !object.geometry.preset_params) return object;
      const nextParams = { ...object.geometry.preset_params, [key]: value };
      const evaluated = evaluateGeometryPreset(object.geometry.preset_kind as GeometryPresetKind, nextParams);
      return {
        ...object,
        geometry: {
          ...object.geometry,
          preset_params: nextParams,
          geometry_kind: evaluated.geometry_kind,
          geometry_params: { ...evaluated.geometry_params, name: object.name },
        },
      };
    });
  };

  if (!geo || !sceneObject) {
    return (
      <SidebarSection title="Geometry" defaultOpen={true}>
        <div className="flex flex-col gap-0.5">
          <InfoRow label="Geometry" value={model.meshName ?? model.mesherSourceKind ?? "—"} />
          <InfoRow label="Source" value={model.meshSource ?? model.mesherSourceKind ?? "—"} />
          <InfoRow
            label="Extent"
            value={
              model.meshExtent
                ? `${fmtSI(model.meshExtent[0], "m")} · ${fmtSI(model.meshExtent[1], "m")} · ${fmtSI(model.meshExtent[2], "m")}`
                : "—"
            }
          />
          <InfoRow
            label="Bounds"
            value={
              model.meshBoundsMin && model.meshBoundsMax
                ? `${fmtSI(model.meshBoundsMin[0], "m")} → ${fmtSI(model.meshBoundsMax[0], "m")}`
                : "—"
            }
          />
        </div>
      </SidebarSection>
    );
  }

  const p = geo.geometry_params;
  const translation = readTranslation(sceneObject);
  const rotationQuat = readRotationQuat(sceneObject);
  const rotationEuler = quatToEulerDeg(rotationQuat);
  const size = Array.isArray(p.size) ? p.size : [20e-9, 20e-9, 10e-9];
  const scale = p.scale;
  const regionName = sceneObject.region_name?.trim() || sceneObject.name;
  const liveBounds = extractGeometryBoundsFromParams(geo);
  const referenceObject = model.sceneDocument?.objects.find(
    (object) => (object.name || object.id) !== (sceneObject.name || sceneObject.id),
  ) ?? null;
  const referenceBounds = referenceObject
    ? extractGeometryBoundsFromParams(
        buildProjectedGeometryEntry(
          referenceObject,
          model.sceneDocument?.materials.find((entry) => entry.id === referenceObject.material_ref),
          model.sceneDocument?.magnetization_assets.find(
            (entry) => entry.id === referenceObject.magnetization_ref,
          ),
        ),
      )
    : null;
  const referenceExtent =
    referenceBounds?.boundsMin && referenceBounds.boundsMax
      ? ([
          referenceBounds.boundsMax[0] - referenceBounds.boundsMin[0],
          referenceBounds.boundsMax[1] - referenceBounds.boundsMin[1],
          referenceBounds.boundsMax[2] - referenceBounds.boundsMin[2],
        ] as [number, number, number])
      : null;
  const csgSummary =
    geo.geometry_kind === "Difference"
      ? `base: ${describeGeometryDescriptor(p.base)} | tool: ${describeGeometryDescriptor(p.tool)}`
      : geo.geometry_kind === "Union"
        ? `a: ${describeGeometryDescriptor(p.a)} | b: ${describeGeometryDescriptor(p.b)}`
        : geo.geometry_kind === "Intersection"
          ? `a: ${describeGeometryDescriptor(p.a)} | b: ${describeGeometryDescriptor(p.b)}`
          : null;

  return (
    <>
      {/* ── Card 1: General Properties ── */}
      <SidebarSection title="General Properties" icon="⚙" defaultOpen={true}>
        <div className="flex flex-col gap-2">
          <PropertyRow label="Name" value={sceneObject.name} mono />
          <PropertyRow label="Type" value={geo.geometry_kind} />
          <div className="flex items-center justify-between gap-3">
            <PropertyRow label="Region" value={regionName} mono />
          </div>
          <ToggleRow
            label="Visible"
            checked={sceneObject.visible !== false}
            onChange={(next) =>
              updateObject((obj) => ({ ...obj, visible: next }), { meshDirty: false })
            }
          />
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                let duplicateName: string | null = null;
                let mergePatch: Record<string, unknown> | null = null;
                model.setSceneDocument((prev) => {
                  if (!prev) return prev;
                  const source = prev.objects[objectIndex];
                  if (!source) return prev;
                  const nextDuplicateName = makeUniqueSceneObjectName(`${source.name}_copy`, prev.objects);
                  duplicateName = nextDuplicateName;
                  const sourceMaterial =
                    prev.materials.find((entry) => entry.id === source.material_ref) ??
                    defaultSceneMaterialAsset(source.name);
                  const sourceMagnetization =
                    prev.magnetization_assets.find(
                      (entry) => entry.id === source.magnetization_ref,
                    ) ?? defaultSceneMagnetizationAsset(source.name);
                  const nextObjects = [...prev.objects];
                  nextObjects.splice(objectIndex + 1, 0, cloneSceneObject(source, nextDuplicateName));
                  const nextMaterials = [
                    ...prev.materials,
                    {
                      ...sourceMaterial,
                      id: defaultSceneMaterialId(nextDuplicateName),
                      name: `${nextDuplicateName} material`,
                    },
                  ];
                  const nextMagnetizationAssets = [
                    ...prev.magnetization_assets,
                    {
                      ...sourceMagnetization,
                      id: defaultSceneMagnetizationId(nextDuplicateName),
                      name: `${nextDuplicateName} magnetization`,
                    },
                  ];
                  mergePatch = {
                    objects: nextObjects,
                    materials: nextMaterials,
                    magnetization_assets: nextMagnetizationAssets,
                  };
                  return {
                    ...prev,
                    objects: nextObjects,
                    materials: nextMaterials,
                    magnetization_assets: nextMagnetizationAssets,
                  };
                });
                if (!duplicateName) return;
                if (mergePatch) {
                  void sceneAuthoring
                    .updateSceneMergePatch(mergePatch)
                    .catch((error) => {
                      console.error("failed to patch duplicated authoring object", error);
                    });
                }
                startTransition(() => {
                  model.setSelectedObjectId(duplicateName);
                  model.setSelectedSidebarNodeId(`obj-${duplicateName}`);
                  model.setObjectViewMode("context");
                });
              }}
            >
              Duplicate
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 opacity-90 hover:opacity-100"
              onClick={() => {
                let mergePatch: Record<string, unknown> | null = null;
                model.setSceneDocument((prev) => {
                  if (!prev) return prev;
                  const target = prev.objects[objectIndex];
                  if (!target) return prev;
                  const remainingObjects = prev.objects.filter((_, index) => index !== objectIndex);
                  const materialStillReferenced = remainingObjects.some(
                    (object) => object.material_ref === target.material_ref,
                  );
                  const magnetizationStillReferenced = remainingObjects.some(
                    (object) => object.magnetization_ref === target.magnetization_ref,
                  );
                  const nextMaterials = materialStillReferenced
                    ? prev.materials
                    : prev.materials.filter((entry) => entry.id !== target.material_ref);
                  const nextMagnetizationAssets = magnetizationStillReferenced
                    ? prev.magnetization_assets
                    : prev.magnetization_assets.filter(
                        (entry) => entry.id !== target.magnetization_ref,
                      );
                  mergePatch = {
                    objects: remainingObjects,
                    materials: nextMaterials,
                    magnetization_assets: nextMagnetizationAssets,
                  };
                  return {
                    ...prev,
                    objects: remainingObjects,
                    materials: nextMaterials,
                    magnetization_assets: nextMagnetizationAssets,
                  };
                });
                if (mergePatch) {
                  void sceneAuthoring
                    .updateSceneMergePatch(mergePatch)
                    .catch((error) => {
                      console.error("failed to patch deleted authoring object", error);
                    });
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </SidebarSection>

      {/* ── Card 2: Geometry ── */}
      <SidebarSection title="Geometry" icon="📐" defaultOpen={true}>
        <div className="flex flex-col gap-3">
          {/* Position / Rotation / Scale — mockup-style compact input grids */}
          <CompactInputGrid
            label="Position"
            fields={[
              { label: "X", value: (translation[0] * 1e9).toFixed(1), onChange: (v) => handleTranslation(0, v) },
              { label: "Y", value: (translation[1] * 1e9).toFixed(1), onChange: (v) => handleTranslation(1, v) },
              { label: "Z", value: (translation[2] * 1e9).toFixed(1), onChange: (v) => handleTranslation(2, v) },
            ]}
          />
          <CompactInputGrid
            label="Rotation"
            fields={[
              { label: "R_x", value: rotationEuler[0].toFixed(2), onChange: (v) => handleRotation(0, v) },
              { label: "R_y", value: rotationEuler[1].toFixed(2), onChange: (v) => handleRotation(1, v) },
              { label: "R_z", value: rotationEuler[2].toFixed(2), onChange: (v) => handleRotation(2, v) },
            ]}
          />
          {Array.isArray(scale) ? (
            <CompactInputGrid
              label="Scale"
              fields={[
                { label: "S_x", value: String(scale[0] ?? 1), onChange: (v) => handleScaleComponent(0, v) },
                { label: "S_y", value: String(scale[1] ?? 1), onChange: (v) => handleScaleComponent(1, v) },
                { label: "S_z", value: String(scale[2] ?? 1), onChange: (v) => handleScaleComponent(2, v) },
              ]}
            />
          ) : (
            <CompactInputGrid
              label="Scale"
              fields={[
                { label: "Uniform", value: scale != null ? String(scale) : "1", onChange: (v) => {
                  const val = Number.parseFloat(v);
                  if (!Number.isFinite(val)) return;
                  updateObject((object) => ({
                    ...object,
                    geometry: {
                      ...object.geometry,
                      geometry_params: { ...object.geometry.geometry_params, scale: val },
                    },
                  }));
                }},
              ]}
            />
          )}

          {/* Dimensions sub-section */}
          <div className="flex items-center justify-between pb-1 mt-4">
            <SubSectionHeader title="Dimensions" icon="📏" />
            <Button
              variant={isGeometryPreset ? "secondary" : "outline"}
              size="sm"
              className="h-6 text-[0.6rem] uppercase tracking-wider"
              onClick={() => setGeometryPresetLibraryOpen((v) => !v)}
            >
              {isGeometryPreset ? "Change Preset" : "Browse Presets"}
            </Button>
          </div>

          {geometryPresetLibraryOpen && (
            <div className="mb-3 rounded-lg border border-border/40 bg-card/20 p-2">
              <GeometryPresetLibraryPanel
                selectedKind={sceneObject.geometry.preset_kind as GeometryPresetKind | null}
                onSelectKind={(kind) => assignGeometryPreset(kind)}
                onAssignPreset={(kind) => assignGeometryPreset(kind)}
              />
              {isGeometryPreset && (
                <Button variant="ghost" size="sm" className="w-full mt-2 h-7 text-xs" onClick={() => updateObject(o => ({ ...o, geometry: { ...o.geometry, preset_kind: null, preset_params: null } }))}>
                  Detach preset (Convert to custom)
                </Button>
              )}
            </div>
          )}

          {!isGeometryPreset ? (
            <>
              <SelectField
                label="Geometry Kind"
                value={geo.geometry_kind}
                onchange={(nextKind) =>
                  updateObject((current) => ({
                    ...current,
                    geometry: {
                      ...current.geometry,
                      geometry_kind: nextKind,
                      geometry_params: defaultGeometryParams(nextKind, current.name),
                    },
                  }))
                }
                options={[
                  { label: "Box", value: "Box" },
                  { label: "Cylinder", value: "Cylinder" },
                  { label: "Ellipsoid", value: "Ellipsoid" },
                  { label: "Ellipse", value: "Ellipse" },
                  { label: "Imported Mesh", value: "ImportedGeometry" },
                  { label: "Difference (CSG)", value: "Difference" },
                  { label: "Union (CSG)", value: "Union" },
                  { label: "Intersection (CSG)", value: "Intersection" },
                ]}
                tooltip="Choose the underlying geometry recipe for this object."
              />
          {geo.geometry_kind === "Box" && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-3">
                <TextField key={`${geo.name}-size-x-${size[0]}`} label="X Length" defaultValue={(size[0] * 1e9).toFixed(1)} onBlur={(e) => handleBoxSize(0, e.target.value)} unit="nm" mono />
                <TextField key={`${geo.name}-size-y-${size[1]}`} label="Y Length" defaultValue={(size[1] * 1e9).toFixed(1)} onBlur={(e) => handleBoxSize(1, e.target.value)} unit="nm" mono />
                <TextField key={`${geo.name}-size-z-${size[2]}`} label="Z Length" defaultValue={(size[2] * 1e9).toFixed(1)} onBlur={(e) => handleBoxSize(2, e.target.value)} unit="nm" mono />
              </div>
              {referenceExtent ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 w-full text-[0.65rem] uppercase tracking-wider"
                  onClick={() =>
                    updateObject((object) => ({
                      ...object,
                      geometry: {
                        ...object.geometry,
                        geometry_params: {
                          ...object.geometry.geometry_params,
                          size: [...referenceExtent],
                        },
                      },
                    }))
                  }
                >
                  Match {referenceObject?.name || referenceObject?.id} dimensions
                </Button>
              ) : null}
            </div>
          )}
          {geo.geometry_kind === "Cylinder" && (
            <div className="grid grid-cols-2 gap-3">
              <TextField key={`${geo.name}-radius`} label="Radius" defaultValue={p.radius ? (Number(p.radius) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("radius", e.target.value)} unit="nm" mono />
              <TextField key={`${geo.name}-height`} label="Height" defaultValue={p.height ? (Number(p.height) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("height", e.target.value)} unit="nm" mono />
            </div>
          )}
          {geo.geometry_kind === "Ellipsoid" && (
            <div className="grid grid-cols-3 gap-3">
              <TextField key={`${geo.name}-rx`} label="Rx" defaultValue={p.rx ? (Number(p.rx) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("rx", e.target.value)} unit="nm" mono />
              <TextField key={`${geo.name}-ry`} label="Ry" defaultValue={p.ry ? (Number(p.ry) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("ry", e.target.value)} unit="nm" mono />
              <TextField key={`${geo.name}-rz`} label="Rz" defaultValue={p.rz ? (Number(p.rz) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("rz", e.target.value)} unit="nm" mono />
            </div>
          )}
          {geo.geometry_kind === "Ellipse" && (
            <div className="grid grid-cols-3 gap-3">
              <TextField key={`${geo.name}-ellipse-rx`} label="Rx" defaultValue={p.rx ? (Number(p.rx) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("rx", e.target.value)} unit="nm" mono />
              <TextField key={`${geo.name}-ellipse-ry`} label="Ry" defaultValue={p.ry ? (Number(p.ry) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("ry", e.target.value)} unit="nm" mono />
              <TextField key={`${geo.name}-ellipse-height`} label="Height" defaultValue={p.height ? (Number(p.height) * 1e9).toFixed(1) : ""} onBlur={(e) => handleParamNum("height", e.target.value)} unit="nm" mono />
            </div>
          )}
          {geo.geometry_kind === "ImportedGeometry" && (
            <div className="flex flex-col gap-3">
              <TextField
                key={`${geo.name}-source`}
                label="Source File"
                defaultValue={typeof p.source === "string" ? p.source : ""}
                onBlur={(e) =>
                  updateObject((object) => ({
                    ...object,
                    geometry: {
                      ...object.geometry,
                      geometry_params: {
                        ...object.geometry.geometry_params,
                        source: e.target.value.trim(),
                      },
                    },
                  }))
                }
                mono
                placeholder="mesh.stl"
              />
              <SelectField
                label="Imported Volume"
                value={typeof p.volume === "string" ? p.volume : "full"}
                onchange={(value) =>
                  updateObject((object) => ({
                    ...object,
                    geometry: {
                      ...object.geometry,
                      geometry_params: {
                        ...object.geometry.geometry_params,
                        volume: value,
                      },
                    },
                  }))
                }
                options={[
                  { label: "Full Volume", value: "full" },
                  { label: "Surface Only", value: "surface" },
                ]}
              />
            </div>
          )}
              {csgSummary && (
                <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {csgSummary}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary/80">
                Using geometry preset: <strong className="font-semibold">{geometryPresetDescriptor?.label}</strong>
              </div>
              {geometryPresetDescriptor?.parameters.map((parameter) => (
                <PresetParameterField
                  key={parameter.key}
                  parameter={parameter}
                  value={sceneObject.geometry.preset_params?.[parameter.key]}
                  onChange={(val) => updateGeometryPresetParam(parameter.key, val)}
                />
              ))}
            </div>
          )}
        </div>
      </SidebarSection>

      {/* ── Card 3: Physics Settings (compact summary) ── */}
      <SidebarSection title="Physics Settings" icon="🧲" defaultOpen={true}>
        <div className="flex flex-col gap-2">
          <PropertyRow label="Material" value={material?.name ?? "Default"} />
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 px-3 py-2 backdrop-blur-sm">
              <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60">Ms</span>
              <span className="font-mono text-xs text-foreground">{material?.properties.Ms != null ? fmtSI(material.properties.Ms, "A/m") : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 px-3 py-2 backdrop-blur-sm">
              <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60">Aex</span>
              <span className="font-mono text-xs text-foreground">{material?.properties.Aex != null ? fmtSI(material.properties.Aex, "J/m") : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 px-3 py-2 backdrop-blur-sm">
              <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60">α</span>
              <span className="font-mono text-xs text-foreground">{material?.properties.alpha?.toPrecision(3) ?? "—"}</span>
            </div>
          </div>
        </div>
      </SidebarSection>

      {/* ── Card 4: Mesh Properties ── */}
      <SidebarSection title="Mesh Properties" icon="🔷" defaultOpen={true}>
        <div className="flex flex-col gap-2">
          {sceneObject.tags?.includes("mesh:dirty") ? (
            <div className="rounded-lg border border-rose-500/35 bg-rose-950/20 px-3 py-2 text-[0.72rem] leading-relaxed text-rose-100">
              Mesh out of date — build mesh before compute.
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">Resolution</span>
            <StatusBadge label={sceneObject.mesh_override?.mode === "custom" ? "Custom" : "Defaults"} tone={sceneObject.mesh_override?.mode === "custom" ? "accent" : "default"} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">Geometry</span>
            <StatusBadge label={geo.geometry_kind} tone="info" />
          </div>
          <Button
            type="button"
            size="sm"
            className="mt-1 h-8"
            disabled={model.meshGenerating}
            onClick={() => {
              void model.handleStudyDomainMeshGenerate("geometry_panel_build_mesh")
                .then(() => {
                  model.setSceneDocument((prev) =>
                    prev
                      ? {
                          ...prev,
                          objects: prev.objects.map((object) =>
                            object.id === sceneObject.id || object.name === sceneObject.name
                              ? {
                                  ...object,
                                  tags: (object.tags ?? []).filter((tag) => tag !== "mesh:dirty"),
                                }
                              : object,
                          ),
                        }
                      : prev,
                  );
                });
            }}
          >
            {model.meshGenerating ? "Building..." : "Build Mesh / Grid"}
          </Button>
        </div>
      </SidebarSection>

      {/* ── Card 5: Spatial Summary ── */}
      <SidebarSection title="Spatial Summary" icon="📍" defaultOpen={false}>
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-1 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 px-3 py-2 backdrop-blur-sm">
            <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60">Bounds</span>
            <span className="font-mono text-xs tracking-tight text-foreground">{formatBounds(liveBounds?.boundsMin, liveBounds?.boundsMax)}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/25 bg-gradient-to-b from-card/35 to-card/10 px-3 py-2 backdrop-blur-sm">
            <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60">Extent</span>
            <span className="font-mono text-xs tracking-tight text-foreground">{formatExtent(liveBounds?.boundsMin, liveBounds?.boundsMax)}</span>
          </div>
        </div>
      </SidebarSection>
    </>
  );
}
