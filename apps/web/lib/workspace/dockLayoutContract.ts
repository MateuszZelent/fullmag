import type {
  IJsonBorderNode,
  IJsonModel,
  IJsonRowNode,
  IJsonTabNode,
  IJsonTabSetNode,
} from "flexlayout-react";

import {
  DOCKING_MIN_HEIGHT_BOTTOM,
  DOCKING_MIN_WIDTH_CENTER,
  DOCKING_MIN_WIDTH_LEFT,
  DOCKING_MIN_WIDTH_RIGHT,
  type DockLayoutTemplateId,
  type DockPanelComponent,
  type DockResponsivePreset,
  REQUIRED_DOCK_PANEL_COMPONENTS,
  createDefaultDockLayout,
  getDockLayoutTemplate,
  resolveDockResponsivePreset,
  resolveDockLayoutTemplateId,
} from "@/components/workspace/docking/dockLayoutDefaults";

export type DockLayoutModel = IJsonModel;

export const DOCKING_LAYOUT_SCHEMA_VERSION = 1;
export const DOCKING_LAYOUT_SCHEMA_VERSION_KEY = "dockingLayoutSchemaVersion";

export interface DockLayoutEnvelope {
  dockingLayoutSchemaVersion: number;
  templateId: DockLayoutTemplateId;
  model: DockLayoutModel;
  lastRepairReason: string | null;
  lastRepairAtUnixMs: number | null;
  wasRecovered: boolean;
}

export type DockLayoutByPreset = Record<DockResponsivePreset, DockLayoutEnvelope | null>;

export interface DockLayoutEnvelopeResult {
  envelope: DockLayoutEnvelope;
  repairReasons: string[];
  changed: boolean;
}

function createDefaultEnvelope(preset: DockResponsivePreset): DockLayoutEnvelope {
  return normalizeDockLayoutEnvelope(
    {
      [DOCKING_LAYOUT_SCHEMA_VERSION_KEY]: DOCKING_LAYOUT_SCHEMA_VERSION,
      templateId: resolveDockLayoutTemplateId(preset),
      model: createDefaultDockLayout(preset),
    },
    preset,
  ).envelope;
}

export function createDefaultDockLayoutByPreset(): DockLayoutByPreset {
  return {
    desktop: createDefaultEnvelope("desktop"),
    tablet: createDefaultEnvelope("tablet"),
    mobile: createDefaultEnvelope("mobile"),
  };
}

export interface DockLayoutParseContext {
  preset: DockResponsivePreset;
  fallbackTemplateId: DockLayoutTemplateId;
  candidateTemplateId: DockLayoutTemplateId;
}

interface InternalParseResult {
  model: DockLayoutModel;
  reasons: string[];
  schemaVersion: number;
  templateId: DockLayoutTemplateId;
  wasRecovered: boolean;
  lastRepairReason: string | null;
  changed: boolean;
}

type DockLayoutTreeNode = IJsonRowNode | IJsonTabSetNode;
type DockLayoutAnyNode = DockLayoutTreeNode | IJsonBorderNode | IJsonTabNode;

function isTabNode(node: DockLayoutAnyNode): node is IJsonTabNode {
  return node.type === "tab";
}

function isTabSetNode(node: DockLayoutAnyNode): node is IJsonTabSetNode {
  return node.type === "tabset";
}

