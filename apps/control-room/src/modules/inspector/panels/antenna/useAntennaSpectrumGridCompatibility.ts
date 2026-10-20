"use client";

import { useEffect, useMemo, useState } from "react";
import type { AntennaSourceSpectrumResource, SceneResource } from "@/kernel/api/apiTypes";

export type AntennaSpectrumKGrid = NonNullable<SceneResource["antenna_spectrum_requests"]>[number]["nonuniform_k_grid"];
type Verdict = { kind: "ready" } | { kind: "pending" } | { kind: "error"; error: string };
const PENDING: Verdict = { kind: "pending" };
const MISMATCH = "Nonuniform k-grid differs from the published spectrum — recompute spectrum.";

async function axisDigest(axis: readonly number[]): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser.");
  const bytes = new ArrayBuffer(axis.length * 8);
  const view = new DataView(bytes);
  for (let index = 0; index < axis.length; index++) {
    if (!Number.isFinite(axis[index])) throw new Error("Authored wave-vector axis contains a non-finite value.");
    view.setFloat64(index * 8, axis[index], true);
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Verify authored f64 little-endian axes before admitting historical binary requests. */
export function useAntennaSpectrumGridCompatibility(spectrum: AntennaSourceSpectrumResource, grid: AntennaSpectrumKGrid, enabled: boolean): Verdict {
  const transform = spectrum.sampling.transform;
  const uHash = spectrum.payloads?.k_u_rad_per_m.sha256;
  const vHash = spectrum.payloads?.k_v_rad_per_m.sha256;
  const uCount = spectrum.k_u_count, vCount = spectrum.k_v_count;
  const plan = useMemo(() => {
    if (!enabled) return PENDING;
    if (transform !== "nonuniform_spatial_fft") return grid
      ? { kind: "error" as const, error: "Authored nonuniform grid does not match the selected transform." }
      : { kind: "ready" as const };
    if (!grid) return { kind: "error" as const, error: "Nonuniform spectrum requires its authored k-grid." };
    if (!uHash || !vHash || grid.k_u_rad_per_m.length !== uCount || grid.k_v_rad_per_m.length !== vCount) {
      return { kind: "error" as const, error: MISMATCH };
    }
    return { kind: "verify" as const, token: {}, grid, uHash, vHash };
  }, [enabled, grid, transform, uHash, vHash, uCount, vCount]);
  // State holds only a result and an identity token, never the numerical axes.
  const [verified, setVerified] = useState<{ token: object; result: Verdict } | null>(null);
  useEffect(() => {
    if (plan.kind !== "verify") return;
    let active = true;
    void Promise.all([axisDigest(plan.grid.k_u_rad_per_m), axisDigest(plan.grid.k_v_rad_per_m)]).then(
      ([u, v]) => { if (active) setVerified({ token: plan.token, result: u === plan.uHash && v === plan.vHash ? { kind: "ready" } : { kind: "error", error: MISMATCH } }); },
      error => { if (active) setVerified({ token: plan.token, result: { kind: "error", error: error instanceof Error ? error.message : "Wave-vector grid verification failed." } }); },
    );
    return () => { active = false; };
  }, [plan]);
  if (plan.kind !== "verify") return plan;
  return verified?.token === plan.token ? verified.result : PENDING;
}
