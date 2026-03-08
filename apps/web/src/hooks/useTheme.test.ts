import { describe, expect, it } from "vitest";

import { resolveTheme } from "./useTheme";

describe("resolveTheme", () => {
  it("preserves explicit light and dark preferences", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("maps system theme to the current OS preference", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
