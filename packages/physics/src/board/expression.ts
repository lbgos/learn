/** A deliberately small math grammar: x, pi, e, numbers, arithmetic and named functions.
 * No property access, strings, assignments, implicit multiplication or JavaScript execution.
 * Parse once for plots; non-finite evaluated values denote gaps in the plotted curve.
 */
const functions = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
} as const;
const binaryFunctions = { min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2 } as const;
type Evaluation = (x: number) => number;

export function compileExpression(expression: string): Evaluation {
  if (expression.length === 0 || expression.length > 2048)
    throw new Error("Expression must contain 1–2048 characters.");
  const tokens =
    expression.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|[^\s]/g,
    ) ?? [];
  let index = 0;
  let depth = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const expect = (token: string) => {
    if (take() !== token) throw new Error(`Expected '${token}' in math expression.`);
  };
  function primary(): Evaluation {
    if (++depth > 64) throw new Error("Math expression nesting exceeds 64 levels.");
    try {
      const token = take();
      if (token === undefined) throw new Error("Incomplete math expression.");
      if (/^(?:\d|\.)/.test(token)) {
        const value = Number(token);
        if (!Number.isFinite(value)) throw new Error("Math literal must be finite.");
        return () => value;
      }
      if (token === "(") {
        const value = sum();
        expect(")");
        return value;
      }
      if (token === "x") return (x) => x;
      if (token === "pi" || token === "PI") return () => Math.PI;
      if (token === "e") return () => Math.E;
      if (Object.hasOwn(functions, token)) {
        const fn = functions[token as keyof typeof functions];
        expect("(");
        const argument = sum();
        expect(")");
        return (x) => fn(argument(x));
      }
      if (Object.hasOwn(binaryFunctions, token)) {
        const fn = binaryFunctions[token as keyof typeof binaryFunctions];
        expect("(");
        const a = sum();
        expect(",");
        const b = sum();
        expect(")");
        return (x) => fn(a(x), b(x));
      }
      throw new Error(`Unknown math token '${token}'.`);
    } finally {
      depth--;
    }
  }
  function power(): Evaluation {
    const left = primary();
    if (peek() !== "^" && peek() !== "**") return left;
    take();
    if (++depth > 64) throw new Error("Math expression nesting exceeds 64 levels.");
    const right = unary();
    depth--;
    return (x) => left(x) ** right(x);
  }
  function unary(): Evaluation {
    if (peek() === "+" || peek() === "-") {
      if (++depth > 64) throw new Error("Math expression nesting exceeds 64 levels.");
      const sign = take() === "-" ? -1 : 1;
      const operand = unary();
      depth--;
      return (x) => sign * operand(x);
    }
    return power();
  }
  function product(): Evaluation {
    let value = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const left = value;
      const right = unary();
      value =
        op === "*"
          ? (x) => left(x) * right(x)
          : op === "/"
            ? (x) => left(x) / right(x)
            : (x) => left(x) % right(x);
    }
    return value;
  }
  function sum(): Evaluation {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const left = value;
      const right = product();
      value = op === "+" ? (x) => left(x) + right(x) : (x) => left(x) - right(x);
    }
    return value;
  }
  const result = sum();
  if (index !== tokens.length) throw new Error(`Unexpected math token '${peek()}'.`);
  return result;
}

export function evaluateExpression(expression: string, x: number): number {
  return compileExpression(expression)(x);
}

/** Split multiple curves at top-level commas, preserving function argument commas. */
export function plotExpressions(expression: string | readonly string[]): readonly string[] {
  if (typeof expression !== "string") return expression;
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === "(") depth++;
    if (expression[i] === ")") depth--;
    if (expression[i] === "," && depth === 0) {
      result.push(expression.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(expression.slice(start).trim());
  if (result.length > 8) throw new Error("Plots support at most eight curves.");
  return result;
}
