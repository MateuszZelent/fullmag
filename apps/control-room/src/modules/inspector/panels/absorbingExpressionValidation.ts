type Scalar = (variables: readonly number[]) => number;
type Operation = (a: number, b: number) => number;
// Function table of the shared formula language (docs/specs/mask-function-v1.md,
// section 8): the backend is the authority, this check only guides the form.
const unary = new Map<string, (x: number) => number>([
  ["sin", Math.sin], ["cos", Math.cos], ["tan", Math.tan], ["asin", Math.asin],
  ["acos", Math.acos], ["atan", Math.atan], ["sinh", Math.sinh], ["cosh", Math.cosh],
  ["tanh", Math.tanh], ["exp", Math.exp], ["log", Math.log], ["log1p", Math.log1p],
  ["sqrt", Math.sqrt], ["abs", Math.abs],
]);
const binary = new Map<string, (a: number, b: number) => number>([
  ["atan2", Math.atan2], ["min", Math.min], ["max", Math.max],
]);
const operators = new Map<string, [number, number, Operation]>([
  ["+", [1, 2, (a, b) => a + b]], ["-", [1, 2, (a, b) => a - b]],
  ["*", [2, 3, (a, b) => a * b]], ["/", [2, 3, (a, b) => a / b]],
  ["**", [4, 4, Math.pow]],
]);

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("The expression produces an undefined value.");
  return value;
}

// Parse the scalar subset accepted by the IR. Expressions never execute as JavaScript.
function parse(source: string, variables: readonly string[]): Scalar {
  if (!source.trim() || source.length > 256 || /[^a-zA-Z0-9.+*/(), \t-]/.test(source)) {
    throw new Error("Enter 1 to 256 ASCII math characters.");
  }
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z][a-zA-Z0-9]*|\*\*|[^ \t]/g) ?? [];
  let position = 0;
  function consume(token: string): boolean {
    if (tokens[position] !== token) return false;
    position++;
    return true;
  }
  function requireToken(token: string) {
    if (!consume(token)) throw new Error("Expected '" + token + "'.");
  }
  function operand(): Scalar {
    if (consume("+")) return expression(3);
    if (consume("-")) {
      const value = expression(3);
      return vars => -value(vars);
    }
    if (consume("(")) {
      const inside = expression(0);
      requireToken(")");
      return inside;
    }
    const token = tokens[position++];
    if (!token) throw new Error("Expected a variable, number, or math function.");
    if (/^[\d.]/.test(token)) {
      if (/^0\d+$/.test(token) && Number(token) !== 0) throw new Error("Remove the leading zero from the integer.");
      const constant = finite(Number(token));
      return () => constant;
    }
    const index = variables.indexOf(token);
    if (index >= 0) return vars => vars[index];
    if (token === "pi") return () => Math.PI;
    const fn = unary.get(token);
    if (fn) {
      requireToken("(");
      const argument = expression(0);
      requireToken(")");
      return vars => finite(fn(argument(vars)));
    }
    const pair = binary.get(token);
    if (!pair) throw new Error("Unknown variable or function '" + token + "'.");
    requireToken("(");
    const first = expression(0);
    requireToken(",");
    const second = expression(0);
    requireToken(")");
    return vars => finite(pair(first(vars), second(vars)));
  }
  function expression(minimum: number): Scalar {
    let value = operand();
    while (position < tokens.length) {
      const operator = operators.get(tokens[position]);
      if (!operator || operator[0] < minimum) break;
      position++;
      const left = value;
      const right = expression(operator[1]);
      value = vars => finite(operator[2](left(vars), right(vars)));
    }
    return value;
  }
  const result = expression(0);
  if (position !== tokens.length) throw new Error("Unexpected token '" + tokens[position] + "'.");
  return result;
}

export function absorbingExpressionError(source: string, kind: "distance" | "profile"): string | undefined {
  try {
    const evaluate = parse(source, kind === "distance" ? ["x", "y", "z"] : ["u"]);
    if (kind === "profile") {
      const tolerance = 1e-12;
      for (let step = 0; step <= 256; step++) {
        const u = step / 256;
        const value = evaluate([u]);
        if (value < -tolerance || value > 1 + tolerance) throw new Error("The ramp must stay within [0, 1].");
        if ((step === 0 || step === 256) && Math.abs(value - u) > tolerance) {
          throw new Error("The ramp must equal 0 at u = 0 and 1 at u = 1.");
        }
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid math expression.";
  }
}
