/**
 * Conservative MuMax3 (.mx3) to canonical Fullmag Python translator.
 *
 * Pure text in, text out: nothing is read from or written to disk, and nothing
 * is executed. The translator maps a deliberately small subset of mumax3 whose
 * meaning is the same in Fullmag (SI units on both sides). Every statement it
 * does not map is returned in `unsupported` with its line and a reason, and is
 * repeated in a comment block at the top of the generated script. Physics is
 * never dropped silently.
 */

export interface Mx3Unsupported {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface Mx3Translation {
  /** Canonical Fullmag Python (stage-first study API). Always syntactically valid. */
  readonly script: string;
  /** One entry per translated statement, as `L<line>: <statement>`. */
  readonly supported: string[];
  readonly unsupported: Mx3Unsupported[];
  /**
   * False when mandatory input (mesh, material, initial state or a run) is
   * missing. The script is then a stub that stops with a message instead of
   * running a different problem.
   */
  readonly runnable: boolean;
  readonly blockers: string[];
}

export interface Mx3TranslateOptions {
  /** Study name written into the script. Defaults to `mx3_import`. */
  readonly studyName?: string;
}

type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Lexical preparation
// ---------------------------------------------------------------------------

interface Statement {
  readonly line: number;
  readonly text: string;
}

/** Removes comments (keeping line structure) and returns code per line. */
function stripComments(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    let result = "";
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (inString) {
        result += ch;
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        result += ch;
      } else if (ch === "/" && next === "/") {
        break;
      } else if (ch === "/" && next === "*") {
        inBlock = true;
        i += 1;
      } else {
        result += ch;
      }
    }
    out.push(result);
  }
  return out;
}

/** Joins multi-line calls and splits `;`-separated statements. */
function assembleStatements(codeLines: readonly string[]): Statement[] {
  const statements: Statement[] = [];
  let buffer = "";
  let startLine = 0;
  let paren = 0;
  const flush = () => {
    const text = buffer.trim();
    if (text) statements.push({ line: startLine, text });
    buffer = "";
    paren = 0;
  };
  codeLines.forEach((code, index) => {
    const lineNumber = index + 1;
    let inString = false;
    for (const ch of code) {
      if (buffer.trim() === "" && !inString) startLine = lineNumber;
      if (ch === '"') inString = !inString;
      if (!inString) {
        if (ch === "(") paren += 1;
        if (ch === ")") paren -= 1;
        if (ch === ";" && paren <= 0 && !/^(for|if|switch|func|else)\b/.test(buffer.trim())) {
          flush();
          continue;
        }
      }
      buffer += ch;
    }
    if (paren <= 0) {
      flush();
    } else {
      buffer += " ";
    }
  });
  flush();
  return statements;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type Variables = ReadonlyMap<string, number>;

const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["pi", Math.PI],
  ["mu0", 4e-7 * Math.PI],
]);

class ExpressionError extends Error {}

/** Numbers, variables, + - * / and parentheses. Anything else is refused. */
function evaluate(expression: string, variables: Variables): number {
  const tokens = expression.match(/\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\S/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  const atom = (): number => {
    const token = take();
    if (token === undefined) throw new ExpressionError("incomplete expression");
    if (token === "(") {
      const value = sum();
      if (take() !== ")") throw new ExpressionError("unbalanced parentheses");
      return value;
    }
    if (/^(\d|\.\d)/.test(token)) return Number(token);
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") throw new ExpressionError(`function call ${token}(...) is not translated`);
      const key = token.toLowerCase();
      const value = variables.get(token) ?? variables.get(key) ?? CONSTANTS.get(key);
      if (value === undefined) throw new ExpressionError(`${token} is not a known number`);
      return value;
    }
    throw new ExpressionError(`unexpected "${token}"`);
  };
  const unary = (): number => {
    if (peek() === "-") {
      take();
      return -unary();
    }
    if (peek() === "+") {
      take();
      return unary();
    }
    return atom();
  };
  const product = (): number => {
    let value = unary();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const rhs = unary();
      if (op === "/" && rhs === 0) throw new ExpressionError("division by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      value = take() === "+" ? value + product() : value - product();
    }
    return value;
  };

  const result = sum();
  if (position !== tokens.length) throw new ExpressionError(`unexpected "${tokens[position]}"`);
  if (!Number.isFinite(result)) throw new ExpressionError("the value is not finite");
  return result;
}

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "" || parts.length > 0) parts.push(current.trim());
  return parts;
}

