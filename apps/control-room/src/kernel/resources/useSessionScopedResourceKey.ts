"use client";

import { sessionScopedResourceKey } from "./sessionResourceIdentity";
import { useSessionResourceIdentity } from "./useSessionStatus";

export function useSessionScopedResourceKey(unscopedResourceKey: string) {
  const sessionIdentity = useSessionResourceIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedResourceKey)
    : unscopedResourceKey;
  return { resourceKey, sessionIdentity };
}
