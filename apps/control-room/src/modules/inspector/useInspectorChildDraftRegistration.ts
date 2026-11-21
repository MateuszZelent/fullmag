"use client";

import { useLayoutEffect, useState } from "react";

import type { InspectorChildDraftRegistry } from "./inspectorChildDraftRegistry";

export function useInspectorChildDraftRegistration<
  Session extends { dirty: boolean; valid: boolean },
>(
  registry: InspectorChildDraftRegistry<Session> | undefined,
  ownerKey: string | undefined,
  session: Session,
): void {
  const [owner] = useState(() => Symbol("inspector-child-draft"));
  useLayoutEffect(
    () => () => registry?.retire(owner),
    [owner, ownerKey, registry],
  );
  useLayoutEffect(() => {
    if (ownerKey) registry?.publish(owner, ownerKey, session);
  }, [owner, ownerKey, registry, session]);
}
