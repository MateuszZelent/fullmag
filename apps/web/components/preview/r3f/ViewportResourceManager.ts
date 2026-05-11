/**
 * ViewportResourceManager — byte-budget-aware WebGL resource registry.
 *
 * Responsibilities:
 *  - Track every allocated geometry/color/vector resource by key and byte cost.
 *  - Expose `canAllocate(category, bytes)` so callers can decide whether to build
 *    an expensive resource or degrade gracefully before allocating.
 *  - Dispose stale resources (not referenced for N frames) automatically.
 *  - Provide `getStats()` for telemetry / degradation badges.
 *
 * Design rules:
 *  - Pure TypeScript module — no React, no Three.js imports here.
 *    Callers pass a `dispose()` callback so this module stays renderer-agnostic.
 *  - `acquireOrDegrade` returns `{ value, degradedReason }`. When `degradedReason`
 *    is set, callers must show a "degraded" indicator and not render the pass.
 *  - Frame counter advanced by `beginFrame()`. Resources unused for `staleFrames`
 *    (default 3) frames are collected by `disposeStale()`.
 */

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Coarse resource category for per-bucket byte tracking. */
export type ResourceCategory = "geometry" | "color" | "vector" | "transient";

/** Degradation reason returned when a resource cannot be allocated. */
export type DegradedReason = "memory-budget" | "category-limit" | "total-limit";

/** A managed resource handle: caller provides a `dispose` callback. */
export interface ResourceHandle<T> {
  key: string;
  value: T;
  /** Estimated GPU byte cost for this resource. */
  bytes: number;
  /** Called by the manager when the resource is evicted or explicitly released. */
  dispose: () => void;
}

/** Per-category and total byte ceilings. */
export interface ViewportResourceBudget {
  /** Surface + edge + points geometry buffers. Default: 400 MB. */
  maxGeometryBytes: number;
  /** Vertex color attribute buffers. Default: 128 MB. */
  maxColorBytes: number;
  /** Vector arrow matrices + color attribute buffers. Default: 256 MB. */
  maxVectorBytes: number;
  /** Short-lived transient allocations (build temporaries). Default: 64 MB. */
  maxTransientBytes: number;
  /** Hard total ceiling across all categories. Default: 768 MB. */
  maxTotalBytes: number;
}

/** Live totals returned by `getStats()`. */
export interface ViewportResourceStats {
  geometryBytes: number;
  colorBytes: number;
  vectorBytes: number;
  transientBytes: number;
  totalBytes: number;
  resourceCount: number;
  /** Number of resources not marked-used since last `beginFrame()`. */
  staleCount: number;
}

/** Result of `canAllocate()` — includes budget class for degradation UX. */
export interface AllocationCheck {
  canAllocate: boolean;
  estimatedBytes: number;
  /** Cost classification for renderer-side pass decision. */
  budgetClass: "cheap" | "normal" | "expensive";
  /** Set when `canAllocate` is false. */
  degradedReason?: DegradedReason;
}

/** Result of `acquireOrDegrade()`. */
export interface AcquisitionResult<T> {
  value: T | null;
  /** Whether the value came from the cache. */
  cached: boolean;
  /** Set when the resource could not be built due to budget. */
  degradedReason?: DegradedReason;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

export const DEFAULT_VIEWPORT_BUDGET: ViewportResourceBudget = {
  maxGeometryBytes: 400 * MB,
  maxColorBytes: 128 * MB,
  maxVectorBytes: 256 * MB,
  maxTransientBytes: 64 * MB,
  maxTotalBytes: 768 * MB,
};

const VIEWPORT_RESOURCE_DEBUG_LOGS =
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace;

// ── Implementation ─────────────────────────────────────────────────────────────

interface RegistryEntry<T> {
  handle: ResourceHandle<T>;
  category: ResourceCategory;
  lastUsedFrame: number;
}

export class ViewportResourceManager {
  private entries = new Map<string, RegistryEntry<unknown>>();
  private frame = 0;

  constructor(public readonly budget: ViewportResourceBudget = DEFAULT_VIEWPORT_BUDGET) {}

  // ── Frame lifecycle ──────────────────────────────────────────────────────────

  /** Call once per render frame to advance the internal frame counter. */
  beginFrame(): void {
    this.frame++;
  }

  // ── Budget checks ────────────────────────────────────────────────────────────

