import { createStore } from "./core";

export type ThemeId = "dark" | "viridis" | "whale" | "rose-pine";

const LS = {
  adminKey: "adminKey",
  inferenceKey: "inferenceKey",
  theme: "piTheme",
  compact: "piCompact",
  sidebar: "piSidebar",
} as const;

function lsGet(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

export interface UiState {
  view: string;
  theme: ThemeId;
  compact: boolean;
  keyOk: boolean;
  showAllReq: boolean;
  running: boolean;
  restarting: boolean;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  adminKey: string;
  inferenceKey: string;
  clock: string;
}

const init: UiState = {
  view: "overview",
  theme: (lsGet(LS.theme) as ThemeId) || "dark",
  compact: lsGet(LS.compact) === "1",
  keyOk: !!lsGet(LS.adminKey),
  showAllReq: false,
  running: false,
  restarting: false,
  sidebarOpen: false,
  sidebarCollapsed: lsGet(LS.sidebar) === "1",
  adminKey: lsGet(LS.adminKey),
  inferenceKey: lsGet(LS.inferenceKey),
  clock: new Date().toLocaleTimeString(),
};

export const uiStore = createStore<UiState>(init);

export function setView(v: string, e?: { shiftKey?: boolean }): void {
  uiStore.set((s) => ({ ...s, view: v, sidebarOpen: false }));
  if (e?.shiftKey) return; // ignore persistence shortcut
}
export function setTheme(t: ThemeId): void {
  lsSet(LS.theme, t);
  uiStore.set({ theme: t });
}
export function setCompact(v?: boolean): void {
  const next = v ?? !uiStore.get().compact;
  lsSet(LS.compact, next ? "1" : "0");
  uiStore.set({ compact: next });
}
export function toggleSidebar(): void {
  const next = !uiStore.get().sidebarCollapsed;
  lsSet(LS.sidebar, next ? "1" : "0");
  uiStore.set({ sidebarCollapsed: next });
}
export function setKey(kind: "adminKey" | "inferenceKey", v: string): void {
  lsSet(kind === "adminKey" ? LS.adminKey : LS.inferenceKey, v);
  uiStore.set({ [kind]: v } as Partial<UiState>);
  if (kind === "adminKey") uiStore.set({ keyOk: !!v });
}

export function localKey(): string {
  return lsGet(LS.adminKey);
}
export function localInferenceKey(): string {
  return lsGet(LS.inferenceKey);
}