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
  extension = "png",
}: {
  extension?: "csv" | "png";
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
  ].join("_") + `.${extension}`;
}

export function downloadPlanarPng(
  data: ArrayBuffer,
  filename: string,
  objectUrlApi: ObjectUrlApi = URL,
  createAnchor: () => DownloadAnchor = () =>
    document.createElement("a") as DownloadAnchor,
): void {
  downloadPlanarBlob(new Blob([data], { type: "image/png" }), filename, objectUrlApi, createAnchor);
}

export function downloadPlanarBlob(
  blob: Blob,
  filename: string,
  objectUrlApi: ObjectUrlApi = URL,
  createAnchor: () => DownloadAnchor = () =>
    document.createElement("a") as DownloadAnchor,
): void {
  const url = objectUrlApi.createObjectURL(blob);
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

export interface PlanarDataExportInput {
  quantityId: string;
  component: string;
  unit: string;
  fieldRevision: number | string;
  sampleToken: string;
  bounds: readonly [number, number, number, number];
  resolution: readonly [number, number];
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
  values: ArrayLike<number>;
  mask: ArrayLike<number> | null;
}

/**
 * Plain-text export of the sampled raster in canonical SI units: one row per
 * pixel centre with its frame (u, v) and world (x, y, z) coordinates. Empty
 * pixels keep their row with an empty value so the grid stays rectangular.
 */
export function planarDataCsv(input: PlanarDataExportInput): string {
  const [width, height] = input.resolution;
  const du = (input.bounds[1] - input.bounds[0]) / width;
  const dv = (input.bounds[3] - input.bounds[2]) / height;
  const lines = [
    `# quantity=${input.quantityId} component=${input.component} unit=${input.unit || "1"}`,
    `# field_revision=${input.fieldRevision} sample_token=${input.sampleToken}`,
    `# resolution=${width}x${height} origin_m=${input.origin.join(",")} u_axis=${input.uAxis.join(",")} v_axis=${input.vAxis.join(",")}`,
    "u_m,v_m,x_m,y_m,z_m,value",
  ];
  for (let row = 0; row < height; row += 1) {
    const v = input.bounds[2] + (row + 0.5) * dv;
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const u = input.bounds[0] + (column + 0.5) * du;
      const world = [0, 1, 2].map((axis) =>
        input.origin[axis]! + u * input.uAxis[axis]! + v * input.vAxis[axis]!,
      );
      const value = input.values[index];
      const occupied = input.mask === null || (input.mask[index] ?? 0) > 0;
      const text = occupied && value !== undefined && Number.isFinite(value)
        ? value.toExponential(9)
        : "";
      lines.push(`${u.toExponential(9)},${v.toExponential(9)},${world.map((c) => c.toExponential(9)).join(",")},${text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