function isTreeNode(node: DockLayoutAnyNode): node is DockLayoutTreeNode {
  return node.type === "row" || node.type === "tabset";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowUnixMs(): number {
  return Date.now();
}

function normalizeTemplateId(raw: unknown): DockLayoutTemplateId | null {
  if (!isString(raw)) return null;
  const known = [
    "default-desktop",
    "default-tablet",
    "default-mobile",
    "analysis-heavy",
    "inspector-focus",
    "compact-inspector",
  ] as const;
  return known.includes(raw as DockLayoutTemplateId) ? (raw as DockLayoutTemplateId) : null;
}

function isJsonModel(value: unknown): value is IJsonModel {
  if (!isPlainObject(value)) {
    return false;
  }

  const model = value as Record<string, unknown>;
  if (!isPlainObject(model.layout) || !Array.isArray((model.borders as unknown[] | undefined) ?? [])) {
    return false;
  }
  return true;
}

function collectTabComponents(model: IJsonModel): Set<string> {
  const found = new Set<string>();

  const visit = (value: unknown): void => {
    if (!isPlainObject(value)) {
      return;
    }
    const candidate = value as Record<string, unknown> & { type?: string };
    if (candidate.type === "tab" && isString(candidate.component)) {
      found.add(candidate.component);
    }
    const children = Array.isArray(candidate.children) ? candidate.children : null;
    if (!children) return;
    for (const child of children) {
      visit(child);
    }
  };

  visit(model.layout);
  if (Array.isArray(model.borders)) {
    for (const border of model.borders) {
      visit(border);
    }
  }

  return found;
}

function clampNodeMinSizes(node: DockLayoutTreeNode): boolean {
  let changed = false;
  if (isTabSetNode(node)) {
    const firstChild = node.children[0];
    const component = firstChild && isTabNode(firstChild) && isString(firstChild.component)
      ? (firstChild.component as DockPanelComponent)
      : null;
    const minWidth =
      component === "dock-left"
        ? DOCKING_MIN_WIDTH_LEFT
        : component === "dock-right"
          ? DOCKING_MIN_WIDTH_RIGHT
          : component === "dock-center"
            ? DOCKING_MIN_WIDTH_CENTER
            : undefined;

    const minHeight = component === "dock-bottom" ? DOCKING_MIN_HEIGHT_BOTTOM : undefined;

    if (isNumber(minWidth) && (!isNumber(node.minWidth) || node.minWidth < minWidth)) {
      node.minWidth = minWidth;
      changed = true;
    }
    if (isNumber(minHeight) && (!isNumber(node.minHeight) || node.minHeight < minHeight)) {
      node.minHeight = minHeight;
      changed = true;
    }
  }

  if (isNumber(node.weight) && node.weight <= 0) {
    node.weight = 100;
    changed = true;
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isTreeNode(child) && clampNodeMinSizes(child)) {
        changed = true;
      }
    }
  }

  return changed;
}

function ensureGlobalDefaults(model: IJsonModel, templateModel: IJsonModel): IJsonModel {
  const next = cloneJson(model);
  next.global = {
    ...templateModel.global,
    ...(next.global as Record<string, unknown>),
  };
  return next;
}

function recoverFromTemplate(model: IJsonModel, templateModel: IJsonModel, reasons: string[]): IJsonModel {
  const merged = mergeTemplatePreservingPanels(model, templateModel);
  reasons.push("Repaired missing required dock panels by template fallback.");
  return merged;
}

function buildTabSetFromTemplate(templateModel: IJsonModel, component: DockPanelComponent): IJsonTabSetNode | null {
  const nodes = collectTemplateNodes(templateModel);
  const hit = nodes.find(
    (node): node is IJsonTabSetNode =>
      isTabSetNode(node) && node.children.some((child) => child.component === component),
  );
  return hit ? cloneJson(hit) : null;
}

function collectTemplateNodes(model: IJsonModel): DockLayoutAnyNode[] {
  const nodes: DockLayoutAnyNode[] = [];

  const visit = (node: DockLayoutAnyNode | IJsonModel): void => {
    if ("layout" in node) {
      visit(node.layout);
      for (const border of node.borders ?? []) {
        visit(border);
      }
      return;
    }

    nodes.push(node);
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (isTabNode(child)) {
          nodes.push(child);
          continue;
        }
        visit(child);
      }
    }
  };

  visit(model);
  return nodes;
}

function injectCenterPanelIntoLayout(model: IJsonModel, replacement: IJsonTabSetNode | null): boolean {
  if (!replacement) return false;
  if (!isPlainObject(model.layout) || model.layout.type !== "row" || !Array.isArray(model.layout.children)) {
    return false;
  }

  const children = model.layout.children;
  if (children.length === 0) {
    children.push(cloneJson(replacement));
    return true;
  }

  children.push(cloneJson(replacement));
  return true;
}

