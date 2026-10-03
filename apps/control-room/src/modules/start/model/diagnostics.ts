import { describeBuild, type BuildInfo } from "./buildInfo";
import type { ComputeProbeState, RecentIndexState } from "./types";

export interface DiagnosticsInput {
  readonly host: "desktop" | "browser";
  readonly userAgent: string;
  readonly locale: string;
  readonly now: Date;
  readonly build: BuildInfo | null;
  readonly index: RecentIndexState;
  readonly compute: ComputeProbeState;
}

function describeIndex(index: RecentIndexState): string {
  switch (index.kind) {
    case "ready":
      return `ready, ${index.index.entries.length} projects, generated ${index.index.generatedAt}`;
    case "error":
      return `error: ${index.message}`;
    default:
      return index.kind;
  }
}

function describeCompute(compute: ComputeProbeState): string[] {
  if (compute === undefined) return ["Compute: probe in flight"];
  if (compute === null) return ["Compute: not probed (no host support)"];
  const gpus = compute.gpus.length
    ? compute.gpus.map(
        (g) =>
          `  GPU: ${g.name}${g.cudaVersion ? `, CUDA ${g.cudaVersion}` : ""}, ` +
          `${Math.round(g.vramFreeBytes / 1e6)} / ${Math.round(g.vramTotalBytes / 1e6)} MB free`,
      )
    : ["  GPU: none detected"];
  return [
    `Compute: preferred ${compute.preferredBackend}, ${compute.cpuThreads} CPU threads`,
    ...gpus,
    ...compute.warnings.map((w) => `  warning: ${w}`),
  ];
}

/**
 * A block to paste into a bug report. It states only what this page knows; a
 * missing build number is said to be missing rather than invented.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  return [
    "Fullmag start screen diagnostics",
    `Captured: ${input.now.toISOString()}`,
    `Host: ${input.host}`,
    `Build: ${describeBuild(input.build)}`,
    `Locale: ${input.locale}`,
    `User agent: ${input.userAgent}`,
    `Recent index: ${describeIndex(input.index)}`,
    ...describeCompute(input.compute),
  ].join("\n");
}
