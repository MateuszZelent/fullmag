export interface PickFileResult {
  path?: string | null;
  name: string;
  text: string;
}

const STAGED_FILE_PREFIX = "fullmag.launch_asset.";

type TauriInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
  }
}

function tauriInvoke(): TauriInvoke | null {
  if (typeof window === "undefined") return null;
  return typeof window.__TAURI__?.core?.invoke === "function"
    ? window.__TAURI__.core.invoke
    : null;
}

export async function pickTextFile(): Promise<PickFileResult | null> {
  if (typeof window === "undefined") return null;
  const invoke = tauriInvoke();
  if (invoke) {
    const selected = await invoke<PickFileResult | null>("open_file_dialog");
    if (selected) {
      return selected;
    }
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".py,.json,.fm,.yaml,.yml,.txt";
  input.style.display = "none";
  document.body.appendChild(input);
  const result = await new Promise<PickFileResult | null>((resolve) => {
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = await file.text();
      resolve({ path: null, name: file.name, text });
    };
    input.click();
  });
  document.body.removeChild(input);
  return result;
}

export interface StagedLaunchAsset {
  id: string;
  name: string;
  text: string;
  updatedAtUnixMs: number;
}

export function stageLaunchTextFile(file: PickFileResult): string | null {
  if (typeof window === "undefined") return null;
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const asset: StagedLaunchAsset = {
    id,
    name: file.name,
    text: file.text,
    updatedAtUnixMs: Date.now(),
  };
  window.sessionStorage.setItem(`${STAGED_FILE_PREFIX}${id}`, JSON.stringify(asset));
  return id;
}

export function readStagedLaunchAsset(id: string | null | undefined): StagedLaunchAsset | null {
  if (typeof window === "undefined" || !id) return null;
  try {
    const raw = window.sessionStorage.getItem(`${STAGED_FILE_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StagedLaunchAsset;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
