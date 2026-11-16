import type {
  AuthoringTransactionResponse,
  MaskFieldDriveListResource,
  MaskFieldDriveResource,
  MaskFunctionResource,
  MaskTermResource,
  ReadyAntennaResource,
  RequestOptions,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

/**
 * Hand-written mask antenna (`mask_field_drive.v1`): pure authoring helpers of
 * the inspector panel. Equations are text; the server compiles and checks them.
 */

export const MASK_FIELD_DRIVE_SCHEMA_VERSION = "mask_field_drive.v1";
export const FIELD_EXPRESSION_VERSION = "field_expr.v1";
export const MAX_MASK_TERMS = 8;

export type MaskFunctionRole = "mask" | "time";
export type MaskShapeKind = MaskFieldDriveResource["shape"]["kind"];

export interface MaskAntennaPanelModel {
  drive: MaskFieldDriveResource | null;
  driveId: string | null;
  mode: "create" | "found" | "missing" | "unselected";
  sceneRevision: number | null;
}

/** Terms of one ready-antenna call (`origin.call_index`), in term order. */
export interface ReadyAntennaCall {
  arguments: Record<string, number>;
  callIndex: number;
  function: string;
  termIndices: number[];
}

interface MaskAntennaMutationApi {
  createMaskFieldDrive(
    request: { base_revision: number; drive: MaskFieldDriveResource },
    options?: RequestOptions,
  ): Promise<AuthoringTransactionResponse>;
  replaceMaskFieldDrive(
    driveId: string,
    request: { base_revision: number; drive: MaskFieldDriveResource },
    options?: RequestOptions,
  ): Promise<AuthoringTransactionResponse>;
}

export function resolveMaskAntennaPanelModel(
  selection: Selection,
  resource: MaskFieldDriveListResource | null,
  takenIds: readonly string[] = [],
): MaskAntennaPanelModel {
  const ref = selection.ref?.type === "physics-field-drive" ? selection.ref : null;
  if (ref?.draft === true) {
    return {
      drive: resource
        ? createMaskAntennaDraft(
            [...resource.drives.map((drive) => drive.id), ...takenIds],
            ref.sourceObjectId,
          )
        : null,
      driveId: null,
      mode: "create",
      sceneRevision: resource?.scene_revision ?? null,
    };
  }
  const driveId = ref?.fieldDriveId ?? null;
  if (!driveId) {
    return { drive: null, driveId: null, mode: "unselected", sceneRevision: null };
  }
  const drive = resource?.drives.find((candidate) => candidate.id === driveId) ?? null;
  return {
    drive,
    driveId,
    mode: drive ? "found" : "missing",
    sceneRevision: resource?.scene_revision ?? null,
  };
}

/** A time function `sin(2 pi f t)` with the frequency as its parameter. */
export function defaultTimeFunction(): MaskFunctionResource {
  return {
    expression_version: FIELD_EXPRESSION_VERSION,
    name: "sine",
    outputs: ["sin(2 * pi * f * t)"],
    parameters: [{ name: "f", value: 1e9 }],
  };
}

/** A uniform mask `(0, 0, B)` times `sin(2 pi f t)`. */
export function defaultMaskTerm(): MaskTermResource {
  return {
    mask: {
      function: {
        expression_version: FIELD_EXPRESSION_VERSION,
        name: "uniform_z",
        outputs: ["0.0", "0.0", "B"],
        parameters: [{ name: "B", value: 1e-3 }],
      },
      kind: "function",
    },
    time: defaultTimeFunction(),
  };
}

export function createMaskAntennaDraft(
  takenIds: readonly string[],
  targetObjectId?: string,
): MaskFieldDriveResource {
  const ids = new Set(takenIds);
  let id = "mask-antenna";
  let suffix = 2;
  while (ids.has(id)) {
    id = `mask-antenna-${suffix}`;
    suffix += 1;
  }
  return {
    activation: { kind: "all_time_evolution" },
    enabled: true,
    frame: "world",
    id,
    name: suffix > 2 ? `Mask antenna ${suffix - 1}` : "Mask antenna",
    position_m: [0, 0, 0],
    schema_version: MASK_FIELD_DRIVE_SCHEMA_VERSION,
    shape: { center: [0, 0, 0], kind: "box", size: [1e-7, 1e-7, 1e-7] },
    target: targetObjectId
      ? { kind: "object", object_id: targetObjectId }
      : { kind: "global" },
    terms: [defaultMaskTerm()],
    time_origin: "stage_local",
  };
}

export function defaultMaskShape(kind: MaskShapeKind): MaskFieldDriveResource["shape"] {
  if (kind === "cylinder") {
    return { axis: [0, 0, 1], center: [0, 0, 0], height: 1e-7, kind, radius: 5e-8 };
  }
  if (kind === "sphere") return { center: [0, 0, 0], kind, radius: 5e-8 };
  return { center: [0, 0, 0], kind: "box", size: [1e-7, 1e-7, 1e-7] };
}

/** The function of a term in one role; `null` for an array mask or a static term. */
export function termFunction(
  term: MaskTermResource,
  role: MaskFunctionRole,
): MaskFunctionResource | null {
  if (role === "time") return term.time ?? null;
  return term.mask.kind === "function" ? term.mask.function : null;
}

/**
 * Replace one term. A changed term no longer equals the output of the ready
 * antenna that produced it, so its origin is removed (as an Update does).
 */
export function updateTerm(
  drive: MaskFieldDriveResource,
  termIndex: number,
  update: (term: MaskTermResource) => MaskTermResource,
): MaskFieldDriveResource {
  return {
    ...drive,
    terms: drive.terms.map((term, index) => {
      if (index !== termIndex) return term;
      const { origin: _origin, ...updated } = update(term);
      return updated;
    }),
  };
}

function withTermFunction(
  term: MaskTermResource,
  role: MaskFunctionRole,
  update: (value: MaskFunctionResource) => MaskFunctionResource,
): MaskTermResource {
  if (role === "time") {
    return term.time ? { ...term, time: update(term.time) } : term;
  }
  return term.mask.kind === "function"
    ? { ...term, mask: { ...term.mask, function: update(term.mask.function) } }
    : term;
}

export function setTermParameter(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
  value: number,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) =>
    withTermFunction(term, role, (target) => ({
      ...target,
      parameters: (target.parameters ?? []).map((parameter) =>
        parameter.name === name ? { name, value } : parameter,
      ),
    })),
  );
}

