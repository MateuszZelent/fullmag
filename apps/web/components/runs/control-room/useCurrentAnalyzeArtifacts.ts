"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DispersionRow,
  EigenBranchesArtifact,
  EigenModeArtifact,
  EigenSpectrumArtifact,
  FemMeshPayload,
} from "@/components/analyze/eigenTypes";
import { fetchAnalyzeArtifact } from "@/features/analyze";
import { currentLiveApiClient } from "@/lib/liveApiClient";
import { decodeFemMeshTopologyBinary } from "@/lib/session/binary-fem-mesh";

type LoadState = "idle" | "loading" | "loaded" | "error";

interface EigenDispersionResponse {
  csv_path: string;
  path_metadata?: unknown;
  rows: DispersionRow[];
}

function femMeshPayloadFromBinary(buffer: ArrayBuffer): FemMeshPayload {
  const topology = decodeFemMeshTopologyBinary(buffer);
  return {
    nodes: Array.from({ length: topology.nodeCount }, (_, index) => {
      const base = index * 3;
      return [
        topology.nodes[base] ?? 0,
        topology.nodes[base + 1] ?? 0,
        topology.nodes[base + 2] ?? 0,
      ];
    }),
    elements: Array.from({ length: topology.elementCount }, (_, index) => {
      const base = index * 4;
      return [
        topology.elements[base] ?? 0,
        topology.elements[base + 1] ?? 0,
        topology.elements[base + 2] ?? 0,
        topology.elements[base + 3] ?? 0,
      ];
    }),
    element_markers: Array.from(topology.elementMarkers),
    boundary_faces: Array.from({ length: topology.boundaryFaceCount }, (_, index) => {
      const base = index * 3;
      return [
        topology.boundaryFaces[base] ?? 0,
        topology.boundaryFaces[base + 1] ?? 0,
        topology.boundaryFaces[base + 2] ?? 0,
      ];
    }),
    boundary_markers: Array.from(topology.boundaryMarkers),
    object_segments: [],
  };
}

export interface CurrentAnalyzeArtifactsState {
  loadState: LoadState;
  modeLoadState: LoadState;
  error: string | null;
  modeError: string | null;
  mesh: FemMeshPayload | null;
  spectrum: EigenSpectrumArtifact | null;
  branches: EigenBranchesArtifact | null;
  dispersionRows: DispersionRow[];
  modeCache: Record<number, EigenModeArtifact>;
  hasEigenArtifacts: boolean;
  /** Map from mode index → artifact path (only modes that have a saved field file). */
  modeArtifactMap: Map<number, string>;
  /** Sorted list of mode indices that have saved field files. */
  savedModeIndices: number[];
  refresh: () => void;
  ensureMode: (index: number, sampleIndex?: number | null) => Promise<void>;
}

