import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme = "system" | "caladan-night" | "atreides-dawn" | "imperial-ember";
export type ResolvedTheme = "light" | "dark";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
function emitChange() {
  for (const listener of listeners) listener();
}

function canUseThemeDom(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof window.matchMedia === "function"
  );
}

function getSystemDark(): boolean {
  if (!canUseThemeDom()) {
    return false;
  }

  return window.matchMedia(MEDIA_QUERY).matches;
}

function getStored(): Theme {
  if (typeof window === "undefined") {
    return "caladan-night";
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);

  // Migrate legacy stored values from stock T3 Code
  if (raw === "light") {
    window.localStorage.setItem(STORAGE_KEY, "atreides-dawn");
    return "atreides-dawn";
  }
  if (raw === "dark") {
    window.localStorage.setItem(STORAGE_KEY, "caladan-night");
    return "caladan-night";
  }

  if (
    raw === "caladan-night" ||
    raw === "atreides-dawn" ||
    raw === "imperial-ember" ||
    raw === "system"
  ) {
    return raw;
  }

  return "caladan-night";
}

const ATREIDES_THEME_CLASSES = ["caladan-night", "atreides-dawn", "imperial-ember"] as const;

function resolveAtreidesClass(theme: Theme, systemDark: boolean): string | null {
  if (theme === "caladan-night" || theme === "atreides-dawn" || theme === "imperial-ember") {
    return theme;
  }
  if (theme === "system") {
    return systemDark ? "caladan-night" : "atreides-dawn";
  }
  // Legacy "light" / "dark" values handled by migration in getStored,
  // but as a safety fallback:
  if (theme === "dark") return "caladan-night";
  if (theme === "light") return "atreides-dawn";
  return "caladan-night";
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (!canUseThemeDom()) {
    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  // Remove all Atreides theme classes before applying
  for (const cls of ATREIDES_THEME_CLASSES) {
    document.documentElement.classList.remove(cls);
  }

  // All Atreides themes are dark
  const isDark = resolveTheme(theme, getSystemDark()) === "dark";
  document.documentElement.classList.toggle("dark", isDark);

  // Apply the specific Atreides theme class
  const atreidesClass = resolveAtreidesClass(theme, getSystemDark());
  if (atreidesClass) {
    document.documentElement.classList.add(atreidesClass);
  }

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  // All three Atreides themes are dark themes
  if (theme === "caladan-night" || theme === "atreides-dawn" || theme === "imperial-ember") {
    return "dark";
  }
  if (theme === "system") {
    // System maps to Atreides themes, which are all dark
    return "dark";
  }
  // Legacy fallback for "light" / "dark" (pre-migration)
  if (theme === "light") return "light";
  return "dark";
}

// Apply immediately on module load to prevent flash
if (canUseThemeDom()) {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  if (!canUseThemeDom()) {
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => ({
    theme: "caladan-night" as const,
    systemDark: false,
  }));
  const theme = snapshot.theme;
  const resolvedTheme = resolveTheme(theme, snapshot.systemDark);

  const setTheme = useCallback((next: Theme) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}
