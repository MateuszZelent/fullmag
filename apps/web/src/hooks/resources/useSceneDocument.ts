"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SceneDocument } from "@/lib/session/types";
import type {
  AuthoringMaterialPatchRequest,
  AuthoringMaterialResource,
  AuthoringObjectInteractionPatchRequest,
  AuthoringObjectInteractionResource,
  AuthoringStudyRuntimePatchRequest,
  AuthoringStudyRuntimeResource,
} from "../../api/types";
import { getLiveSessionClient } from "../../api/client/LiveSessionClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";

interface UseSceneDocumentResult {
  document: SceneDocument | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

export function useSceneDocument(options?: {
  enabled?: boolean;
  sessionKey?: string | null;
  revision?: number | null;
}): UseSceneDocumentResult {
  const enabled = options?.enabled ?? true;
  const sessionKey = options?.sessionKey ?? null;
  const revision = options?.revision ?? null;
  const [document, setDocument] = useState<SceneDocument | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<LiveApiError | null>(null);
  const mountedRef = useRef(true);
  const lastFetchedIdentityRef = useRef<string | null>(null);

  const fetchIdentity = sessionKey
    ? `${sessionKey}:${revision == null ? "no-revision" : revision}`
    : null;

  const fetchSceneDocument = useCallback(async () => {
    if (!enabled || !sessionKey) {
      if (mountedRef.current) {
        setDocument(null);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const nextDocument = await getLiveSessionClient().scene.get();
      if (!mountedRef.current) {
        return;
      }
      lastFetchedIdentityRef.current = `${sessionKey}:${nextDocument.revision}`;
      setDocument(nextDocument);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const apiError =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("scene-document", err);
      if (apiError.status === 404) {
        lastFetchedIdentityRef.current = fetchIdentity;
        setDocument(null);
        setError(null);
        setLoading(false);
        return;
      }
      setError(apiError);
      setLoading(false);
    }
  }, [enabled, fetchIdentity, sessionKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !sessionKey) {
      lastFetchedIdentityRef.current = null;
      setDocument(null);
      setError(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    if (lastFetchedIdentityRef.current !== fetchIdentity) {
      void fetchSceneDocument();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [enabled, fetchIdentity, fetchSceneDocument, sessionKey]);

  return {
    document,
    loading,
    error,
    refresh: fetchSceneDocument,
  };
}

export function useSceneAuthoringActions() {
  return useMemo(() => ({
    updateSceneDocument(document: SceneDocument): Promise<SceneDocument> {
      return getLiveSessionClient().scene.update(document);
    },
    patchMaterial(
      materialId: string,
      request: AuthoringMaterialPatchRequest,
    ): Promise<AuthoringMaterialResource> {
      return getLiveSessionClient().scene.patchMaterial(materialId, request);
    },
    patchObjectInteraction(
      objectId: string,
      interactionKind: string,
      request: AuthoringObjectInteractionPatchRequest,
    ): Promise<AuthoringObjectInteractionResource> {
      return getLiveSessionClient().scene.patchObjectInteraction(
        objectId,
        interactionKind,
        request,
      );
    },
    patchStudyRuntime(
      request: AuthoringStudyRuntimePatchRequest,
    ): Promise<AuthoringStudyRuntimeResource> {
      return getLiveSessionClient().scene.patchStudyRuntime(request);
    },
  }), []);
}
