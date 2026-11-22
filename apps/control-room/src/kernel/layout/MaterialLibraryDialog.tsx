"use client";

import { BookOpen, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";

import type {
  MaterialLibraryEntryResource,
  MaterialLibraryWriteRequest,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  PublishedMaterialVersion,
  SceneMaterialResource,
} from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { authoringWriteOptions, runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { resolveMaterialResourceKey, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  MATERIAL_LIBRARY_RESOURCE_KEY, useMaterialLibraryResource, useMaterialLibraryVersionMutations,
} from "@/kernel/resources/materialLibraryResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  MATERIAL_PROPERTY_FIELDS,
  copyMaterialSource,
  formatMaterialSourceChange,
  materialCatalogSelectionSnapshot,
  materialPropertiesFromDraft,
  materialPropertiesToDraft,
  materialSourceChanges,
  type MaterialCatalogSelection,
  type MaterialPropertiesDraft,
  type MaterialSourceSnapshot,
} from "@/shared/domain/material/materialLibrary";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/Dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Textarea } from "@/shared/ui/Textarea";
import {
  MATERIAL_CATALOG_FILTERS, MATERIAL_KIND_LABELS as KIND_LABELS, MATERIAL_VERSION_KEY_PATTERN,
  builtinMaterialFamily, materialCatalogView, publishedMaterialKey, type MaterialCatalogFilter,
} from "./materialLibraryCatalog";

export interface MaterialLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseMaterial?: (selection: MaterialCatalogSelection) => Promise<void>;
  modelMaterial?: SceneMaterialResource;
}

interface ReferenceDraft { key: string; label: string; url: string; citation: string }
interface EditorDraft {
  key: string;
  version: number;
  mode: "create" | "edit";
  id: string | null;
  baseRevision: number | null;
  name: string;
  summary: string;
  properties: MaterialPropertiesDraft;
  references: ReferenceDraft[];
  source: MaterialSourceSnapshot | null;
  sourceProject: string | null;
  baseline: string;
  conflicted: boolean;
}
type VersionEditor =
  | {
      kind: "publish"; entry: MaterialLibraryEntryResource;
      family: string; initialFamily: string; version: string;
      displayName: string; sourceProject: string | null;
    }
  | { kind: "manage"; published: PublishedMaterialVersion; displayName: string; archived: boolean };

type FocusTarget = "name" | "detail-heading" | "search" | "version-display-name";

interface Feedback { kind: "error" | "success"; message: string; conflict?: boolean; field?: string }
type CatalogNavigation =
  | { kind: "back" | "close" | "refresh" | "cancel" }
  | { kind: "select"; id: string }
  | { kind: "draft"; draft: EditorDraft };
type Confirmation = { title: string; message: string } & (
  | { kind: "discard"; navigation: CatalogNavigation }
  | { kind: "delete"; entry: MaterialLibraryEntryResource }
);

function versionEditorDirty(editor: VersionEditor): boolean {
  if (editor.kind === "manage") {
    return editor.displayName !== editor.published.display_name || editor.archived !== editor.published.archived;
  }
  return editor.displayName !== editor.entry.name || editor.family !== editor.initialFamily || Boolean(editor.version);
}
function referenceDraft(reference: MaterialReferenceResource = {}): ReferenceDraft {
  return { key: globalThis.crypto.randomUUID(), label: reference.label ?? "", url: reference.url ?? "", citation: reference.citation ?? "" };
}
function signature(draft: Omit<EditorDraft, "baseline"> | EditorDraft): string {
  return JSON.stringify({
    name: draft.name, summary: draft.summary, properties: draft.properties, source: draft.source,
    sourceProject: draft.sourceProject,
    references: draft.references.map(({ label, url, citation }) => ({ label, url, citation })),
  });
}
function makeDraft(input: {
  name: string; summary?: string | null; properties: MaterialPropertiesResource;
  references?: readonly MaterialReferenceResource[] | null; source?: MaterialSourceSnapshot | null;
  entry?: MaterialLibraryEntryResource; sourceProject?: string | null;
}): EditorDraft {
  const draft: EditorDraft = {
    key: globalThis.crypto.randomUUID(), version: 0, mode: input.entry ? "edit" : "create",
    id: input.entry?.id ?? null, baseRevision: input.entry?.revision ?? null,
    name: input.name, summary: input.summary ?? "", properties: materialPropertiesToDraft(input.properties),
    references: (input.references ?? []).map(referenceDraft), source: input.source ?? null,
    sourceProject: input.sourceProject ?? input.entry?.source_project ?? null, baseline: "", conflicted: false,
  };
  draft.baseline = signature(draft);
  return draft;
}
function sceneProperties(material: SceneMaterialResource): MaterialPropertiesResource {
  const properties = material.properties ?? {};
  const optional = (key: string) => {
    const value = properties[key];
    return typeof value === "number" ? value : null;
  };
  return { Ms: optional("Ms"), Aex: optional("Aex"), alpha: optional("alpha") ?? Number.NaN, Dind: optional("Dind"), Dbulk: optional("Dbulk") };
}
function requestFromDraft(draft: EditorDraft): { request: MaterialLibraryWriteRequest } | { error: string; field: string } {
  const name = draft.name.trim();
  if (!name) return { error: "Material name is required.", field: "name" };
  const parsed = materialPropertiesFromDraft(draft.properties);
  if ("error" in parsed) return parsed;
  const references: MaterialReferenceResource[] = [];
  for (const [index, reference] of draft.references.entries()) {
    const label = reference.label.trim();
    const url = reference.url.trim();
    const citation = reference.citation.trim();
    if (url && !safeReferenceUrl(url)) return { error: `Reference ${index + 1} URL must use http or https.`, field: `reference-${reference.key}-url` };
    if (label || url || citation) references.push({ ...(label ? { label } : {}), ...(url ? { url } : {}), ...(citation ? { citation } : {}) });
  }
  return {
    request: {
      name, summary: draft.summary.trim() || null, properties: parsed.properties, references,
      source: draft.source ? copyMaterialSource(draft.source) : null,
      ...(draft.sourceProject ? { source_project: draft.sourceProject } : {}),
    },
  };
}
function publicationRequirement(properties: MaterialPropertiesResource): { field: "Ms" | "Aex"; message: string } | null {
  if (properties.Ms == null || properties.Ms <= 0) {
    return { field: "Ms", message: "Ms must be greater than 0 A/m to publish a version." };
  }
  if (properties.Aex == null || properties.Aex <= 0) {
    return { field: "Aex", message: "Aex must be greater than 0 J/m to publish a version." };
  }
  return null;
}

function safeReferenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

/** Scope changes retire drafts and late acknowledgements without touching the shared catalog. */
export function MaterialLibraryDialog(props: MaterialLibraryDialogProps) {
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const returnFocus = useRef<HTMLElement | null>(null);
  const captureReturnFocus = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".fm-material-library")) {
      returnFocus.current = active;
    }
  }, []);
  const restoreReturnFocus = useCallback(() => {
    const target = returnFocus.current;
    if (target?.isConnected) target.focus();
  }, []);
  return <MaterialLibraryContent
    key={`${sessionScopeKey ?? "no-session"}:${props.modelMaterial?.id ?? "catalog"}:${props.open}`}
    {...props} captureReturnFocus={captureReturnFocus} restoreReturnFocus={restoreReturnFocus} sessionScopeKey={sessionScopeKey}
  />;
}

interface CatalogPosition {
  readonly filter: MaterialCatalogFilter;
  readonly query: string;
  readonly showArchived: boolean;
  readonly selectedId: string | null;
  readonly detailVisible: boolean;
}

type CatalogPositionAction =
  | { type: "filter"; filter: MaterialCatalogFilter }
  | { type: "query"; query: string }
  | { type: "toggleArchived" }
  | { type: "select"; selectedId: string | null }
  | { type: "selectSaved"; selectedId: string | null }
  | { type: "showDetail"; visible: boolean };

function updateCatalogPosition(
  position: CatalogPosition,
  action: CatalogPositionAction,
): CatalogPosition {
  switch (action.type) {
    case "filter": return { ...position, filter: action.filter };
    case "query": return { ...position, query: action.query };
    case "toggleArchived": {
      const showArchived = !position.showArchived;
      const filter = showArchived && position.filter !== "published" ? "all" : position.filter;
      return { ...position, filter, showArchived };
    }
    case "select": return { ...position, selectedId: action.selectedId };
    case "selectSaved": return { ...position, selectedId: action.selectedId, query: "", filter: "all" };
    case "showDetail": return { ...position, detailVisible: action.visible };
  }
}

