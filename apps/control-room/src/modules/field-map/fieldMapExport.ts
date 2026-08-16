export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface DownloadAnchor {
  click(): void;
  download: string;
  href: string;
}

export function planarExportFilename({
  fieldRevision,
  monitorName,
  sourceLabel,
  quantityId,
  unit,
}: {
  fieldRevision: number | string;
  monitorName?: string;
  sourceLabel?: string;
  quantityId: string;
  unit: string;
}): string {
  const label = sourceLabel ?? monitorName ?? "default";
  return [
    safeSlug(label),
    safeSlug(quantityId),
    `r${fieldRevision}`,
    safeSlug(unit),
  ].join("_") + ".png";
}

export function downloadPlanarPng(
  data: ArrayBuffer,
  filename: string,
  objectUrlApi: ObjectUrlApi = URL,
  createAnchor: () => DownloadAnchor = () =>
    document.createElement("a") as DownloadAnchor,
): void {
  const url = objectUrlApi.createObjectURL(
    new Blob([data], { type: "image/png" }),
  );
  try {
    const anchor = createAnchor();
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    objectUrlApi.revokeObjectURL(url);
  }
}

function safeSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "value"
  );
}
