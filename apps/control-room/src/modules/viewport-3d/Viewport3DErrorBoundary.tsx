"use client";

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

import type { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import type { DiagnosticConsoleRecord } from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";

const FORENSIC_TEXT_LIMIT = 8_000;
const retainedViewport3DErrors = new WeakMap<object, Error>();

export function createViewport3DRenderErrorRecord(
  error: unknown,
  componentStack: string | null | undefined,
  timestampMs = Date.now(),
): DiagnosticConsoleRecord {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    byteLength: null,
    detail: {
      componentStack: boundForensicText(componentStack ?? ""),
      errorStack: boundForensicText(normalized.stack ?? ""),
    },
    droppedCount: 0,
    durationMs: null,
    id: `viewport-3d-render-error-${timestampMs}`,
    kind: "console",
    lane: "react",
    level: "error",
    message: normalized.message,
    name: "viewport-3d.render-error",
    severity: "critical",
    source: "Viewport3DErrorBoundary",
    startTimeMs: null,
    timestampMs,
  };
}

function boundForensicText(value: string): string {
  return value.length <= FORENSIC_TEXT_LIMIT
    ? value
    : value.slice(0, FORENSIC_TEXT_LIMIT);
}

interface Viewport3DErrorBoundaryProps {
  children: ReactNode;
  diagnosticRecorder: Pick<DiagnosticRecorderController, "record">;
}

interface Viewport3DErrorBoundaryState {
  error: Error | null;
}

export class Viewport3DErrorBoundary extends Component<
  Viewport3DErrorBoundaryProps,
  Viewport3DErrorBoundaryState
> {
  state: Viewport3DErrorBoundaryState = {
    error: retainedViewport3DErrors.get(this.props.diagnosticRecorder) ?? null,
  };

  static getDerivedStateFromError(error: unknown): Viewport3DErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    retainedViewport3DErrors.set(this.props.diagnosticRecorder, normalized);
    const record = createViewport3DRenderErrorRecord(normalized, info.componentStack);
    queueMicrotask(() => {
      this.props.diagnosticRecorder.record(record);
    });
  }

  private readonly retry = (): void => {
    retainedViewport3DErrors.delete(this.props.diagnosticRecorder);
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fm-viewport-3d__error-boundary" role="alert">
        <strong>3D viewport failed before the canvas became ready</strong>
        <span>{this.state.error.message}</span>
        <button onClick={this.retry} type="button">
          Retry viewport
        </button>
      </div>
    );
  }
}