  /**
   * Check whether `estimatedBytes` can be added to `category` without exceeding
   * either the per-category limit or the global total limit.
   */
  canAllocate(category: ResourceCategory, estimatedBytes: number): AllocationCheck {
    const stats = this.getStats();
    const catBytes = this.categoryCurrentBytes(category);
    const catMax = this.categoryMax(category);

    const budgetClass: AllocationCheck["budgetClass"] =
      estimatedBytes < 4 * MB ? "cheap" :
      estimatedBytes < 50 * MB ? "normal" :
      "expensive";

    if (catBytes + estimatedBytes > catMax) {
      return {
        canAllocate: false,
        estimatedBytes,
        budgetClass,
        degradedReason: "category-limit",
      };
    }
    if (stats.totalBytes + estimatedBytes > this.budget.maxTotalBytes) {
      return {
        canAllocate: false,
        estimatedBytes,
        budgetClass,
        degradedReason: "total-limit",
      };
    }
    return { canAllocate: true, estimatedBytes, budgetClass };
  }

  // ── Acquire / release ────────────────────────────────────────────────────────

  /**
   * Attempt to acquire a resource by key.
   *
   * - If already registered under `key`, returns the cached value.
   * - If not registered, checks `estimatedBytes` against the budget, then calls
   *   `factory()` to build it.
   * - Returns `{ value: null, degradedReason }` when the budget would be exceeded.
   */
  acquireOrDegrade<T>(
    key: string,
    category: ResourceCategory,
    estimatedBytes: number,
    factory: () => ResourceHandle<T>,
  ): AcquisitionResult<T> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedFrame = this.frame;
      return { value: existing.handle.value as T, cached: true };
    }

    const check = this.canAllocate(category, estimatedBytes);
    if (!check.canAllocate) {
      return { value: null, cached: false, degradedReason: check.degradedReason };
    }

    const handle = factory();
    this.entries.set(key, { handle: handle as ResourceHandle<unknown>, category, lastUsedFrame: this.frame });
    return { value: handle.value, cached: false };
  }

  /**
   * Register an already-built resource (e.g. built outside the manager but
   * should be tracked for byte accounting and disposal).
   */
  register<T>(handle: ResourceHandle<T>, category: ResourceCategory): void {
    const existing = this.entries.get(handle.key);
    if (existing) {
      existing.handle.dispose();
      this.entries.delete(handle.key);
    }
    this.entries.set(handle.key, {
      handle: handle as ResourceHandle<unknown>,
      category,
      lastUsedFrame: this.frame,
    });
  }

  /** Mark a resource as used in the current frame (prevents stale eviction). */
  markUsed(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedFrame = this.frame;
  }

  /** Release and dispose a resource immediately. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.handle.dispose();
    this.entries.delete(key);
  }

  // ── Disposal ─────────────────────────────────────────────────────────────────

  /**
   * Dispose and remove resources that have not been marked-used for at least
   * `staleFrames` frames.  Should be called after rendering each frame.
   */
  disposeStale(staleFrames = 3, reason?: string): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (this.frame - entry.lastUsedFrame >= staleFrames) {
        if (reason && VIEWPORT_RESOURCE_DEBUG_LOGS) {
          writeFrontendDiagnosticConsole("debug", `[ViewportResourceManager] disposeStale(${reason}): ${key}`);
        }
        entry.handle.dispose();
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Dispose all tracked resources immediately. */
  disposeAll(reason?: string): void {
    if (reason && VIEWPORT_RESOURCE_DEBUG_LOGS) {
      writeFrontendDiagnosticConsole("debug", `[ViewportResourceManager] disposeAll(${reason}): ${this.entries.size} resources`);
    }
    for (const entry of this.entries.values()) {
      entry.handle.dispose();
    }
    this.entries.clear();
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  getStats(): ViewportResourceStats {
    let geometryBytes = 0;
    let colorBytes = 0;
    let vectorBytes = 0;
    let transientBytes = 0;
    let staleCount = 0;

    for (const entry of this.entries.values()) {
      const b = entry.handle.bytes;
      switch (entry.category) {
        case "geometry": geometryBytes += b; break;
        case "color": colorBytes += b; break;
        case "vector": vectorBytes += b; break;
        case "transient": transientBytes += b; break;
      }
      if (this.frame - entry.lastUsedFrame >= 1) staleCount++;
    }

    return {
      geometryBytes,
      colorBytes,
      vectorBytes,
      transientBytes,
      totalBytes: geometryBytes + colorBytes + vectorBytes + transientBytes,
      resourceCount: this.entries.size,
      staleCount,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private categoryCurrentBytes(category: ResourceCategory): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.category === category) total += entry.handle.bytes;
    }
    return total;
  }

  private categoryMax(category: ResourceCategory): number {
    switch (category) {
      case "geometry": return this.budget.maxGeometryBytes;
      case "color":    return this.budget.maxColorBytes;
      case "vector":   return this.budget.maxVectorBytes;
      case "transient": return this.budget.maxTransientBytes;
    }
  }
}
