import { describe, expect, it } from "vite-plus/test";
import { compileExpression, evaluateExpression, plotExpressions } from "./expression.ts";

describe("math expression parser", () => {
  it("implements math precedence, powers, constants and named functions", () => {
    expect(evaluateExpression("-2^2 + 3 * (4 + 1)", 0)).toBe(11);
    expect(evaluateExpression("2^3^2", 0)).toBe(512);
    expect(evaluateExpression("2^-2", 0)).toBe(0.25);
    expect(evaluateExpression("sin(pi/2) + exp(0) + log(e)", 0)).toBeCloseTo(3);
    expect(evaluateExpression("max(2, pow(x, 2))", 3)).toBe(9);
    expect(compileExpression("sin(x)*exp(-x/5)")(1)).toBeCloseTo(Math.sin(1) * Math.exp(-0.2));
    expect(evaluateExpression("1.2e-3 + .5", 0)).toBeCloseTo(0.5012);
    expect(plotExpressions("sin(x),max(x,2),cos(x)")).toEqual(["sin(x)", "max(x,2)", "cos(x)"]);
  });

  it.each([
    "globalThis",
    "window.alert(1)",
    "process.exit()",
    "Math.sin(x)",
    "x.constructor",
    "__proto__",
    "constructor(1)",
    "x=1",
    "x;alert(1)",
    "import('fs')",
    "(()=>1)()",
    "[1,2]",
    "`x`",
    "'x'",
    "true",
    "Infinity",
    "NaN",
    "1e999",
    "sin()",
    "min(1)",
    "2x",
    "sin(x) garbage",
  ])("rejects non-math input %s", (expression) => {
    expect(() => compileExpression(expression)).toThrow();
  });

  it("bounds parser work and lets graph discontinuities produce non-finite values", () => {
    expect(() => compileExpression("(".repeat(100) + "x" + ")".repeat(100))).toThrow("nesting");
    expect(() => compileExpression("-".repeat(100) + "x")).toThrow("nesting");
    expect(() => compileExpression("x".repeat(2049))).toThrow("characters");
    expect(evaluateExpression("1/x", 0)).toBe(Infinity);
    expect(evaluateExpression("sqrt(x)", -1)).toBeNaN();
  });
});
