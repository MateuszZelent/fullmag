import { SCRIPT_PROJECT_MAX_BYTES, type ScriptProjectSource } from "./scriptProject";

/** Read source only. The existing project action owns execution consent. */
export async function readPythonImport(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<ScriptProjectSource> {
  if (file.size > SCRIPT_PROJECT_MAX_BYTES) {
    throw new Error("The script is larger than 1 MiB, the limit for creating a project.");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > SCRIPT_PROJECT_MAX_BYTES) {
    throw new Error("The script is larger than 1 MiB, the limit for creating a project.");
  }
  let text: string;
  try {
    // ignoreBOM keeps the authored U+FEFF rather than stripping its bytes.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("The Python script must be valid UTF-8.");
  }
  return {
    fileName: file.name,
    text,
    origin: `python:${file.name}`,
    projectName: file.name.replace(/\.py$/i, ""),
  };
}
