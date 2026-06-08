"use client";

import { BookOpen, Plus, Save, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  MaterialPatchRequest,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  resolveMaterialResourceKey,
  SCENE_RESOURCE_KEY,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  MATERIAL_LIBRARY_PRESETS,
  materialNameToId,
  materialPresetIdToSceneMaterialId,
  type MaterialLibraryPreset,
} from "@/shared/domain/material/materialLibrary";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

interface MaterialLibraryDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface MaterialDraft {
  Aex: string;
  Dbulk: string;
  Dind: string;
  Ms: string;
  alpha: string;
  citation: string;
  id: string;
  name: string;
  referenceLabel: string;
  referenceUrl: string;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

const EMPTY_PROPERTIES: MaterialPropertiesResource = {
  Aex: null,
  Dbulk: null,
  Dind: null,
  Ms: null,
  alpha: 0.01,
};

function sceneMaterials(scene: SceneResource | null | undefined) {
  return scene?.materials ?? [];
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function firstReferenceText(
  references: readonly MaterialReferenceResource[] | null | undefined,
  key: keyof MaterialReferenceResource,
): string {
  const value = references?.[0]?.[key];
  return typeof value === "string" ? value : "";
}

function materialPropertiesFromSceneMaterial(
  material: NonNullable<SceneResource["materials"]>[number],
): MaterialPropertiesResource {
  const properties = material.properties ?? {};
  return {
    Aex: typeof properties.Aex === "number" ? properties.Aex : null,
    Dbulk: typeof properties.Dbulk === "number" ? properties.Dbulk : null,
    Dind: typeof properties.Dind === "number" ? properties.Dind : null,
    Ms: typeof properties.Ms === "number" ? properties.Ms : null,
    alpha: typeof properties.alpha === "number" ? properties.alpha : 0.01,
  };
}

function draftFromSceneMaterial(
  material: NonNullable<SceneResource["materials"]>[number],
): MaterialDraft {
  const properties = materialPropertiesFromSceneMaterial(material);
  return {
    Aex: numberText(properties.Aex),
    Dbulk: numberText(properties.Dbulk),
    Dind: numberText(properties.Dind),
    Ms: numberText(properties.Ms),
    alpha: numberText(properties.alpha),
    citation: firstReferenceText(material.references, "citation"),
    id: material.id,
    name: material.name,
    referenceLabel: firstReferenceText(material.references, "label"),
    referenceUrl: firstReferenceText(material.references, "url"),
  };
}

function draftFromPreset(preset: MaterialLibraryPreset): MaterialDraft {
  return {
    Aex: numberText(preset.properties.Aex),
    Dbulk: numberText(preset.properties.Dbulk),
    Dind: numberText(preset.properties.Dind),
    Ms: numberText(preset.properties.Ms),
    alpha: numberText(preset.properties.alpha),
    citation: preset.references[0]?.citation ?? "",
    id: materialPresetIdToSceneMaterialId(preset.id),
    name: preset.name,
    referenceLabel: preset.references[0]?.label ?? "",
    referenceUrl: preset.references[0]?.url ?? "",
  };
}

function newMaterialDraft(): MaterialDraft {
  return {
    Aex: "",
    Dbulk: "",
    Dind: "",
    Ms: "",
    alpha: "0.01",
    citation: "",
    id: "mat:new-material",
    name: "New material",
    referenceLabel: "",
    referenceUrl: "",
  };
}

function optionalNumber(value: string, label: string): { error: string } | { value: number | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  const parsed = Number(trimmed);
  return Number.isFinite(parsed)
    ? { value: parsed }
    : { error: `${label} must be a finite SI value.` };
}

function requiredNumber(value: string, label: string): { error: string } | { value: number } {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed)
    ? { value: parsed }
    : { error: `${label} must be a finite SI value.` };
}

function materialDraftToProperties(
  draft: MaterialDraft,
): { error: string } | { properties: MaterialPropertiesResource } {
  const Ms = optionalNumber(draft.Ms, "Ms");
  if ("error" in Ms) return Ms;
  const Aex = optionalNumber(draft.Aex, "Aex");
  if ("error" in Aex) return Aex;
  const alpha = requiredNumber(draft.alpha, "alpha");
  if ("error" in alpha) return alpha;
  const Dind = optionalNumber(draft.Dind, "Dind");
  if ("error" in Dind) return Dind;
  const Dbulk = optionalNumber(draft.Dbulk, "Dbulk");
  if ("error" in Dbulk) return Dbulk;
  return {
    properties: {
      Aex: Aex.value,
      Dbulk: Dbulk.value,
      Dind: Dind.value,
      Ms: Ms.value,
      alpha: alpha.value,
    },
  };
}

function materialDraftReferences(draft: MaterialDraft): MaterialReferenceResource[] {
  const label = draft.referenceLabel.trim();
  const url = draft.referenceUrl.trim();
  const citation = draft.citation.trim();
  return label || url || citation
    ? [
        {
          citation: citation || undefined,
          label: label || undefined,
          url: url || undefined,
        },
      ]
    : [];
}

function materialPatchFromDraft(draft: MaterialDraft): { error: string } | { patch: MaterialPatchRequest } {
  const result = materialDraftToProperties(draft);
  if ("error" in result) return result;
  const name = draft.name.trim();
  if (!name) return { error: "Material name must not be empty." };
  return {
    patch: {
      name,
      properties: result.properties,
      references: materialDraftReferences(draft),
    },
  };
}

export function MaterialLibraryDialog({
  onOpenChange,
  open,
}: MaterialLibraryDialogProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource({ enabled: open });
  const materials = useMemo(() => sceneMaterials(scene.data), [scene.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MaterialDraft>(newMaterialDraft);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const selectedMaterial = materials.find((material) => material.id === selectedId) ?? null;
  const existingIds = useMemo(
    () => new Set(materials.map((material) => material.id)),
    [materials],
  );

  function updateDraft(patch: Partial<MaterialDraft>): void {
    setDraft((current) => ({
      ...current,
      ...patch,
      id: patch.name && !selectedMaterial ? materialNameToId(patch.name) : (patch.id ?? current.id),
    }));
    setFeedback(null);
  }

  function invalidateMaterialResources(revision: number, materialId: string): void {
    resources.invalidate(SCENE_RESOURCE_KEY, revision);
    resources.invalidate(resolveMaterialResourceKey(materialId), revision);
  }

  async function saveDraft(): Promise<void> {
    const result = materialPatchFromDraft(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }
    const materialId = draft.id.trim();
    if (!materialId) {
      setFeedback({ kind: "error", message: "Material id must not be empty." });
      return;
    }

    setPending(true);
    try {
      const response = existingIds.has(materialId)
        ? await api.model.patchMaterialAsset(materialId, result.patch, {
            baseRevision: scene.data?.revision ?? undefined,
          })
        : await api.model.createMaterial(
            materialId,
            result.patch.name ?? draft.name,
            {
              Aex: result.patch.properties?.Aex ?? EMPTY_PROPERTIES.Aex,
              Dbulk: result.patch.properties?.Dbulk ?? EMPTY_PROPERTIES.Dbulk,
              Dind: result.patch.properties?.Dind ?? EMPTY_PROPERTIES.Dind,
              Ms: result.patch.properties?.Ms ?? EMPTY_PROPERTIES.Ms,
              alpha: result.patch.properties?.alpha ?? EMPTY_PROPERTIES.alpha,
            },
            result.patch.references ?? [],
            { baseRevision: scene.data?.revision ?? undefined },
          );
      invalidateMaterialResources(response.scene_revision, materialId);
      setSelectedId(materialId);
      setFeedback({ kind: "success", message: "Material library saved." });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selectedMaterial) return;
    setPending(true);
    try {
      const response = await api.model.deleteMaterial(selectedMaterial.id, {
        baseRevision: scene.data?.revision ?? undefined,
      });
      invalidateMaterialResources(response.scene_revision, selectedMaterial.id);
      setSelectedId(null);
      setDraft(newMaterialDraft());
      setFeedback({ kind: "success", message: "Material removed from library." });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-material-library" aria-describedby="fm-material-library-description">
        <DialogHeader>
          <DialogTitle>Material Library</DialogTitle>
          <DialogDescription id="fm-material-library-description">
            Manage canonical material assets, SI parameters, and literature references for this scene.
          </DialogDescription>
          <DialogClose asChild>
            <button className="fm-material-library__close" type="button" aria-label="Close material library">
              <X size={14} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="fm-material-library__layout">
          <section className="fm-material-library__panel" aria-label="Scene materials">
            <div className="fm-material-library__panel-header">
              <span>Scene materials</span>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  setSelectedId(null);
                  setDraft(newMaterialDraft());
                  setFeedback(null);
                }}
              >
                <Plus size={13} aria-hidden="true" />
                New
              </Button>
            </div>
            <div className="fm-material-library__list">
              {materials.map((material) => (
                <button
                  className="fm-material-library__item"
                  data-active={material.id === selectedId ? "true" : undefined}
                  key={material.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(material.id);
                    setDraft(draftFromSceneMaterial(material));
                    setFeedback(null);
                  }}
                >
                  <strong>{material.name}</strong>
                  <span>{material.id}</span>
                </button>
              ))}
              {materials.length === 0 ? (
                <div className="fm-material-library__empty">No scene materials.</div>
              ) : null}
            </div>
          </section>

          <section className="fm-material-library__editor" aria-label="Material editor">
            <div className="fm-material-library__grid">
              <label>
                <span>Name</span>
                <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
              </label>
              <label>
                <span>Material ID</span>
                <input
                  disabled={Boolean(selectedMaterial)}
                  value={draft.id}
                  onChange={(event) => updateDraft({ id: event.target.value })}
                />
              </label>
              <label>
                <span>Ms</span>
                <input inputMode="decimal" value={draft.Ms} onChange={(event) => updateDraft({ Ms: event.target.value })} />
                <small>A/m</small>
              </label>
              <label>
                <span>Aex</span>
                <input inputMode="decimal" value={draft.Aex} onChange={(event) => updateDraft({ Aex: event.target.value })} />
                <small>J/m</small>
              </label>
              <label>
                <span>alpha</span>
                <input inputMode="decimal" value={draft.alpha} onChange={(event) => updateDraft({ alpha: event.target.value })} />
                <small>1</small>
              </label>
              <label>
                <span>Dind</span>
                <input inputMode="decimal" value={draft.Dind} onChange={(event) => updateDraft({ Dind: event.target.value })} />
                <small>J/m²</small>
              </label>
              <label>
                <span>Dbulk</span>
                <input inputMode="decimal" value={draft.Dbulk} onChange={(event) => updateDraft({ Dbulk: event.target.value })} />
                <small>J/m³</small>
              </label>
              <label>
                <span>Reference label</span>
                <input value={draft.referenceLabel} onChange={(event) => updateDraft({ referenceLabel: event.target.value })} />
              </label>
              <label className="fm-material-library__wide">
                <span>Literature URL</span>
                <input value={draft.referenceUrl} onChange={(event) => updateDraft({ referenceUrl: event.target.value })} />
              </label>
              <label className="fm-material-library__wide">
                <span>Citation</span>
                <textarea value={draft.citation} onChange={(event) => updateDraft({ citation: event.target.value })} />
              </label>
            </div>
            <div className="fm-material-library__actions">
              <Button disabled={pending} type="button" variant="primary" onClick={() => void saveDraft()}>
                <Save size={14} aria-hidden="true" />
                Save material
              </Button>
              <Button disabled={pending || !selectedMaterial} type="button" variant="danger" onClick={() => void deleteSelected()}>
                <Trash2 size={14} aria-hidden="true" />
                Delete
              </Button>
              {feedback ? (
                <span className="fm-material-library__feedback" data-kind={feedback.kind}>
                  {feedback.message}
                </span>
              ) : null}
            </div>
          </section>

          <section className="fm-material-library__panel" aria-label="Material presets">
            <div className="fm-material-library__panel-header">
              <span>Presets</span>
              <BookOpen size={14} aria-hidden="true" />
            </div>
            <div className="fm-material-library__list">
              {MATERIAL_LIBRARY_PRESETS.map((preset) => (
                <button
                  className="fm-material-library__item"
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    const materialId = materialPresetIdToSceneMaterialId(preset.id);
                    const existing = materials.find((material) => material.id === materialId);
                    setSelectedId(existing?.id ?? null);
                    setDraft(existing ? draftFromSceneMaterial(existing) : draftFromPreset(preset));
                    setFeedback(null);
                  }}
                >
                  <strong>{preset.name}</strong>
                  <span>{preset.summary}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