function mergeTemplatePreservingPanels(model: IJsonModel, templateModel: IJsonModel): IJsonModel {
  const template = cloneJson(templateModel);
  const active = cloneJson(model);
  const activeComponents = collectTabComponents(active);

  const required = REQUIRED_DOCK_PANEL_COMPONENTS.filter((component) => !activeComponents.has(component));
  if (required.length === 0) {
    return active;
  }

  const byComponent = new Map<DockPanelComponent, IJsonTabSetNode | null>(
    REQUIRED_DOCK_PANEL_COMPONENTS.map((component) => [
      component,
      buildTabSetFromTemplate(templateModel, component),
    ]),
  );

  const next = active;
  const borders = Array.isArray(next.borders) ? next.borders : [];
  const existingByComponent = new Map<string, IJsonBorderNode | null>();
  for (const border of borders) {
    if (!isPlainObject(border) || border.type !== "border") continue;
    const borderNode = border as IJsonBorderNode;
    const firstChild = borderNode.children?.[0];
    if (isPlainObject(firstChild) && firstChild.type === "tab" && isString(firstChild.component)) {
      existingByComponent.set(firstChild.component, borderNode);
    }
  }

  for (const component of required) {
    const replacement = byComponent.get(component);
    if (!replacement) continue;

    if (existingByComponent.has(component)) {
      continue;
    }

    if (component === "dock-left") {
      const location = "left";
      const candidate = byComponent.get(component);
      if (!candidate) continue;
      const border: IJsonBorderNode = {
        type: "border",
        location,
        size: candidate.minWidth ?? DOCKING_MIN_WIDTH_LEFT,
        minSize: DOCKING_MIN_WIDTH_LEFT,
        children: [
          {
            type: "tab",
            id: candidate.children?.[0]?.id ?? `${component}-tab`,
            name: candidate.children?.[0]?.name ?? "Explorer",
            component,
            enableClose: false,
            enableDrag: false,
          },
        ],
      };
      borders.push(border);
      continue;
    }

    if (component === "dock-right") {
      const border: IJsonBorderNode = {
        type: "border",
        location: "right",
        size: replacement.minWidth ?? DOCKING_MIN_WIDTH_RIGHT,
        minSize: DOCKING_MIN_WIDTH_RIGHT,
        children: [
          {
            type: "tab",
            id: replacement.children?.[0]?.id ?? `${component}-tab`,
            name: replacement.children?.[0]?.name ?? "Inspector",
            component,
            enableClose: false,
            enableDrag: false,
          },
        ],
      };
      borders.push(border);
      continue;
    }

    if (component === "dock-center") {
      const inserted = injectCenterPanelIntoLayout(next, replacement);
      if (inserted) {
        continue;
      }
      return template;
    }

    const border: IJsonBorderNode = {
      type: "border",
      location: "bottom",
      size: replacement.minHeight ?? DOCKING_MIN_HEIGHT_BOTTOM,
      minSize: DOCKING_MIN_HEIGHT_BOTTOM,
      children: [
        {
          type: "tab",
          id: replacement.children?.[0]?.id ?? `${component}-tab`,
          name: replacement.children?.[0]?.name ?? "Telemetry",
          component,
          enableClose: false,
          enableDrag: false,
        },
      ],
    };
    borders.push(border);
  }

  next.borders = borders;

  return next;
}