export function setTermOutput(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  outputIndex: number,
  expression: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) =>
    withTermFunction(term, role, (target) => ({
      ...target,
      outputs: target.outputs.map((output, index) =>
        index === outputIndex ? expression : output,
      ),
    })),
  );
}

export function setTermLocal(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  localIndex: number,
  expression: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) =>
    withTermFunction(term, role, (target) => ({
      ...target,
      locals: (target.locals ?? []).map((local, index) =>
        index === localIndex ? { ...local, expression } : local,
      ),
    })),
  );
}

/** Add a parameter with a free name; equations may then refer to it. */
export function addTermParameter(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) =>
    withTermFunction(term, role, (target) =>
      (target.parameters ?? []).some((parameter) => parameter.name === name)
        ? target
        : { ...target, parameters: [...(target.parameters ?? []), { name, value: 0 }] },
    ),
  );
}

export function removeTermParameter(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) =>
    withTermFunction(term, role, (target) => ({
      ...target,
      parameters: (target.parameters ?? []).filter((parameter) => parameter.name !== name),
    })),
  );
}

/** Static term (time factor 1) or a term with the default time function. */
export function setTermStatic(
  drive: MaskFieldDriveResource,
  termIndex: number,
  isStatic: boolean,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) => {
    if (isStatic) {
      const { time: _time, ...rest } = term;
      return rest;
    }
    return term.time ? term : { ...term, time: defaultTimeFunction() };
  });
}

export function setTermName(
  drive: MaskFieldDriveResource,
  termIndex: number,
  name: string,
): MaskFieldDriveResource {
  // The name only labels the term; the ready-antenna origin stays.
  return {
    ...drive,
    terms: drive.terms.map((term, index) => {
      if (index !== termIndex) return term;
      if (name.trim().length === 0) {
        const { name: _name, ...rest } = term;
        return rest;
      }
      return { ...term, name };
    }),
  };
}

export function addTerm(drive: MaskFieldDriveResource): MaskFieldDriveResource {
  return drive.terms.length >= MAX_MASK_TERMS
    ? drive
    : { ...drive, terms: [...drive.terms, defaultMaskTerm()] };
}

export function removeTerm(
  drive: MaskFieldDriveResource,
  termIndex: number,
): MaskFieldDriveResource {
  return { ...drive, terms: drive.terms.filter((_, index) => index !== termIndex) };
}

/** The ready-antenna calls of the antenna, in order of their first term. */
export function readyAntennaCalls(drive: MaskFieldDriveResource): ReadyAntennaCall[] {
  const calls = new Map<number, ReadyAntennaCall>();
  drive.terms.forEach((term, index) => {
    const origin = term.origin;
    if (!origin) return;
    const existing = calls.get(origin.call_index);
    if (existing) {
      existing.termIndices.push(index);
    } else {
      calls.set(origin.call_index, {
        arguments: { ...origin.arguments },
        callIndex: origin.call_index,
        function: origin.function,
        termIndices: [index],
      });
    }
  });
  return [...calls.values()];
}

/**
 * Put the terms a ready antenna returned in place of one call's terms (or at
 * the end for a new call). Term names of replaced terms are kept by position.
 */
