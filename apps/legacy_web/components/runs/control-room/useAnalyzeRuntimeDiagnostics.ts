"use client";

import { useMemo } from "react";

export type AnalyzeRuntimeBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface AnalyzeRuntimeBadge {
  id: string;
  label: string;
  tone: AnalyzeRuntimeBadgeTone;
  tooltip?: string;
}

export interface AnalyzeMeshSemanticsSummary {
  magneticPartCount: number;
  hasAir: boolean;
  interfacePartCount: number;
  contractLabel: string;
}

export interface AnalyzeRuntimeDiagnosticsState {
  badges: AnalyzeRuntimeBadge[];
  warnings: string[];
  backendError: string | null;
  meshSemantics: AnalyzeMeshSemanticsSummary;
  logExcerpt: string[];
}

export interface AnalyzeRuntimeDiagnosticsInput {
  runtimeEngineLabel: string | null;
  latestBackendError: { summary?: string | null; details?: string | null; message?: string | null } | null;
  engineLog: { level?: string | null; message?: string | null }[];
  magneticParts: unknown[];
  airPart: unknown | null;
  interfaceParts: unknown[];
  metadata: Record<string, unknown> | null;
}

export function useAnalyzeRuntimeDiagnostics(
  input: AnalyzeRuntimeDiagnosticsInput,
): AnalyzeRuntimeDiagnosticsState {
  return useMemo(() => {
    const badges: AnalyzeRuntimeBadge[] = [];

    if (input.runtimeEngineLabel) {
      badges.push({
        id: "engine",
        label: input.runtimeEngineLabel,
        tone: /gpu/i.test(input.runtimeEngineLabel) ? "success" : "info",
        tooltip: "Execution engine for the active workspace",
      });
    }

    badges.push({
      id: "roles",
      label: "solver-normalized roles",
      tone: "info",
      tooltip: "Analyze uses mesh part roles from the runtime payload as the source of truth.",
    });

    if (input.metadata?.["thermal_active"] === true) {
      badges.push({ id: "thermal", label: "thermal active", tone: "warning" });
    }
    if (input.metadata?.["oersted_axis_restricted"] === true) {
      badges.push({ id: "oersted", label: "Oersted restricted", tone: "warning" });
    }
    if (input.metadata?.["cpu_reference_guarded"] === true) {
      badges.push({ id: "cpu-guard", label: "CPU guarded", tone: "warning" });
    }
    if (typeof input.metadata?.["normalization"] === "string") {
      badges.push({
        id: "normalization",
        label: `norm: ${input.metadata["normalization"] as string}`,
        tone: "neutral",
        tooltip: "Magnetization normalization scheme used by the solver.",
      });
    }
    if (typeof input.metadata?.["damping_policy"] === "string") {
      badges.push({
        id: "damping_policy",
        label: `damp: ${input.metadata["damping_policy"] as string}`,
        tone: "neutral",
        tooltip: "Damping policy applied during eigenmode extraction.",
      });
    }
    if (typeof input.metadata?.["equilibrium_source"] === "string") {
      badges.push({
        id: "equilibrium_source",
        label: `eq: ${input.metadata["equilibrium_source"] as string}`,
        tone: "info",
        tooltip: "Origin of the equilibrium magnetization state used for linearization.",
      });
    }

    const warnings = input.engineLog
      .filter((entry) => {
        const level = entry.level?.toLowerCase?.() ?? "";
        return level === "warn" || level === "warning" || level === "error";
      })
      .map((entry) => entry.message?.trim() ?? "")
      .filter(Boolean)
      .slice(-6);

    const backendError =
      input.latestBackendError?.summary?.trim?.() ||
      input.latestBackendError?.message?.trim?.() ||
      input.latestBackendError?.details?.trim?.() ||
      null;

    return {
      badges,
      warnings,
      backendError,
      meshSemantics: {
        magneticPartCount: input.magneticParts.length,
        hasAir: Boolean(input.airPart),
        interfacePartCount: input.interfaceParts.length,
        contractLabel:
          "Analyze trusts solver-normalized mesh roles instead of inferring semantics from raw markers.",
      },
      logExcerpt: input.engineLog
        .map((entry) => entry.message?.trim() ?? "")
        .filter(Boolean)
        .slice(-8),
    };
  }, [input]);
}