function normalizeCandidateJson(value: unknown, preset: DockResponsivePreset): InternalParseResult {
  const fallbackTemplateId = resolveDockLayoutTemplateId(preset);
  if (!isPlainObject(value)) {
    return {
      model: createDefaultDockLayout(preset),
      reasons: ["Invalid dock layout storage shape. Replaced by default template."],
      schemaVersion: DOCKING_LAYOUT_SCHEMA_VERSION,
      templateId: fallbackTemplateId,
      wasRecovered: true,
      lastRepairReason: "Invalid dock layout storage shape.",
      changed: true,
    };
  }

  const envelope = value as {
    [DOCKING_LAYOUT_SCHEMA_VERSION_KEY]?: unknown;
    templateId?: unknown;
    model?: unknown;
    wasRecovered?: unknown;
    lastRepairAtUnixMs?: unknown;
    lastRepairReason?: unknown;
  };

  const payload =
    isJsonModel(envelope.model) && isNumber(envelope[DOCKING_LAYOUT_SCHEMA_VERSION_KEY])
      ? envelope
      : isJsonModel(envelope)
        ? { model: envelope }
        : null;

  if (!payload || !isJsonModel(payload.model)) {
    return {
      model: createDefaultDockLayout(preset),
      reasons: ["Missing dock layout payload. Replaced by default template."],
      schemaVersion: DOCKING_LAYOUT_SCHEMA_VERSION,
      templateId: fallbackTemplateId,
      wasRecovered: true,
      lastRepairReason: "Missing dock layout payload.",
      changed: true,
    };
  }

  const candidateVersion =
    isNumber(payload[DOCKING_LAYOUT_SCHEMA_VERSION_KEY]) ? payload[DOCKING_LAYOUT_SCHEMA_VERSION_KEY] : null;
  const candidateTemplate = normalizeTemplateId(payload.templateId) ?? fallbackTemplateId;
  const templateModel = getDockLayoutTemplate(candidateTemplate).model;

  const reasons: string[] = [];
  let changed = false;

  const model = ensureGlobalDefaults(payload.model as IJsonModel, templateModel);
  const normalizedModel = cloneJson(model);

  const components = collectTabComponents(normalizedModel);
  const missing = REQUIRED_DOCK_PANEL_COMPONENTS.filter((component) => !components.has(component));
  if (missing.length > 0) {
    missing.forEach((component) => {
      reasons.push(`Missing required panel: ${component}`);
    });
    changed = true;
    const recovered = recoverFromTemplate(normalizedModel, templateModel, reasons);
    if (recovered) {
      return {
        model: recovered,
        reasons,
        schemaVersion: DOCKING_LAYOUT_SCHEMA_VERSION,
        templateId: candidateTemplate,
        wasRecovered: true,
        lastRepairReason: "Missing required docking panels.",
        changed: true,
      };
    }
  }

  const clamped = cloneJson(normalizedModel) as IJsonModel;
  if (clampNodeMinSizes(clamped.layout)) {
    reasons.push("Clamped layout min-size constraints to safe values.");
    changed = true;
  }

  if (Array.isArray(clamped.borders) && clamped.borders.some((border) => border.location === "bottom")) {
    let touched = false;
    for (const border of clamped.borders) {
      if (!isPlainObject(border)) {
        continue;
      }
      if (isNumber(border.size) && isNumber(border.minSize) && border.size < border.minSize) {
        border.size = border.minSize;
        touched = true;
      }
    }
    if (touched) {
      reasons.push("Clamped border sizes to satisfy min-size guardrails.");
      changed = true;
    }
  }

  if (!isNumber(candidateVersion) || candidateVersion < DOCKING_LAYOUT_SCHEMA_VERSION) {
    reasons.push("Schema migration applied to current docking version.");
    changed = true;
  }

  const lastRepairReason =
    reasons.length > 0 ? reasons[reasons.length - 1] ?? "Recovered layout." : null;

  return {
    model: clamped,
    reasons,
    schemaVersion: DOCKING_LAYOUT_SCHEMA_VERSION,
    templateId: candidateTemplate,
    wasRecovered: reasons.length > 0 || candidateVersion == null || candidateVersion < DOCKING_LAYOUT_SCHEMA_VERSION,
    lastRepairReason,
    changed,
  };
}

/**
 * Lightweight normalizer for a live FlexLayout runtime model — called on every
 * `FlexLayout.onModelChange` event.  Unlike `normalizeDockLayoutEnvelope`, this
 * function intentionally does NOT check for `dockingLayoutSchemaVersion` so that
 * a normal `Model.toJson()` output is never treated as a schema-migration target.
 *
 * Only genuine structural problems (missing required panels, violated min-sizes)
 * set `changed = true`.
 */
