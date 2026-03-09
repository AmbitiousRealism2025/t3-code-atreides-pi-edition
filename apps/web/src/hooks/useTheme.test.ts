import { describe, expect, it } from "vitest";

import { resolveTheme } from "./useTheme";

describe("resolveTheme", () => {
  it("all Atreides themes resolve to dark", () => {
    expect(resolveTheme("caladan-night", false)).toBe("dark");
    expect(resolveTheme("atreides-dawn", false)).toBe("dark");
    expect(resolveTheme("imperial-ember", false)).toBe("dark");
  });

  it("system theme always resolves to dark (all Atreides themes are dark)", () => {
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
