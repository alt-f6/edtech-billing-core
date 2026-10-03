import { describe, expect, it } from "vitest";
import { formatKopecks, parseAmountToKopecks } from "../src/index.js";

describe("money parsing", () => {
  it.each([
    ["1500.00", 150_000],
    ["1500", 150_000],
    ["0.1", 10],
    ["0.29", 29],
    ["1.15", 115],
    ["007.50", 750],
    [" 99.99 ", 9_999],
  ])("%j -> %i kopecks", (input, expected) => {
    expect(parseAmountToKopecks(input)).toBe(expected);
  });

  it("is exact where a float round-trip is not", () => {
    // The naive conversion gets these wrong: 0.29 * 100 = 28.999999999999996.
    expect(Math.trunc(Number("0.29") * 100)).toBe(28);
    expect(Math.trunc(Number("1.15") * 100)).toBe(114);
    expect(parseAmountToKopecks("0.29")).toBe(29);
    expect(parseAmountToKopecks("1.15")).toBe(115);
  });

  it.each(["", "   ", "abc", "-5.00", "1.234", "1,00", "1e3", ".50", "99999999999999999.00"])("rejects %j", (input) => {
    expect(() => parseAmountToKopecks(input)).toThrow();
  });

  it("formats kopecks back to a decimal string", () => {
    expect(formatKopecks(150_000)).toBe("1500.00");
    expect(formatKopecks(-5)).toBe("-0.05");
  });
});
