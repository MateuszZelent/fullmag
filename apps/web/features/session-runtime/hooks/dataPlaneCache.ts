"use client";

import type { LiveApiClient } from "@/src/api/client/LiveApiClient";
import type { RequestOptions } from "@/src/api/client/LiveApiClient";
import type { JsonResourceResponse } from "@/src/api/types";

export async function getCachedJsonResource<T>({
  client,
  cacheKey,
  revision,
  fetcher,
  responseFetcher,
  generationId = 0,
}: {
  client: LiveApiClient;
  cacheKey: string;
  revision: number;
  fetcher: () => Promise<T>;
  responseFetcher?: (opts?: RequestOptions) => Promise<JsonResourceResponse<T>>;
  generationId?: number;
}): Promise<T> {
  const cached = client.getCache().get<T>(cacheKey);
  if (cached && cached.revision === revision) {
    return cached.data;
  }

  if (responseFetcher) {
    const response = await responseFetcher({
      cache: "default",
      headers:
        cached?.eTag != null
          ? {
              "If-None-Match": cached.eTag,
            }
          : undefined,
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
