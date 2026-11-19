import { createLivePhaseUniform, type LivePhaseUniform } from "./livePhaseUniform";

type Listener = () => void;

/**
 * Display clock for the analysis field overlay phase.
 *
 * The overlay controller stores the committed phase (set explicitly by the
 * user or committed when an animation stops). While the phase animates, the
 * per-frame value lives here instead, so animation frames notify only clock
 * listeners (viewport invalidation, throttled readouts) and never the overlay
 * subscribers that rebuild Explorer, Ribbon, Inspector and scene models.
 */
export class AnalysisFieldOverlayPhaseClock {
  /** Shared by every material that renders the overlay's complex field. */
  readonly uniform: LivePhaseUniform = createLivePhaseUniform(0);
  private livePhaseRad: number | null = null;
  private readonly listeners = new Set<Listener>();

  /** Phase of the running animation, or null when no animation owns it. */
  getLivePhaseRad(): number | null {
    return this.livePhaseRad;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setLivePhaseRad(phaseRad: number): void {
    if (!Number.isFinite(phaseRad)) return;
    if (this.livePhaseRad === phaseRad && this.uniform.value === phaseRad) return;
    this.livePhaseRad = phaseRad;
    this.uniform.value = phaseRad;
    this.notify();
  }

  /** Drops the live phase and shows the committed phase again. */
  clearLivePhase(committedPhaseRad: number): void {
    const next = Number.isFinite(committedPhaseRad) ? committedPhaseRad : 0;
    if (this.livePhaseRad === null && this.uniform.value === next) return;
    this.livePhaseRad = null;
    this.uniform.value = next;
    this.notify();
  }

  /** Mirrors a committed phase into the uniform when no animation owns it. */
  syncCommittedPhase(committedPhaseRad: number): void {
    if (this.livePhaseRad !== null) return;
    const next = Number.isFinite(committedPhaseRad) ? committedPhaseRad : 0;
    if (this.uniform.value === next) return;
    this.uniform.value = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
