/**
 * Hands a Python script to the user: a file download and a clipboard copy.
 * Both are plain browser operations; neither touches the Fullmag API.
 */

export function saveScriptFile(fileName: string, source: string): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const href = URL.createObjectURL(new Blob([source], { type: "text/x-python;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = href;
  anchor.click();
  URL.revokeObjectURL(href);
  return true;
}

export async function copyScript(source: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(source);
    return true;
  } catch {
    return false;
  }
}