export function useCurrentAnalyzeArtifacts(
  refreshNonce: number,
  options?: { enabled?: boolean },
): CurrentAnalyzeArtifactsState {
  const enabled = options?.enabled ?? true;
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [modeLoadState, setModeLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [mesh, setMesh] = useState<FemMeshPayload | null>(null);
  const [spectrum, setSpectrum] = useState<EigenSpectrumArtifact | null>(null);
  const [branches, setBranches] = useState<EigenBranchesArtifact | null>(null);
  const [dispersionRows, setDispersionRows] = useState<DispersionRow[]>([]);
  const [modeCache, setModeCache] = useState<Record<number, EigenModeArtifact>>({});
  const [modeArtifactMap, setModeArtifactMap] = useState<Map<number, string>>(new Map());
  const [internalRefreshNonce, setInternalRefreshNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    async function load() {
      setLoadState("loading");
      setError(null);

      try {
        const client = currentLiveApiClient();
        const queryNonce = `${refreshNonce}:${internalRefreshNonce}`;
        const [meshTopology, liveArtifacts] = await Promise.all([
          fetchAnalyzeArtifact<FemMeshPayload | null>(
            {
              domain: "eigenmodes",
              tab: "mesh-topology",
              selectionFingerprint: `mesh-topology:${queryNonce}`,
              refreshNonce,
            },
            (requestSignal) =>
              client
                .getFemMeshTopologyBinary(null, { signal: requestSignal })
                .then((buffer) => femMeshPayloadFromBinary(buffer)),
          ).catch(() => null),
          fetchAnalyzeArtifact<Array<{ path: string; kind?: string }>>(
            {
              domain: "eigenmodes",
              tab: "artifacts",
              selectionFingerprint: `artifacts:${queryNonce}`,
              refreshNonce,
            },
            (requestSignal) => client.fetchArtifacts({ signal: requestSignal }),
          ).catch(() => []),
        ]);
        if (cancelled) return;

        const artifacts = liveArtifacts;
        const artifactPaths = artifacts.map((artifact) => artifact.path);
        const hasSpectrum = artifactPaths.some(
          (path) => path === "eigen/spectrum.json" || path.startsWith("eigen/spectrum"),
        );
        const hasDispersion = artifactPaths.some(
          (path) => path === "eigen/dispersion.json" || path.startsWith("eigen/dispersion"),
        );
        const hasBranches = artifactPaths.some(
          (path) => path === "eigen/branches.json" || path.startsWith("eigen/branches"),
        );

        const nextModeArtifactMap = new Map<number, string>();
        for (const a of artifacts) {
          if (a.path.startsWith("eigen/modes/")) {
            const match = /mode_(\d+)\.json$/i.exec(a.path);
            if (match) nextModeArtifactMap.set(Number.parseInt(match[1], 10), a.path);
          }
        }

        const [nextSpectrum, nextDispersion, nextBranches] = await Promise.all([
          hasSpectrum
            ? fetchAnalyzeArtifact<EigenSpectrumArtifact>(
                {
                  domain: "eigenmodes",
                  tab: "spectrum",
                  selectionFingerprint: `spectrum:${queryNonce}`,
                  refreshNonce,
                },
                (requestSignal) =>
                  client.fetchEigenSpectrum<EigenSpectrumArtifact>({ signal: requestSignal }),
              ).catch(
                () => null,
              )
            : Promise.resolve(null),
          hasDispersion
            ? fetchAnalyzeArtifact<EigenDispersionResponse>(
                {
                  domain: "eigenmodes",
                  tab: "dispersion",
                  selectionFingerprint: `dispersion:${queryNonce}`,
                  refreshNonce,
                },
                (requestSignal) =>
                  client.fetchEigenDispersion<EigenDispersionResponse>({ signal: requestSignal }),
              ).catch(
                () => null,
              )
            : Promise.resolve(null),
          hasBranches
            ? fetchAnalyzeArtifact<EigenBranchesArtifact>(
                {
                  domain: "eigenmodes",
                  tab: "branches",
                  selectionFingerprint: `branches:${queryNonce}`,
                  refreshNonce,
                },
                (requestSignal) =>
                  client.fetchEigenBranches<EigenBranchesArtifact>({ signal: requestSignal }),
              ).catch(
                () => null,
              )
            : Promise.resolve(null),
        ]);

        if (cancelled) return;

        setMesh(meshTopology);
        setSpectrum(nextSpectrum);
        setBranches(nextBranches);
        setDispersionRows(nextDispersion?.rows ?? []);
        setModeArtifactMap(nextModeArtifactMap);
        setModeCache({});
        setModeLoadState("idle");
        setModeError(null);
        setLoadState("loaded");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoadState("error");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshNonce, internalRefreshNonce]);

  const ensureMode = useCallback(async (index: number, sampleIndex?: number | null) => {
    if (!enabled) {
      return;
    }
    if (modeCache[index]) return;

    setModeLoadState("loading");
    setModeError(null);

    try {
      const client = currentLiveApiClient();
      const artifact = await fetchAnalyzeArtifact<EigenModeArtifact>(
        {
          domain: "eigenmodes",
          tab: "mode",
          selectionFingerprint: `mode:${index}:${sampleIndex ?? "none"}`,
          refreshNonce,
        },
        (requestSignal) =>
          client.fetchEigenMode<EigenModeArtifact>(index, sampleIndex, { signal: requestSignal }),
      );
      setModeCache((prev) => ({ ...prev, [index]: artifact }));
      setModeLoadState("loaded");
    } catch (err) {
      setModeError(err instanceof Error ? err.message : String(err));
      setModeLoadState("error");
    }
  }, [enabled, modeCache, refreshNonce]);

  const hasEigenArtifacts = useMemo(
    () => Boolean(spectrum) || Boolean(branches) || dispersionRows.length > 0 || modeArtifactMap.size > 0,
    [branches, dispersionRows.length, modeArtifactMap, spectrum],
  );

  const savedModeIndices = useMemo(
    () => Array.from(modeArtifactMap.keys()).sort((a, b) => a - b),
    [modeArtifactMap],
  );

  const refresh = useCallback(() => {
    setInternalRefreshNonce((n) => n + 1);
  }, []);

  return {
    loadState: enabled ? loadState : "idle",
    modeLoadState: enabled ? modeLoadState : "idle",
    error: enabled ? error : null,
    modeError: enabled ? modeError : null,
    mesh: enabled ? mesh : null,
    spectrum: enabled ? spectrum : null,
    branches: enabled ? branches : null,
    dispersionRows: enabled ? dispersionRows : [],
    modeCache: enabled ? modeCache : {},
    hasEigenArtifacts: enabled ? hasEigenArtifacts : false,
    modeArtifactMap: enabled ? modeArtifactMap : new Map<number, string>(),
    savedModeIndices: enabled ? savedModeIndices : [],
    refresh,
    ensureMode,
  };
}
