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

export function createObjectUrlEffect(
  data: ArrayBuffer | null,
  contentType: string,
  setUrl: (url: string | null) => void,
  objectUrlApi: ObjectUrlApi | null = defaultObjectUrlApi(),
): () => void {
  let disposed = false;
  const nextUrl = createObjectUrl(data, contentType, objectUrlApi);
  queueMicrotask(() => {
    if (!disposed) setUrl(nextUrl);
  });
  return () => {
    disposed = true;
    revokeObjectUrl(nextUrl, objectUrlApi);
  };
}

function defaultObjectUrlApi(): ObjectUrlApi | null {
  return typeof URL === "undefined" ? null : URL;
}