interface Call {
  readonly name: string;
  readonly args: string[];
}

/** `Name(a, b)` where the first "(" closes at the very end of the text. */
function parseCall(text: string): Call | null {
  const match = /^([A-Za-z_][\w.]*)\s*\(/.exec(text);
  if (!match) return null;
  const open = match[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        if (i !== text.length - 1) return null;
        return { name: match[1], args: splitArguments(text.slice(open + 1, i)) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Python emission helpers
// ---------------------------------------------------------------------------

function py(value: number): string {
  const rounded = Number(value.toPrecision(12));
  if (Object.is(rounded, -0) || rounded === 0) return "0.0";
  const text = String(rounded);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const pyVec = (v: Vec3) => `(${v.map(py).join(", ")})`;

function pyString(value: string): string {
  return JSON.stringify(value);
}

function shorten(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Translation model
// ---------------------------------------------------------------------------

type Geometry =
  | { readonly kind: "cuboid"; readonly size: Vec3 }
  | { readonly kind: "cylinder"; readonly diameter: number; readonly height: number }
  | { readonly kind: "circle"; readonly diameter: number }
  | { readonly kind: "rect"; readonly a: number; readonly b: number };

type Texture =
  | { readonly kind: "uniform"; readonly value: Vec3 }
  | { readonly kind: "random" }
  | { readonly kind: "vortex"; readonly circulation: number; readonly polarity: number };

type Step =
  | { readonly kind: "b_ext"; readonly value: Vec3 }
  | { readonly kind: "relax" }
  | { readonly kind: "run"; readonly time: number }
  | { readonly kind: "autosave_m"; readonly every: number }
  | { readonly kind: "table"; readonly every: number };

interface Material {
  Ms?: number;
  Aex?: number;
  alpha?: number;
  Ku1?: number;
  Dind?: number;
  anisU?: Vec3;
}

const MATERIAL_PARAMETERS: Readonly<Record<string, keyof Omit<Material, "anisU">>> = {
  msat: "Ms",
  aex: "Aex",
  alpha: "alpha",
  ku1: "Ku1",
  dind: "Dind",
};

const KNOWN_UNSUPPORTED_ASSIGNMENTS: Readonly<Record<string, string>> = {
  pol: "spin-transfer torque (Pol); the importer does not map current-driven torques",
  lambda: "spin-transfer torque (Lambda); the importer does not map current-driven torques",
  epsilonprime: "spin-transfer torque (EpsilonPrime); the importer does not map current-driven torques",
  xi: "spin-transfer torque (Xi); the importer does not map current-driven torques",
  j: "spin-transfer torque (current density J); the importer does not map current-driven torques",
  fixedlayer: "spin-transfer torque (FixedLayer); the importer does not map current-driven torques",
  temp: "thermal noise (Temp); the importer does not map finite-temperature dynamics",
  ku2: "higher-order anisotropy (Ku2) is not translated",
  kc1: "cubic anisotropy (Kc1) is not translated",
  kc2: "cubic anisotropy (Kc2) is not translated",
  kc3: "cubic anisotropy (Kc3) is not translated",
  anisc1: "cubic anisotropy axis (AnisC1) is not translated",
  anisc2: "cubic anisotropy axis (AnisC2) is not translated",
  dbulk: "bulk DMI (Dbulk) is not translated",
  b_exch: "Zeeman-like exchange field term is not translated",
  gammall: "a custom gyromagnetic ratio (GammaLL) is not translated",
  lambdafree: "spin-transfer torque (LambdaFree) is not translated",
  frozenspins: "frozen spins are not translated",
  edgesmooth: "EdgeSmooth (sub-cell geometry smoothing) is not translated",
  regions: "regions are not translated",
};

const KNOWN_UNSUPPORTED_CALLS: Readonly<Record<string, string>> = {
  setmesh: "SetMesh is not translated; use SetGridSize and SetCellSize",
  defregion: "regions are not translated",
  save: "a single-shot Save has no verified Fullmag mapping; use AutoSave(m, period)",
  snapshot: "Snapshot has no verified Fullmag mapping; use AutoSave(m, period)",
  tableadd: "custom table columns have no verified Fullmag mapping",
  tablesave: "a single-shot TableSave has no verified Fullmag mapping; use TableAutosave(period)",
  minimize: "Minimize() is not translated; use Relax() or write an add_minimize stage by hand",
  runwhile: "RunWhile is not translated",
  setsolver: "SetSolver is not translated; a Fullmag integrator is chosen explicitly in the script",
  fixdt: "FixDt is not translated; a Fullmag integrator is chosen explicitly in the script",
  maxerr: "MaxErr is not translated; a Fullmag integrator is chosen explicitly in the script",
  mindt: "MinDt is not translated; a Fullmag integrator is chosen explicitly in the script",
  maxdt: "MaxDt is not translated; a Fullmag integrator is chosen explicitly in the script",
  setgeom: "SetGeom needs a plain Cuboid, Cylinder, Circle or Rect",
  print: "console output only; it does not affect the physics",
  printf: "console output only; it does not affect the physics",
  println: "console output only; it does not affect the physics",
};

interface Context {
  readonly variables: Map<string, number>;
  readonly material: Material;
  readonly steps: Step[];
  grid: { value: Vec3; line: number } | null;
  cell: { value: Vec3; line: number } | null;
  pbc: { value: Vec3; line: number } | null;
  geometry: { value: Geometry; line: number } | null;
  texture: { value: Texture; line: number } | null;
  demag: boolean;
  stageStarted: boolean;
  anisUNormalised: boolean;
}

const unit = (v: Vec3): Vec3 | null => {
  const norm = Math.hypot(...v);
  return norm > 0 ? [v[0] / norm, v[1] / norm, v[2] / norm] : null;
};

function evaluateVector(text: string, variables: Variables): Vec3 {
  const call = parseCall(text);
  if (!call || call.name.toLowerCase() !== "vector" || call.args.length !== 3) {
    throw new ExpressionError("expected vector(x, y, z) with three plain numbers");
  }
  return call.args.map((arg) => evaluate(arg, variables)) as unknown as Vec3;
}

const isPositiveInteger = (n: number) => Number.isInteger(n) && n > 0;

// ---------------------------------------------------------------------------
// Statement handlers: each returns null when translated, otherwise a reason.
// ---------------------------------------------------------------------------

function handleAssignment(context: Context, name: string, rhs: string): string | null {
  const key = name.toLowerCase();
  const variables = context.variables;

  if (Object.hasOwn(MATERIAL_PARAMETERS, key)) {
    const field = MATERIAL_PARAMETERS[key];
    if (context.stageStarted) {
      return `${name} changes after the first Relax() or Run(); material changes between stages are not translated`;
    }
    const value = evaluate(rhs, variables);
    if (field === "Ms" && !(value > 0)) return "Msat must be positive";
    if (field === "Aex" && !(value > 0)) return "Aex must be positive";
    if (field === "alpha" && !(value >= 0)) return "alpha must not be negative";
    context.material[field] = value;
    return null;
  }

  if (key === "anisu") {
    if (context.stageStarted) return "AnisU changes after the first Relax() or Run(); not translated";
    const vector = evaluateVector(rhs, variables);
    const normalised = unit(vector);
    if (!normalised) return "AnisU must be a non-zero vector";
    if (Math.abs(Math.hypot(...vector) - 1) > 1e-12) context.anisUNormalised = true;
    context.material.anisU = normalised;
    return null;
  }

  if (key === "b_ext") {
    context.steps.push({ kind: "b_ext", value: evaluateVector(rhs, variables) });
    return null;
  }

  if (key === "enabledemag") {
    if (context.stageStarted) return "EnableDemag changes after the first Relax() or Run(); not translated";
    const flag = rhs.trim().toLowerCase();
    if (flag !== "true" && flag !== "false") return "EnableDemag must be true or false";
    context.demag = flag === "true";
    return null;
  }

  if (key === "m") {
    if (context.stageStarted) {
      return "m is re-initialised after the first Relax() or Run(); mid-script state changes are not translated";
    }
    const call = parseCall(rhs);
    const callName = call?.name.toLowerCase();
    if (call && callName === "uniform" && call.args.length === 3) {
      const value = call.args.map((arg) => evaluate(arg, variables)) as unknown as Vec3;
      if (!unit(value)) return "Uniform() needs a non-zero vector";
      context.texture = { value: { kind: "uniform", value }, line: 0 };
      return null;
    }
    if (call && callName === "randommag" && call.args.length === 0) {
      context.texture = { value: { kind: "random" }, line: 0 };
      return null;
    }
    if (call && callName === "vortex" && call.args.length === 2) {
      const [circulation, polarity] = call.args.map((arg) => evaluate(arg, variables));
      if (!(Math.abs(circulation) === 1 && Math.abs(polarity) === 1)) {
        return "Vortex(circulation, polarity) must use +1 or -1";
      }
      context.texture = { value: { kind: "vortex", circulation, polarity }, line: 0 };
      return null;
    }
    return "only m = Uniform(x, y, z), RandomMag() and Vortex(c, p) are translated";
  }

  if (Object.hasOwn(KNOWN_UNSUPPORTED_ASSIGNMENTS, key)) return KNOWN_UNSUPPORTED_ASSIGNMENTS[key];
  return `${name} has no verified Fullmag mapping in this importer`;
}

function handleCall(context: Context, call: Call): string | null {
  const key = call.name.toLowerCase();
  const variables = context.variables;
  const numbers = () => call.args.map((arg) => evaluate(arg, variables));

  switch (key) {
    case "setgridsize": {
      if (call.args.length !== 3) return "SetGridSize needs three integers";
      if (context.grid) return "the grid is set more than once; only the first SetGridSize is translated";
      const value = numbers() as unknown as Vec3;
      if (!value.every(isPositiveInteger)) return "SetGridSize needs positive integers";
      context.grid = { value, line: 0 };
      return null;
    }
    case "setcellsize": {
      if (call.args.length !== 3) return "SetCellSize needs three numbers";
      if (context.cell) return "the cell size is set more than once; only the first SetCellSize is translated";
      const value = numbers() as unknown as Vec3;
      if (!value.every((n) => n > 0)) return "SetCellSize needs positive sizes";
      context.cell = { value, line: 0 };
      return null;
    }
    case "setpbc": {
      if (call.args.length !== 3) return "SetPBC needs three integers";
      if (context.pbc) return "SetPBC is called more than once; only the first call is translated";
      const value = numbers() as unknown as Vec3;
      if (!value.every((n) => Number.isInteger(n) && n >= 0)) return "SetPBC needs non-negative integers";
      context.pbc = { value, line: 0 };
      return null;
    }
    case "setgeom": {
      if (context.stageStarted) return "SetGeom after the first Relax() or Run() is not translated";
      if (call.args.length !== 1) return "SetGeom needs exactly one shape";
      if (context.geometry) return "SetGeom is called more than once; only the first call is translated";
      const shape = parseCall(call.args[0]);
      if (!shape) {
        return "SetGeom needs a plain Cuboid, Cylinder, Circle or Rect; compound or transformed shapes are not translated";
      }
      const shapeKey = shape.name.toLowerCase();
      const values = shape.args.map((arg) => evaluate(arg, variables));
      if (!values.every((n) => n > 0)) return "shape dimensions must be positive";
      if (shapeKey === "cuboid" && values.length === 3) {
        context.geometry = { value: { kind: "cuboid", size: values as unknown as Vec3 }, line: 0 };
        return null;
      }
      if (shapeKey === "cylinder" && values.length === 2) {
        context.geometry = { value: { kind: "cylinder", diameter: values[0], height: values[1] }, line: 0 };
        return null;
      }
      if (shapeKey === "circle" && values.length === 1) {
        context.geometry = { value: { kind: "circle", diameter: values[0] }, line: 0 };
        return null;
      }
      if (shapeKey === "rect" && values.length === 2) {
        context.geometry = { value: { kind: "rect", a: values[0], b: values[1] }, line: 0 };
        return null;
      }
      return `${shape.name}(...) is not translated; only Cuboid, Cylinder, Circle and Rect are`;
    }
    case "relax":
      if (call.args.length !== 0) return "Relax takes no arguments";
      context.steps.push({ kind: "relax" });
      context.stageStarted = true;
      return null;
    case "run": {
      if (call.args.length !== 1) return "Run needs one duration";
      const [time] = numbers();
      if (!(time > 0)) return "Run needs a positive duration";
      context.steps.push({ kind: "run", time });
      context.stageStarted = true;
      return null;
    }
    case "autosave": {
      if (call.args.length !== 2) return "AutoSave needs a quantity and a period";
      if (call.args[0].trim().toLowerCase() !== "m") {
        return `AutoSave(${call.args[0].trim()}, ...) is not translated; only the magnetisation m is`;
      }
      const every = evaluate(call.args[1], variables);
      if (!(every > 0)) return "an AutoSave period of 0 (disable) or less is not translated";
      context.steps.push({ kind: "autosave_m", every });
      return null;
    }
    case "tableautosave": {
      if (call.args.length !== 1) return "TableAutosave needs one period";
      const every = evaluate(call.args[0], variables);
      if (!(every > 0)) return "a TableAutosave period of 0 (disable) or less is not translated";
      context.steps.push({ kind: "table", every });
      return null;
    }
    default:
      if (Object.hasOwn(KNOWN_UNSUPPORTED_CALLS, key)) return KNOWN_UNSUPPORTED_CALLS[key];
      if (key.includes(".")) {
        return `${call.name}(...) is a per-region or per-quantity call; regions and field setters are not translated`;
      }
      if (key.startsWith("ext_")) return `${call.name} is a mumax3 extension (ext_) with no Fullmag equivalent`;
      return `${call.name}(...) has no verified Fullmag mapping in this importer`;
  }
}

function translateStatement(context: Context, statement: Statement): string | null {
  const text = statement.text;
  const define = /^([A-Za-z_]\w*)\s*:=\s*(.+)$/.exec(text);
  if (define) {
    const value = evaluate(define[2], context.variables);
    context.variables.set(define[1], value);
    return null;
  }
  const assign = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(text);
  if (assign) {
    const [, name, rhs] = assign;
    const known = name.toLowerCase();
    const isParameter =
      Object.hasOwn(MATERIAL_PARAMETERS, known) ||
      Object.hasOwn(KNOWN_UNSUPPORTED_ASSIGNMENTS, known) ||
      ["anisu", "b_ext", "enabledemag", "m"].includes(known);
    if (!isParameter && context.variables.has(name)) {
      context.variables.set(name, evaluate(rhs, context.variables));
      return null;
    }
    return handleAssignment(context, name, rhs);
  }
  const call = parseCall(text);
  if (call) return handleCall(context, call);
  return "this statement is not recognised by the importer";
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

const RELAX_ARGUMENTS =
  'algorithm="llg_overdamped", tolT=1e-6, max_steps=100000, relax_alpha=1.0, solver="rk45", dt="auto", max_error=1e-5, dt_min=1e-16, dt_max=1e-11';

function geometryCode(
  geometry: Geometry,
  universe: Vec3,
): { readonly code: string } | { readonly error: string } {
  const eps = 1e-9;
  const fits = (...pairs: readonly (readonly [number, number])[]) =>
    pairs.every(([size, limit]) => size <= limit * (1 + eps));
  switch (geometry.kind) {
    case "cuboid":
      if (!fits([geometry.size[0], universe[0]], [geometry.size[1], universe[1]], [geometry.size[2], universe[2]])) {
        return { error: "the Cuboid is larger than the grid; mumax clips it, which is not translated" };
      }
      return { code: `fm.Box(size=${pyVec(geometry.size)}, name="body")` };
    case "cylinder":
      if (!fits([geometry.diameter, universe[0]], [geometry.diameter, universe[1]], [geometry.height, universe[2]])) {
        return { error: "the Cylinder is larger than the grid; mumax clips it, which is not translated" };
      }
      return { code: `fm.Cylinder(radius=${py(geometry.diameter / 2)}, height=${py(geometry.height)}, name="body")` };
    case "circle":
      if (!fits([geometry.diameter, universe[0]], [geometry.diameter, universe[1]])) {
        return { error: "the Circle is larger than the grid; mumax clips it, which is not translated" };
      }
      return { code: `fm.Cylinder(radius=${py(geometry.diameter / 2)}, height=${py(universe[2])}, name="body")` };
    case "rect":
      if (!fits([geometry.a, universe[0]], [geometry.b, universe[1]])) {
        return { error: "the Rect is larger than the grid; mumax clips it, which is not translated" };
      }
      return { code: `fm.Box(size=(${py(geometry.a)}, ${py(geometry.b)}, ${py(universe[2])}), name="body")` };
  }
}

function textureCode(texture: Texture): string {
  switch (texture.kind) {
    case "uniform":
      return `fm.texture.uniform(${texture.value.map(py).join(", ")})`;
    case "random":
      return "fm.texture.random(seed=1)";
    case "vortex":
      return `fm.texture.vortex(circulation=${texture.circulation}, core_polarity=${texture.polarity})`;
  }
}

export function translateMx3(source: string, options: Mx3TranslateOptions = {}): Mx3Translation {
  const studyName = (options.studyName ?? "mx3_import").replace(/[^A-Za-z0-9_-]+/g, "_") || "mx3_import";
  const context: Context = {
    variables: new Map(),
    material: {},
    steps: [],
    grid: null,
    cell: null,
    pbc: null,
    geometry: null,
    texture: null,
    demag: true,
    stageStarted: false,
    anisUNormalised: false,
  };
  const supported: string[] = [];
  const unsupported: Mx3Unsupported[] = [];

  const reject = (statement: Statement, reason: string) => {
    unsupported.push({ line: statement.line, text: shorten(statement.text, 200), reason });
  };

  let braceDepth = 0;
  for (const statement of assembleStatements(stripComments(source))) {
    const opens = (statement.text.match(/\{/g) ?? []).length;
    const closes = (statement.text.match(/\}/g) ?? []).length;
    if (braceDepth > 0 || opens > 0 || closes > 0) {
      reject(
        statement,
        "inside or opening a block (for, if, func); control flow is not translated, so nothing in it is",
      );
      braceDepth = Math.max(0, braceDepth + opens - closes);
      continue;
    }

    const before = {
      grid: context.grid,
      cell: context.cell,
      pbc: context.pbc,
      geometry: context.geometry,
      texture: context.texture,
    };
    let reason: string | null;
    try {
      reason = translateStatement(context, statement);
    } catch (error) {
      reason =
        error instanceof ExpressionError
          ? `${error.message}; only plain numbers, constants and + - * / are evaluated`
          : "this statement could not be evaluated";
    }
    if (reason !== null) {
      reject(statement, reason);
      continue;
    }
    // Remember where a one-shot setting came from, for the report.
    for (const key of ["grid", "cell", "pbc", "geometry", "texture"] as const) {
      const current = context[key];
      if (current && current !== before[key]) current.line = statement.line;
    }
    supported.push(`L${statement.line}: ${shorten(statement.text, 160)}`);
  }

  // --- Mandatory input ------------------------------------------------------
  const blockers: string[] = [];
  if (!context.grid) blockers.push("no SetGridSize(...) was translated, so the mesh is unknown");
  if (!context.cell) blockers.push("no SetCellSize(...) was translated, so the cell size is unknown");
  if (context.material.Ms === undefined) blockers.push("Msat was not set to a plain number");
  if (context.material.Aex === undefined) blockers.push("Aex was not set to a plain number");
  if (!context.texture) blockers.push("the initial magnetisation m was not set to a translatable value");
  if (!context.steps.some((step) => step.kind === "relax" || step.kind === "run")) {
    blockers.push("no Relax() or Run(...) was translated, so the script would compute nothing");
  }

  // --- Geometry needs the universe ------------------------------------------
  let geometryLine = "";
  if (context.grid && context.cell && context.geometry) {
    const universe: Vec3 = [
      context.grid.value[0] * context.cell.value[0],
      context.grid.value[1] * context.cell.value[1],
      context.grid.value[2] * context.cell.value[2],
    ];
    const built = geometryCode(context.geometry.value, universe);
    if ("error" in built) {
      unsupported.push({
        line: context.geometry.line,
        text: "SetGeom(...)",
        reason: built.error,
      });
      const index = supported.findIndex((entry) => entry.startsWith(`L${context.geometry?.line}:`));
      if (index >= 0) supported.splice(index, 1);
      blockers.push("the SetGeom shape could not be placed in the grid");
    } else {
      geometryLine = built.code;
    }
  }

  unsupported.sort((a, b) => a.line - b.line);
  const runnable = blockers.length === 0;

  const header: string[] = [
    "# Translated from a MuMax3 (.mx3) script by the Fullmag start-screen importer.",
    "# All quantities are SI, as in mumax3. Review this file before running it.",
  ];
  if (unsupported.length > 0) {
    header.push(
      "#",
      `# NOT TRANSLATED -- ${unsupported.length} statement${unsupported.length === 1 ? "" : "s"}.`,
      "# The physics below is therefore NOT the full mumax3 model:",
    );
    for (const item of unsupported) {
      header.push(`#   line ${item.line}: ${shorten(item.text, 100)}`);
      header.push(`#     reason: ${item.reason}`);
    }
  } else {
    header.push("#", "# Every statement in the source was translated.");
  }
  if (!runnable) {
    header.push("#", "# NOT RUNNABLE -- mandatory input is missing:");
    for (const blocker of blockers) header.push(`#   ${blocker}`);
  }

  if (!runnable) {
    const message = `mx3 import incomplete: ${blockers.join("; ")}`;
    const script = [...header, "", `raise SystemExit(${pyString(message)})`, ""].join("\n");
    return { script, supported, unsupported, runnable, blockers };
  }

  // The checks above guarantee these are present.
  const grid = context.grid as { value: Vec3 };
  const cell = context.cell as { value: Vec3 };
  const texture = (context.texture as { value: Texture }).value;
  const material = context.material;
  const universe: Vec3 = [
    grid.value[0] * cell.value[0],
    grid.value[1] * cell.value[1],
    grid.value[2] * cell.value[2],
  ];
  const body: string[] = [];
  body.push(
    "import fullmag as fm",
    "",
    `study = fm.study(${pyString(studyName)})`,
    'study.engine("fdm")',
    'study.device("auto", precision="double")',
    'study.mode("strict")',
    "",
    `# SetGridSize(${grid.value.join(", ")}) x SetCellSize(...) gives the universe.`,
    `study.universe(mode="manual", size=${pyVec(universe)}, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))`,
    `study.cell(${cell.value.map(py).join(", ")})`,
  );
  if (context.pbc && context.pbc.value.some((n) => n > 0)) {
    const [x, y, z] = context.pbc.value;
    body.push(
      `# SetPBC(${x}, ${y}, ${z}): periodic axes with truncated demag images.`,
      `study.pbc(x=${x > 0 ? "True" : "False"}, y=${y > 0 ? "True" : "False"}, z=${z > 0 ? "True" : "False"}, demag="truncated_images", images=(${x}, ${y}, ${z}))`,
    );
  }
  body.push("");
  const bodyShape = geometryLine || `fm.Box(size=${pyVec(universe)}, name="body")`;
  body.push(
    context.geometry
      ? "# SetGeom(...) shape."
      : "# No SetGeom: mumax3 fills the whole grid, so the body is the full box.",
    `body = study.geometry(${bodyShape}, name="body")`,
    `body.Ms = ${py(material.Ms as number)}`,
    `body.Aex = ${py(material.Aex as number)}`,
  );
  if (material.alpha === undefined) {
    body.push("body.alpha = 0.0  # alpha was not set; mumax3's default is 0, written explicitly");
  } else {
    body.push(`body.alpha = ${py(material.alpha)}`);
  }
  if (material.Ku1 !== undefined) body.push(`body.Ku1 = ${py(material.Ku1)}`);
  if (material.anisU !== undefined) {
    body.push(
      `body.anisU = ${pyVec(material.anisU)}${context.anisUNormalised ? "  # normalised from the AnisU vector" : ""}`,
    );
  }
  if (material.Dind !== undefined) body.push(`body.Dind = ${py(material.Dind)}`);
  if (texture.kind === "random") {
    body.push("# RandomMag() is unseeded in mumax3; a fixed seed makes this import reproducible.");
  }
  body.push(`body.m = ${textureCode(texture)}`, "");
  body.push(
    "study.exchange()",
    context.demag ? "study.demag()" : "study.demag(enabled=False)",
    "# mumax3 picks its own solver; the integrator here is an explicit Fullmag choice.",
    'study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=1e-11)',
    "",
  );
  for (const step of context.steps) {
    switch (step.kind) {
      case "b_ext":
        body.push(`study.b_ext(${step.value.map(py).join(", ")})`);
        break;
      case "relax":
        body.push(
          "# Relax(): overdamped relaxation; mumax3's stopping rule differs from this tolerance.",
          `study.stages.add_relax(${RELAX_ARGUMENTS})`,
        );
        break;
      case "run":
        body.push(`study.stages.add_run(${py(step.time)})`);
        break;
      case "autosave_m":
        body.push(`study.save("m", every=${py(step.every)})`);
        break;
      case "table":
        body.push(
          "# TableAutosave: default Fullmag columns; mumax3's table columns are not reproduced.",
          `study.tableautosave(${py(step.every)}, quantities=["time", "step", "mx", "my", "mz", "E_total"])`,
        );
        break;
    }
  }
  body.push("");

  return { script: [...header, "", ...body].join("\n"), supported, unsupported, runnable, blockers };
}
