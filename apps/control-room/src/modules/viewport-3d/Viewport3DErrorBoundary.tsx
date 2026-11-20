"use client";

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

import { Button } from "@/shared/ui/Button";
import type { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";

import { createViewport3DRenderErrorRecord } from "./Viewport3DErrorBoundary.model";

const retainedViewport3DErrors = new WeakMap<object, Error>();

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
        <strong>3D viewport stopped rendering because of an error</strong>
        <span>{this.state.error.message}</span>
        <Button onClick={this.retry} size="sm" type="button" variant="secondary">
          Retry viewport
        </Button>
      </div>
    );
  }
}
