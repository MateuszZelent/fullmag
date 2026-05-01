"use client";

import type { LiveSessionClient } from "@/src/api/client/LiveSessionClient";
import type { RequestOptions } from "@/src/api/client/LiveSessionClient";
import type { JsonResourceResponse } from "@/src/api/types";

export async function getCachedJsonResource<T>({
  client,
  cacheKey,
  revision,
  fetcher,
  responseFetcher,
  generationId = 0,
  requestOptions,
}: {
  client: LiveSessionClient;
  cacheKey: string;
  revision: number;
  fetcher: () => Promise<T>;
  responseFetcher?: (opts?: RequestOptions) => Promise<JsonResourceResponse<T>>;
  generationId?: number;
  requestOptions?: RequestOptions;
}): Promise<T> {
  const cached = client.getCache().get<T>(cacheKey);
  if (cached && cached.revision === revision) {
    return cached.data;
  }

  if (responseFetcher) {
    const requestHeaders = requestOptions?.headers as Record<string, string> | undefined;
    const response = await responseFetcher({
      ...requestOptions,
      cache: "default",
      headers:
        cached?.eTag != null
          ? {
              ...requestHeaders,
              "If-None-Match": cached.eTag,
            }
          : requestHeaders,
    });
    if (response.status === 304 && cached) {
      return cached.data;
    }
    if (response.data == null) {
      const next = await fetcher();
      client.getCache().set(cacheKey, next, revision, generationId);
      return next;
    }
    client.getCache().set(
      cacheKey,
      response.data,
      revision,
      generationId,
      response.headers.get("etag"),
    );
    return response.data;
  }

  const next = await fetcher();
  client.getCache().set(cacheKey, next, revision, generationId);
  return next;
}