function MaterialLibraryContent({
  open, onOpenChange, onUseMaterial, modelMaterial, captureReturnFocus, restoreReturnFocus, sessionScopeKey,
}: MaterialLibraryDialogProps & {
  captureReturnFocus: () => void;
  restoreReturnFocus: () => void;
  sessionScopeKey: string | null;
}) {
  const kernel = useKernel();
  const { api, resources, authoringHistory } = kernel;
  const library = useMaterialLibraryResource({ enabled: open });
  const versionMutations = useMaterialLibraryVersionMutations();
  const scene = useSceneResource({ enabled: open && !onUseMaterial });
  const prefix = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [{ detailVisible, filter, query, selectedId, showArchived }, moveCatalog] =
    useReducer(updateCatalogPosition, {
      detailVisible: false,
      filter: "all",
      query: "",
      selectedId: null,
      showArchived: false,
    });
  const [focusRequest, setFocusRequest] = useState(0);
  const focusTarget = useRef<FocusTarget | null>(null);
  useEffect(() => {
    if (focusTarget.current) document.getElementById(`${prefix}-${focusTarget.current}`)?.focus();
    focusTarget.current = null;
  }, [focusRequest, prefix]);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [versionEditor, setVersionEditor] = useState<VersionEditor | null>(null);
  const draftRef = useRef<EditorDraft | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const entries = library.data?.entries ?? [];
  const catalog = materialCatalogView(entries, library.data?.versions ?? [], filter, query, showArchived);
  const filtered = catalog.groups.flatMap((group) => group.rows);
  const first = filtered[0];
  const selected = selectedId ? entries.find((entry) => entry.id === selectedId) : first && "entry" in first ? first.entry : undefined;
  const selectedVersion = selectedId ? catalog.visibleVersions.find(({ source }) => source.catalog_id === selectedId)
    : first && "published" in first ? first.published : undefined;
  const versionEditorId = versionEditor?.kind === "publish" ? versionEditor.entry.id : versionEditor?.published.source.catalog_id;
  const view = draft?.key ?? versionEditorId ?? selected?.id ?? selectedVersion?.source.catalog_id ?? "empty";
  const viewRef = useRef(view);
  const viewEpoch = useRef(0);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  const dirty = Boolean(draft && signature(draft) !== draft.baseline);
  const saving = Boolean(draft && pending.has(`save:${draft.key}`));
  const savingVersion = Boolean(versionEditorId && pending.has(`version:${versionEditorId}`));
  const fieldId = (key: string) => `${prefix}-${key}`;
  function captureView(expectedView: string) {
    const epoch = viewEpoch.current;
    return () => alive.current && open && viewEpoch.current === epoch && viewRef.current === expectedView;
  }

  function focusAfterRender(target: FocusTarget) {
    focusTarget.current = target;
    setFocusRequest((value) => value + 1);
  }
  function replaceDraft(next: EditorDraft | null) {
    const previous = draftRef.current;
    draftRef.current = next;
    if (next) {
      viewRef.current = next.key;
      moveCatalog({ type: "showDetail", visible: true });
      if (previous?.key !== next.key) focusAfterRender("name");
    }
    setDraft(next);
  }
  function updateDraft(patch: Partial<EditorDraft>) {
    const current = draftRef.current;
    if (!current) return;
    replaceDraft({ ...current, ...patch, version: current.version + 1 });
    setFeedback(null);
  }
  function startPending(key: string): boolean {
    if (pendingRef.current.has(key)) return false;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    return true;
  }
  function finishPending(key: string) {
    pendingRef.current.delete(key);
    if (alive.current) setPending(new Set(pendingRef.current));
  }
  function applyNavigation(navigation: CatalogNavigation) {
    viewEpoch.current += 1;
    setVersionEditor(null);
    replaceDraft(navigation.kind === "draft" ? navigation.draft : null);
    setFeedback(null);
    switch (navigation.kind) {
      case "back":
        moveCatalog({ type: "showDetail", visible: false });
        focusAfterRender("search");
        break;
      case "close":
        viewRef.current = "closed";
        onOpenChange(false);
        break;
      case "refresh":
        library.refetch();
        focusAfterRender("search");
        break;
      case "cancel":
        if (selected || selectedVersion) focusAfterRender("detail-heading");
        else {
          moveCatalog({ type: "showDetail", visible: false });
          focusAfterRender("search");
        }
        break;
      case "select":
        viewRef.current = navigation.id;
        moveCatalog({ type: "select", selectedId: navigation.id });
        moveCatalog({ type: "showDetail", visible: true });
        focusAfterRender("detail-heading");
        break;
    }
  }
  function requestNavigation(navigation: CatalogNavigation) {
    if ((draftRef.current && signature(draftRef.current) !== draftRef.current.baseline) ||
      (versionEditor && versionEditorDirty(versionEditor))) {
      setConfirmation({
        kind: "discard", title: "Discard unsaved changes?", navigation,
        message: saving || savingVersion ? "Your draft has unsaved changes. A save already in progress can still complete." : "Your material draft has unsaved changes.",
      });
    } else applyNavigation(navigation);
  }
  function applyConfirmation() {
    setConfirmation(null);
    if (!confirmation || !alive.current || !open) return;
    if (confirmation.kind === "discard") applyNavigation(confirmation.navigation);
    else void deleteEntry(confirmation.entry);
  }
  function dismissConfirmation() {
    setConfirmation(null);
    if (draftRef.current || versionEditor) {
      moveCatalog({ type: "showDetail", visible: true });
      focusAfterRender(versionEditor ? "version-display-name" : "name");
    }
  }
  function newCustom() {
    requestNavigation({ kind: "draft", draft: makeDraft({
      name: "", properties: { Ms: null, Aex: null, alpha: 0.01, Dind: null, Dbulk: null },
    }) });
  }
  function newVariant(selection: MaterialCatalogSelection) {
    const { name, source } = materialCatalogSelectionSnapshot(selection);
    const summary = "id" in selection ? selection.summary : null;
    requestNavigation({ kind: "draft", draft: makeDraft({
      name: `${name} variant`, summary, properties: source.properties, references: source.references, source,
    }) });
  }
  function edit(entry: MaterialLibraryEntryResource) {
    requestNavigation({ kind: "draft", draft: makeDraft({ ...entry, source: entry.source ?? null, entry }) });
  }
  function copyModel() {
    if (!modelMaterial) return;
    const project = kernel.projectDocument?.getSnapshot();
    requestNavigation({ kind: "draft", draft: makeDraft({
      name: modelMaterial.name, properties: sceneProperties(modelMaterial),
      references: modelMaterial.references, source: modelMaterial.source ?? null,
      sourceProject: project?.state === "ready" ? project.resource.name : null,
    }) });
  }
  function reloadEntry() { requestNavigation({ kind: "refresh" }); }

  async function saveDraft(continueToPublish = false) {
    const snapshot = draftRef.current;
    if (!snapshot) return;
    if (snapshot.conflicted) {
      setFeedback({ kind: "error", message: "Reload the current catalog entry before saving again.", conflict: true });
      return;
    }
    const parsed = requestFromDraft(snapshot);
    if ("error" in parsed) {
      setFeedback({ kind: "error", message: parsed.error, field: parsed.field });
      document.getElementById(fieldId(parsed.field))?.focus();
      return;
    }
    if (continueToPublish) {
      const requirement = publicationRequirement(parsed.request.properties);
      if (requirement) {
        setFeedback({ kind: "error", ...requirement });
        document.getElementById(fieldId(requirement.field))?.focus();
        return;
      }
    }
    const operationKey = `save:${snapshot.key}`;
    const isCurrent = captureView(snapshot.key);
    if (!startPending(operationKey)) return;
    setFeedback(null);
    try {
      const saved = snapshot.mode === "edit" && snapshot.id !== null && snapshot.baseRevision !== null
        ? await api.workspace.updateMaterial(snapshot.id, { ...parsed.request, base_revision: snapshot.baseRevision })
        : await api.workspace.createMaterial(parsed.request);
      resources.invalidate(MATERIAL_LIBRARY_RESOURCE_KEY, saved.catalog_revision);
      if (!isCurrent()) return;
      const current = draftRef.current;
      if (!current || current.key !== snapshot.key) return;
      if (current.version === snapshot.version) {
        replaceDraft(null);
        moveCatalog({ type: "selectSaved", selectedId: saved.id });
        if (continueToPublish) beginPublish(saved);
        else setFeedback({ kind: "success", message: "Material saved to database." });
      } else {
        replaceDraft({ ...current, mode: "edit", id: saved.id, baseRevision: saved.revision, baseline: signature(snapshot) });
        setFeedback({ kind: "success", message: "Material saved to database; newer edits remain unsaved." });
      }
    } catch (error) {
      if (isCurrent()) {
        const conflict = error instanceof ControlRoomApiError && error.status === 409;
        const current = draftRef.current;
        if (conflict && current?.key === snapshot.key) replaceDraft({ ...current, conflicted: true });
        setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error), conflict });
      }
    } finally { finishPending(operationKey); }
  }

  async function deleteEntry(entry: MaterialLibraryEntryResource) {
    if (entry.kind === "builtin") return;
    const operationKey = `delete:${entry.id}`;
    const isCurrent = captureView(entry.id);
    if (!startPending(operationKey)) return;
    try {
      const deleted = await api.workspace.deleteMaterial(entry.id, { base_revision: entry.revision });
      resources.invalidate(MATERIAL_LIBRARY_RESOURCE_KEY, deleted.revision);
      if (!isCurrent()) return;
      moveCatalog({ type: "select", selectedId: null });
      setFeedback({ kind: "success", message: "Material removed from database. Model copies are unchanged." });
    } catch (error) {
      if (isCurrent()) setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error), conflict: error instanceof ControlRoomApiError && error.status === 409 });
    } finally { finishPending(operationKey); }
  }
  function confirmDelete(entry: MaterialLibraryEntryResource) {
    setConfirmation({
      kind: "delete", title: `Delete ${entry.name}?`, entry,
      message: "Copies already saved in models remain unchanged. This removes only the shared database entry.",
    });
  }

  async function importIntoModel(selection: MaterialCatalogSelection) {
    const id = "id" in selection ? selection.id : selection.source.catalog_id;
    const operationKey = `use:${id}`;
    const isCurrent = captureView(id);
    const { name, source } = materialCatalogSelectionSnapshot(selection);
    if (!startPending(operationKey)) return;
    setFeedback(null);
    try {
      if (onUseMaterial) {
        await onUseMaterial(selection);
        onOpenChange(false);
        return;
      }
      else {
        if (!sessionScopeKey) throw new Error("Open a model before using a database material.");
        const materialId = `mat:${globalThis.crypto.randomUUID()}`;
        const historyGeneration = authoringHistory?.getGeneration?.();
        const isCurrentSessionScope = () => kernel.commands.getSessionScopeKey() === sessionScopeKey &&
          (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
        const response = await runAuthoringMutationWithHistory({
          api, authoringHistory,
          selection: kernel.selection,
          resourceData: { [MODEL_SCENE_PATH]: scene.data },
          sessionScopeKey, isCurrentSessionScope,
        }, `Use material ${name}`, async ({ baseRevision }) => api.model.createMaterial(
          materialId, name, source.properties, source.references ?? [],
          authoringWriteOptions(baseRevision ?? scene.data?.revision, sessionScopeKey), { source },
        ));
        if (isCurrentSessionScope()) {
          invalidateAuthoringMutationDependents(resources, "material", response.scene_revision);
          resources.invalidate(resolveMaterialResourceKey(materialId), response.scene_revision);
        }
      }
      if (isCurrent()) onOpenChange(false);
    } catch (error) {
      if (isCurrent()) setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { finishPending(operationKey); }
  }

  function beginPublish(entry: MaterialLibraryEntryResource) {
    const sourceProject = entry.source_project ?? entry.source?.version?.source_project ?? null;
    const family = entry.source?.version?.family ?? builtinMaterialFamily(entry.source?.catalog_id ?? entry.id) ?? "";
    setVersionEditor({
      kind: "publish", entry, family, initialFamily: family, version: "", displayName: entry.name, sourceProject,
    });
    setFeedback(null);
    moveCatalog({ type: "showDetail", visible: true });
    focusAfterRender("version-display-name");
  }

  function beginManage(published: PublishedMaterialVersion) {
    setVersionEditor({ kind: "manage", published, displayName: published.display_name, archived: published.archived });
    moveCatalog({ type: "showDetail", visible: true });
    setFeedback(null);
    focusAfterRender("version-display-name");
  }

  async function saveVersion() {
    if (!versionEditor || !versionEditorId) return;
    const displayName = versionEditor.displayName.trim();
    if (!displayName) {
      setFeedback({ kind: "error", field: "version-display-name", message: "Display name is required." });
      focusAfterRender("version-display-name");
      return;
    }
    const operationKey = `version:${versionEditorId}`;
    const isCurrent = captureView(versionEditorId);
    if (!startPending(operationKey)) return;
    setFeedback(null);
    try {
      let saved: PublishedMaterialVersion;
      if (versionEditor.kind === "publish") {
        saved = await versionMutations.publish({
          material_id: versionEditor.entry.id, base_revision: versionEditor.entry.revision,
          version: versionEditor.version, family: versionEditor.family, display_name: displayName,
          ...(versionEditor.sourceProject ? { source_project: versionEditor.sourceProject } : {}),
        });
      } else {
        const sourceVersion = versionEditor.published.source.version;
        if (!sourceVersion) throw new Error("This publication is missing its version key.");
        saved = await versionMutations.update(sourceVersion.family, sourceVersion.version, {
          base_revision: versionEditor.published.revision, display_name: displayName, archived: versionEditor.archived,
        });
      }
      if (!isCurrent()) return;
      setVersionEditor(null);
      moveCatalog({ type: "selectSaved", selectedId: saved.archived && !showArchived ? null : saved.source.catalog_id });
      setFeedback({ kind: "success", message: versionEditor.kind === "publish" ? "Material version published." : "Version details saved." });
      focusAfterRender("search");
    } catch (error) {
      if (isCurrent()) setFeedback({
        kind: "error", message: error instanceof Error ? error.message : String(error),
        conflict: error instanceof ControlRoomApiError && error.status === 409,
      });
    } finally { finishPending(operationKey); }
  }

  const source = draft ? draft.source : versionEditor?.kind === "publish" ? versionEditor.entry.source
    : selectedVersion ? selectedVersion.original : selected?.source;
  const publishedSource = selectedVersion?.source;
  const preview = versionEditor?.kind === "publish" ? versionEditor.entry : publishedSource ?? selected;
  const draftParsed = draft ? materialPropertiesFromDraft(draft.properties) : null;
  const shownProperties = draftParsed
    ? ("properties" in draftParsed ? draftParsed.properties : null)
    : preview?.properties;
  const shownReferences = draft
    ? draft.references.map(({ label, url, citation }) => ({ label: label.trim(), url: url.trim(), citation: citation.trim() }))
    : preview?.references;
  const differences = source && shownProperties ? materialSourceChanges(shownProperties, shownReferences, source) : [];
  const catalogChanged = Boolean(draft?.mode === "edit" && entries.find((entry) => entry.id === draft.id)?.revision !== draft.baseRevision);
  const publishBlock = selected ? publicationRequirement(selected.properties) : null;

  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestNavigation({ kind: "close" }); else onOpenChange(true); }}>
      <DialogContent className="fm-material-library" aria-describedby={fieldId("description")}
        onOpenAutoFocus={(event) => {
          captureReturnFocus();
          event.preventDefault(); searchRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); restoreReturnFocus(); }}>
        <DialogHeader>
          <DialogTitle>Material database</DialogTitle>
          <DialogDescription id={fieldId("description")}>Shared across projects. Models keep independent copies of their parameters and sources.</DialogDescription>
          <Button className="fm-material-library__close" size="icon" variant="ghost" type="button" aria-label="Close material database" onClick={() => requestNavigation({ kind: "close" })}><X aria-hidden="true" /></Button>
        </DialogHeader>
        <div className="fm-material-library__layout" data-detail-open={detailVisible ? "true" : "false"}>
          <section className="fm-material-library__catalog" aria-label="Material catalog">
            <div className="fm-material-library__toolbar">
              <label htmlFor={fieldId("search")}>Search materials</label>
              <Input id={fieldId("search")} ref={searchRef} type="search" value={query} onChange={(event) => { if (!draftRef.current && !versionEditor) viewEpoch.current += 1; moveCatalog({ type: "query", query: event.target.value }); }} />
              <SegmentedControl aria-label="Material origin" columns={3} options={MATERIAL_CATALOG_FILTERS} value={filter} onValueChange={(value) => { if (!draftRef.current && !versionEditor) viewEpoch.current += 1; moveCatalog({ type: "filter", filter: value }); }} />
              <div className="fm-material-library__catalog-actions">
                <Button size="sm" type="button" onClick={newCustom}><Plus data-icon="inline-start" aria-hidden="true" />New material</Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => library.refetch()}>Refresh</Button>
                <Button size="sm" type="button" variant="ghost" aria-pressed={showArchived} onClick={() => {
                  moveCatalog({ type: "toggleArchived" });
                }}>Show archived versions</Button>
              </div>
              {modelMaterial ? <Button size="sm" type="button" onClick={copyModel}>Save model copy to database</Button> : null}
              <p className="fm-material-library__count">{filtered.length} {filtered.length === 1 ? "material" : "materials"}</p>
            </div>
            {library.error || library.refreshError ? <div className="fm-material-library__notice" role="alert">Could not load the material database. {(library.error ?? library.refreshError)?.message}<Button type="button" size="sm" onClick={() => library.refetch()}>Retry</Button></div> : null}
            <div className="fm-material-library__list" aria-busy={library.status === "loading" || library.status === "stale"}>
              {catalog.groups.map(({ family, title, rows }) => (
                <div key={family ?? rows[0]?.id} role={family ? "group" : undefined}
                  aria-label={family ? `${title} materials` : undefined} data-material-family={family ?? undefined}>
                  {family ? <h3 className="fm-material-library__family">{title}</h3> : null}
                  {rows.map((row) => {
                    const published = "published" in row ? row.published : null;
                    const entry = "entry" in row ? row.entry : null;
                    const active = view === row.id && !draft && !versionEditor;
                    return <button key={row.id} type="button" className="fm-material-library__item"
                      data-material-id={row.id} data-active={active ? "true" : undefined}
                      data-version={published ? "true" : undefined} aria-pressed={active}
                      onClick={() => requestNavigation({ kind: "select", id: row.id })}>
                      <span className="fm-material-library__item-title">
                        <strong>{published?.display_name ?? entry?.name}</strong>
                        <Badge variant="secondary">{published ? (published.archived ? "Archived" : "Published") : entry && KIND_LABELS[entry.kind]}</Badge>
                      </span>
                      <span>{published ? publishedMaterialKey(published) : entry?.summary || `Revision ${entry?.revision}`}</span>
                    </button>;
                  })}
                </div>
              ))}
              {!library.data && library.status === "loading" ? <p className="fm-material-library__empty" role="status">Loading material database…</p> : null}
              {library.data && !filtered.length ? <EmptyState size="compact" heading="No matching materials" description="Change the search or origin filter, or add a material." /> : null}
            </div>
          </section>
          <section className="fm-material-library__detail" aria-label={draft || versionEditor ? "Material editor" : "Material details"}>
            <Button className="fm-material-library__back" type="button" size="sm" onClick={() => requestNavigation({ kind: "back" })}>Back to materials</Button>
            {versionEditor ? (
              <form id={fieldId("version-form")} className="fm-material-library__form"
                onSubmit={(event) => { event.preventDefault(); void saveVersion(); }} aria-busy={savingVersion}>
                <h3 className="fm-material-library__form-title">{versionEditor.kind === "publish" ? "Publish a material version" : "Manage published version"}</h3>
                <p className="fm-material-library__note">
                  {versionEditor.kind === "publish" ? "Publishing freezes these parameters and references under a stable key."
                    : "The display name and archive status can change. The published key and snapshot stay fixed."}
                </p>
                <div className="fm-material-library__field">
                  <label htmlFor={fieldId("version-display-name")}>Display name</label>
                  <Input id={fieldId("version-display-name")} value={versionEditor.displayName} required disabled={savingVersion}
                    aria-invalid={feedback?.field === "version-display-name" || undefined}
                    aria-describedby={feedback?.field === "version-display-name" ? fieldId("feedback") : undefined}
                    onChange={(event) => {
                      setVersionEditor({ ...versionEditor, displayName: event.target.value });
                      if (feedback?.field) setFeedback(null);
                    }} />
                </div>
                {versionEditor.kind === "publish" ? <>
                  <div className="fm-material-library__grid">
                    <div className="fm-material-library__field">
                      <label htmlFor={fieldId("family")}>Family key</label>
                      <Input id={fieldId("family")} value={versionEditor.family} required disabled={savingVersion}
                        pattern={MATERIAL_VERSION_KEY_PATTERN} list={fieldId("families")} aria-describedby={fieldId("key-hint")}
                        autoCapitalize="none" spellCheck={false}
                        onChange={(event) => setVersionEditor({ ...versionEditor, family: event.target.value })} />
                      <datalist id={fieldId("families")}>{catalog.families.map((family) => <option key={family} value={family} />)}</datalist>
                    </div>
                    <div className="fm-material-library__field">
                      <label htmlFor={fieldId("version")}>Version key</label>
                      <Input id={fieldId("version")} value={versionEditor.version} required disabled={savingVersion}
                        pattern={MATERIAL_VERSION_KEY_PATTERN} aria-describedby={fieldId("key-hint")}
                        autoCapitalize="none" spellCheck={false}
                        onChange={(event) => setVersionEditor({ ...versionEditor, version: event.target.value })} />
                    </div>
                  </div>
                  <p id={fieldId("key-hint")} className="fm-material-library__note">Start each key with a lowercase ASCII letter. Use up to 48 lowercase letters, digits, and underscores.</p>
                  {versionEditor.family && versionEditor.version ? <p className="fm-material-library__note">Python key <code>{`fm.materials.${versionEditor.family}.${versionEditor.version}`}</code></p> : null}
                  {versionEditor.sourceProject ? <p className="fm-material-library__note">Copied from project <strong>{versionEditor.sourceProject}</strong></p> : null}
                  <MaterialProperties properties={versionEditor.entry.properties} />
                  <MaterialReferences references={versionEditor.entry.references ?? []} />
                </> : <>
                  <p className="fm-material-library__note">Python key <code>{`fm.materials.${publishedMaterialKey(versionEditor.published)}`}</code></p>
                  <label className="fm-material-library__check">
                    <Checkbox checked={versionEditor.archived} disabled={savingVersion}
                      onChange={(event) => setVersionEditor({ ...versionEditor, archived: event.target.checked })} />
                    Archived
                  </label>
                  <p className="fm-material-library__note">Archived versions stay available to scripts and are hidden from the default catalog view.</p>
                </>}
              </form>
            ) : draft ? <form id={fieldId("editor-form")} className="fm-material-library__form" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }} aria-busy={saving}>
              <div className="fm-material-library__section-heading"><h3>{draft.mode === "edit" ? "Edit database entry" : "New database entry"}</h3><Badge variant="secondary">{draft.source ? "Modified" : "Custom"}</Badge></div>
              <p className="fm-material-library__note">{dirty ? "Unsaved changes" : "Editing a database entry"}. Saving here does not change any model.</p>
              <div className="fm-material-library__grid">
                <div className="fm-material-library__field fm-material-library__wide"><label htmlFor={fieldId("name")}>Material name</label><Input id={fieldId("name")} value={draft.name} aria-invalid={feedback?.field === "name" || undefined} aria-describedby={feedback?.field === "name" ? fieldId("feedback") : undefined} onChange={(event) => updateDraft({ name: event.target.value })} /></div>
                <div className="fm-material-library__field fm-material-library__wide"><label htmlFor={fieldId("summary")}>Summary</label><Textarea id={fieldId("summary")} value={draft.summary} onChange={(event) => updateDraft({ summary: event.target.value })} /></div>
                {MATERIAL_PROPERTY_FIELDS.map(({ key, label, unit }) => <div className="fm-material-library__field" key={key} data-invalid={feedback?.field === key || undefined}>
                  <label htmlFor={fieldId(key)}>{label} ({unit})</label><Input id={fieldId(key)} inputMode="decimal" value={draft.properties[key]} aria-invalid={feedback?.field === key || undefined} aria-describedby={feedback?.field === key ? fieldId("feedback") : undefined} onChange={(event) => updateDraft({ properties: { ...draft.properties, [key]: event.target.value } })} />
                </div>)}
              </div>
              <p className="fm-material-library__note">Blank Ms, Aex, or DMI remains unset. Alpha is required; signed DMI is allowed.</p>
              <fieldset className="fm-material-library__references"><legend>Literature references</legend>
                {draft.references.map((reference, index) => <fieldset className="fm-material-library__reference" key={reference.key}><legend>Reference {index + 1}</legend>
                  <div className="fm-material-library__grid">{(["label", "url", "citation"] as const).map((key) => <div className="fm-material-library__field fm-material-library__wide" key={key}>
                    <label htmlFor={fieldId(`reference-${reference.key}-${key}`)}>{key === "url" ? "URL" : key === "label" ? "Label" : "Citation"} — reference {index + 1}</label>
                    <Input id={fieldId(`reference-${reference.key}-${key}`)} value={reference[key]} aria-invalid={feedback?.field === `reference-${reference.key}-${key}` || undefined} aria-describedby={feedback?.field === `reference-${reference.key}-${key}` ? fieldId("feedback") : undefined} onChange={(event) => updateDraft({ references: draft.references.map((row) => row.key === reference.key ? { ...row, [key]: event.target.value } : row) })} />
                  </div>)}</div>
                  <Button size="sm" variant="ghost" type="button" onClick={() => updateDraft({ references: draft.references.filter((row) => row.key !== reference.key) })} aria-label={`Remove reference ${index + 1}`}><Trash2 data-icon="inline-start" aria-hidden="true" />Remove reference</Button>
                </fieldset>)}
                <Button size="sm" type="button" onClick={() => updateDraft({ references: [...draft.references, referenceDraft()] })}><Plus data-icon="inline-start" aria-hidden="true" />Add reference</Button>
              </fieldset>
              {(draft.conflicted || catalogChanged) ? <div className="fm-material-library__notice"><p>The catalog entry changed. Your draft is preserved. Reload before editing the current revision.</p><Button type="button" size="sm" onClick={reloadEntry}>Reload catalog entry</Button></div> : null}
            </form> : selectedVersion ? <>
              <div className="fm-material-library__section-heading">
                <h3 id={fieldId("detail-heading")} tabIndex={-1}>{selectedVersion.display_name}</h3>
                <Badge variant="secondary">{selectedVersion.archived ? "Archived" : "Published"}</Badge>
              </div>
              <p className="fm-material-library__note">Python key <code>{`fm.materials.${publishedMaterialKey(selectedVersion)}`}</code></p>
              {selectedVersion.display_name !== selectedVersion.source.name ? <p className="fm-material-library__note">Published as <strong>{selectedVersion.source.name}</strong></p> : null}
              {publishedSource?.version?.source_project ? <p className="fm-material-library__note">Copied from project <strong>{publishedSource.version.source_project}</strong></p> : null}
              {publishedSource?.version?.copied_from_family ? <p className="fm-material-library__note">Copied from family <code>{publishedSource.version.copied_from_family}</code></p> : null}
              <MaterialProperties properties={selectedVersion.source.properties} />
              <MaterialReferences references={selectedVersion.source.references ?? []} />
              {!selectedVersion.original ? <p className="fm-material-library__note">No original is available for this family.</p> : null}
            </> : selected ? <>
              <div className="fm-material-library__section-heading"><h3 id={fieldId("detail-heading")} tabIndex={-1}>{selected.name}</h3><Badge variant="secondary">{KIND_LABELS[selected.kind]}</Badge></div>
              <p className="fm-material-library__note">Revision {selected.revision}{selected.kind === "builtin" ? " · Read-only original" : " · Shared database entry"}</p>
              {selected.summary ? <p className="fm-material-library__summary">{selected.summary}</p> : null}
              <MaterialProperties properties={selected.properties} />
              {selected.properties.Ms == null || selected.properties.Aex == null ? <p className="fm-material-library__note">Incomplete parameters: {[selected.properties.Ms == null ? "Ms" : null, selected.properties.Aex == null ? "Aex" : null].filter(Boolean).join(", ")}. Model readiness is checked before Compute.</p> : null}
              <MaterialReferences references={selected.references ?? []} />
              {selected.kind === "builtin" ? <p className="fm-material-library__note">Seed parameters are starting values. Check them for your sample and experimental conditions.</p> : null}
            </> : <EmptyState size="compact" icon={<BookOpen aria-hidden="true" />} heading="Choose a material" description="Browse reference parameters or create your own database entry." />}
            {source ? <section className="fm-material-library__source" aria-label="Material source"><h4>{selectedVersion && !versionEditor ? `Compared with original · ${source.name}` : `Source: ${source.name}`}</h4><p className="fm-material-library__note">{KIND_LABELS[source.kind]} · revision {source.catalog_revision}</p>{!shownProperties ? <p className="fm-material-library__note">Enter valid SI values to compare this draft with its source.</p> : differences.length ? <ul className="fm-material-library__differences">{differences.map((change) => <li key={change.key}>{formatMaterialSourceChange(change)}</li>)}</ul> : <p className="fm-material-library__note">No parameter or reference changes from this source.</p>}<details><summary>Saved source parameters and references</summary><MaterialProperties properties={source.properties} /><MaterialReferences references={source.references ?? []} /></details></section> : null}
            {feedback ? <p id={fieldId("feedback")} className="fm-material-library__feedback" data-kind={feedback.kind} role={feedback.kind === "error" ? "alert" : "status"} aria-live={feedback.kind === "error" ? "assertive" : "polite"}>{feedback.message}</p> : null}
            {!draft && feedback?.conflict ? <Button type="button" size="sm" onClick={reloadEntry}>Reload catalog entry</Button> : null}
            {versionEditor ? (
              <div className="fm-material-library__actions">
                <Button type="submit" form={fieldId("version-form")} variant="primary" disabled={savingVersion}>
                  {savingVersion ? "Saving…" : versionEditor.kind === "publish" ? "Publish version" : "Save version details"}
                </Button>
                <Button type="button" onClick={() => requestNavigation({ kind: "cancel" })}>Cancel</Button>
              </div>
            ) : draft ? (
              <div className="fm-material-library__actions">
                <Button type="submit" form={fieldId("editor-form")} variant="primary" disabled={saving || draft.conflicted}>
                  <Save data-icon="inline-start" aria-hidden="true" />
                  {saving ? "Saving…" : "Save to database"}
                </Button>
                <Button type="button" disabled={saving || draft.conflicted} onClick={() => void saveDraft(true)}>
                  Save and continue to publish
                </Button>
                <Button type="button" onClick={() => requestNavigation({ kind: "cancel" })}>
                  Cancel editing
                </Button>
              </div>
            ) : selectedVersion ? (
              <div className="fm-material-library__actions">
                {!selectedVersion.archived ? <>
                  <Button type="button" variant="primary"
                    disabled={pending.has(`use:${selectedVersion.source.catalog_id}`) || (!onUseMaterial && !sessionScopeKey)}
                    disabledReason={!onUseMaterial && !sessionScopeKey ? "Open a model first." : undefined}
                    onClick={() => void importIntoModel(selectedVersion)}>
                    {pending.has(`use:${selectedVersion.source.catalog_id}`) ? "Using material…" : "Use in model"}
                  </Button>
                  <Button type="button" onClick={() => newVariant(selectedVersion)}>Create variant</Button>
                </> : null}
                <Button type="button" disabled={library.status !== "ready"} onClick={() => beginManage(selectedVersion)}>Manage version</Button>
              </div>
            ) : selected ? (
              <>
                <div className="fm-material-library__actions">
                  <Button type="button" variant="primary"
                    disabled={pending.has(`use:${selected.id}`) || (!onUseMaterial && !sessionScopeKey)}
                    disabledReason={!onUseMaterial && !sessionScopeKey ? "Open a model first." : undefined}
                    onClick={() => void importIntoModel(selected)}>
                    {pending.has(`use:${selected.id}`) ? "Using material…" : "Use in model"}
                  </Button>
                  <Button type="button" onClick={() => newVariant(selected)}>Create variant</Button>
                  {selected.kind !== "builtin" ? (
                    <Button type="button" disabled={library.status !== "ready"}
                      disabledReason="Wait for the current catalog revision." onClick={() => edit(selected)}>
                      Edit entry
                    </Button>
                  ) : null}
                  {selected.kind !== "builtin" ? (
                    <Button type="button" disabled={library.status !== "ready" || publishBlock !== null}
                      disabledReason={publishBlock?.message ?? "Wait for the current catalog revision."} onClick={() => beginPublish(selected)}>
                      Publish version
                    </Button>
                  ) : null}
                </div>
                {selected.kind !== "builtin" ? (
                  <div className="fm-material-library__delete">
                    <Button type="button" variant="danger" size="sm" disabled={pending.has(`delete:${selected.id}`)} onClick={() => confirmDelete(selected)}>
                      <Trash2 data-icon="inline-start" aria-hidden="true" />Delete entry
                    </Button>
                    <span>Existing model copies are kept.</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(confirmation)} onOpenChange={(next) => { if (!next) dismissConfirmation(); }}>
      <DialogContent role="alertdialog" aria-describedby={fieldId("confirmation-description")} className="fm-material-library__confirmation">
        <DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription id={fieldId("confirmation-description")}>{confirmation?.message}</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" autoFocus onClick={dismissConfirmation}>{confirmation?.kind === "delete" ? "Keep material" : "Keep editing"}</Button><Button type="button" variant="danger" onClick={applyConfirmation}>{confirmation?.kind === "delete" ? "Delete from database" : "Discard changes"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function MaterialProperties({ properties }: { properties: Readonly<MaterialPropertiesResource> }) {
  return <dl className="fm-material-library__properties">{MATERIAL_PROPERTY_FIELDS.map(({ key, label, unit }) => <div key={key}><dt>{label} <span>({unit})</span></dt><dd>{properties[key] == null ? <span className="fm-material-library__missing">Not set</span> : String(properties[key])}</dd></div>)}</dl>;
}
function MaterialReferences({ references }: { references: readonly MaterialReferenceResource[] }) {
  const occurrences = new Map<string, number>();
  return (
    <section className="fm-material-library__literature" aria-label="Literature references">
      <h4>Literature references</h4>
      {references.length ? <ol>{references.map((reference) => {
        const identity = JSON.stringify([reference.label, reference.url, reference.citation]);
        const occurrence = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, occurrence);
        const link = reference.url ? safeReferenceUrl(reference.url) : null;
        return (
          <li key={`${identity}:${occurrence}`}>
            {reference.label ? <strong>{reference.label}</strong> : null}
            {link ? <a href={link} target="_blank" rel="noopener noreferrer">{reference.url}</a>
              : reference.url ? <span>{reference.url}</span> : null}
            {reference.citation ? <p>{reference.citation}</p> : null}
          </li>
        );
      })}</ol> : <p className="fm-material-library__note">No literature reference supplied.</p>}
    </section>
  );
}
