export type ObjectUrlApi = Pick<
  typeof URL,
  "createObjectURL" | "revokeObjectURL"
>;

export function createObjectUrl(
  data: ArrayBuffer | null,
  contentType: string,
  objectUrlApi: ObjectUrlApi | null = defaultObjectUrlApi(),
): string | null {
  if (!data || !objectUrlApi) return null;
  return objectUrlApi.createObjectURL(new Blob([data], { type: contentType }));
}

export function revokeObjectUrl(
  url: string | null,
  objectUrlApi: ObjectUrlApi | null = defaultObjectUrlApi(),
): void {
  if (!url || !objectUrlApi) return;
  objectUrlApi.revokeObjectURL(url);
}

function defaultObjectUrlApi(): ObjectUrlApi | null {
  return typeof URL === "undefined" ? null : URL;
}