export interface DockLayoutRuntimeModelResult {
  model: DockLayoutModel;
  changed: boolean;
  repairReasons: string[];
}

export function normalizeDockLayoutRuntimeModel(
  rawModel: IJsonModel,
  preset: DockResponsivePreset,
): DockLayoutRuntimeModelResult {
  const fallbackTemplateId = resolveDockLayoutTemplateId(preset);
  const templateModel = getDockLayoutTemplate(fallbackTemplateId).model;
  const reasons: string[] = [];
  let changed = false;

  // Merge template global defaults without marking it as a change.
  let model: IJsonModel = ensureGlobalDefaults(rawModel, templateModel);

  // Check for missing required panels — structural repair only.
  const components = collectTabComponents(model);
  const missing = REQUIRED_DOCK_PANEL_COMPONENTS.filter((c) => !components.has(c));
  if (missing.length > 0) {
    for (const component of missing) {
      reasons.push(`Missing required panel: ${component}`);
    }
    changed = true;
    model = recoverFromTemplate(cloneJson(model), templateModel, reasons) as IJsonModel;
  }

  // Clamp min-size constraints.
  const clamped = cloneJson(model) as IJsonModel;
  if (clampNodeMinSizes(clamped.layout)) {
    reasons.push("Clamped layout min-size constraints to safe values.");
    changed = true;
  }

  // Clamp border sizes.
  if (Array.isArray(clamped.borders)) {
    let touched = false;
    for (const border of clamped.borders) {
      if (isPlainObject(border) && isNumber(border.size) && isNumber(border.minSize) && (border.size as number) < (border.minSize as number)) {
        (border as Record<string, unknown>).size = border.minSize;
        touched = true;
      }
    }
    if (touched) {
      reasons.push("Clamped border sizes to satisfy min-size guardrails.");
      changed = true;
    }
  }

  return { model: changed ? clamped : model, changed, repairReasons: reasons };
}

export function normalizeDockLayoutEnvelope(
  raw: unknown,
  preset: DockResponsivePreset,
): DockLayoutEnvelopeResult {
  const resolved = normalizeCandidateJson(raw, preset);
  return {
    envelope: {
      dockingLayoutSchemaVersion: resolved.schemaVersion,
      templateId: resolved.templateId,
      model: resolved.model,
      lastRepairReason: resolved.lastRepairReason,
      lastRepairAtUnixMs: resolved.wasRecovered ? nowUnixMs() : null,
      wasRecovered: resolved.wasRecovered,
    },
    repairReasons: resolved.reasons,
    changed: resolved.changed,
  };
}

export function buildDockLayoutEnvelopeForModel(
  rawModel: unknown,
  preset: DockResponsivePreset,
): DockLayoutEnvelope {
  const result = normalizeDockLayoutEnvelope(rawModel, preset);
  return {
    ...result.envelope,
    wasRecovered: false,
    lastRepairAtUnixMs: null,
    lastRepairReason: result.envelope.lastRepairReason,
  };
}

export function parseDockLayoutRecordForPreset(
  raw: unknown,
  preset: DockResponsivePreset,
): DockLayoutEnvelope {
  const result = normalizeDockLayoutEnvelope(raw, preset);
  return result.envelope;
}

export function parseDockLayoutByPreset(raw: unknown): DockLayoutByPreset {
  const candidate = isPlainObject(raw)
    ? (raw as Record<string, unknown>)
    : {
        desktop: null,
        tablet: null,
        mobile: null,
      };

  const normalize = (value: unknown, preset: DockResponsivePreset): DockLayoutEnvelope => {
    const resolved = normalizeDockLayoutEnvelope(value, preset);
    return resolved.envelope;
  };

  return {
    desktop: normalize(candidate.desktop ?? null, "desktop"),
    tablet: normalize(candidate.tablet ?? null, "tablet"),
    mobile: normalize(candidate.mobile ?? null, "mobile"),
  };
}

export function resolveDockResponsivePresetSafe(width: number): DockResponsivePreset {
  return resolveDockResponsivePreset(width);
}