export function replaceReadyAntennaCall(
  drive: MaskFieldDriveResource,
  callIndex: number | null,
  terms: readonly MaskTermResource[],
): MaskFieldDriveResource {
  const calls = readyAntennaCalls(drive);
  const existing = callIndex === null
    ? null
    : calls.find((call) => call.callIndex === callIndex) ?? null;
  const resolvedCallIndex = existing?.callIndex ??
    calls.reduce((next, call) => Math.max(next, call.callIndex + 1), 0);
  const replaced = new Set(existing?.termIndices ?? []);
  const names = (existing?.termIndices ?? []).map((index) => drive.terms[index]?.name);
  const incoming = terms.map((term, index) => ({
    ...term,
    ...(names[index] ? { name: names[index] } : {}),
    ...(term.origin ? { origin: { ...term.origin, call_index: resolvedCallIndex } } : {}),
  }));
  const insertAt = existing ? existing.termIndices[0] : drive.terms.length;
  const kept = drive.terms.filter((_, index) => !replaced.has(index));
  const offset = [...replaced].filter((index) => index < insertAt).length;
  const position = insertAt - offset;
  return {
    ...drive,
    terms: [...kept.slice(0, position), ...incoming, ...kept.slice(position)],
  };
}

/** Arguments of a ready antenna with the registry defaults filled in. */
export function readyAntennaDefaultArguments(
  antenna: ReadyAntennaResource,
): Record<string, number> {
  return Object.fromEntries(
    antenna.arguments.flatMap((argument) =>
      typeof argument.default === "number" ? [[argument.name, argument.default]] : [],
    ),
  );
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Parameter and local names become Python names in the exported script.
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

function isScriptName(name: string): boolean {
  return IDENTIFIER.test(name) && !PYTHON_KEYWORDS.has(name);
}

/** Local checks only; the server validates every equation and the target. */
export function validateMaskAntennaDraft(drive: MaskFieldDriveResource): string[] {
  const errors: string[] = [];
  if (drive.id.trim().length === 0) errors.push("The antenna needs an ID.");
  if (drive.name.trim().length === 0) errors.push("The antenna needs a name.");
  if (drive.target.kind !== "global" && drive.target.object_id.length === 0) {
    errors.push("Select the target object.");
  }
  if (drive.target.kind === "region" && drive.target.region_id.length === 0) {
    errors.push("Select the target region.");
  }
  if (!drive.position_m.every(Number.isFinite)) errors.push("The position must be finite.");
  const shape = drive.shape;
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (shape.kind === "box" && !shape.size.every(positive)) {
    errors.push("The box size must be positive.");
  }
  if (shape.kind === "cylinder" && !(positive(shape.radius) && positive(shape.height))) {
    errors.push("The cylinder radius and height must be positive.");
  }
  if (shape.kind === "sphere" && !positive(shape.radius)) {
    errors.push("The sphere radius must be positive.");
  }
  if (drive.terms.length === 0 || drive.terms.length > MAX_MASK_TERMS) {
    errors.push(`An antenna needs 1 to ${MAX_MASK_TERMS} terms.`);
  }
  const names = new Set<string>();
  drive.terms.forEach((term, index) => {
    const label = `Term ${index + 1}`;
    if (term.name) {
      if (!IDENTIFIER.test(term.name)) errors.push(`${label}: the name must be an identifier.`);
      if (names.has(term.name)) errors.push(`${label}: the name is used by another term.`);
      names.add(term.name);
    }
    for (const role of ["mask", "time"] as const) {
      const target = termFunction(term, role);
      if (!target) continue;
      if (target.outputs.some((output) => output.trim().length === 0)) {
        errors.push(`${label}: every ${role} equation needs an expression.`);
      }
      for (const parameter of target.parameters ?? []) {
        if (!isScriptName(parameter.name)) {
          errors.push(
            `${label}: parameter '${parameter.name}' must be an identifier that is not a Python keyword.`,
          );
        }
        if (!Number.isFinite(parameter.value)) {
          errors.push(`${label}: parameter '${parameter.name}' must be a finite number.`);
        }
      }
    }
  });
  return errors;
}

/** One line for lists: the kind of every term. */
export function maskAntennaSummary(drive: MaskFieldDriveResource): string {
  const ready = readyAntennaCalls(drive).length;
  const arrays = drive.terms.filter((term) => term.mask.kind === "sampled").length;
  const parts = [`${drive.terms.length} term${drive.terms.length === 1 ? "" : "s"}`];
  if (ready > 0) parts.push(`${ready} ready antenna${ready === 1 ? "" : "s"}`);
  if (arrays > 0) parts.push(`${arrays} array mask${arrays === 1 ? "" : "s"}`);
  parts.push(drive.enabled === false ? "disabled" : "active");
  return parts.join(" · ");
}

export function commitMaskAntenna(
  api: MaskAntennaMutationApi,
  mode: "create" | "found",
  baseRevision: number,
  drive: MaskFieldDriveResource,
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  const request = { base_revision: baseRevision, drive };
  return mode === "create"
    ? api.createMaskFieldDrive(request, options)
    : api.replaceMaskFieldDrive(drive.id, request, options);
}
