"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ViewportErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ViewportErrorBoundary] ${this.props.label ?? "3D"} crashed:`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 h-full w-full bg-background/80 text-muted-foreground select-none">
          <AlertTriangle className="h-10 w-10 text-destructive/70" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-foreground">
              {this.props.label ?? "3D Viewport"} crashed
            </p>
            <p className="text-xs max-w-[320px]">
              {this.state.error?.message ?? "An unexpected error occurred in the WebGL renderer."}
            </p>
          </div>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-muted transition-colors cursor-pointer"
          >
            <RotateCcw size={12} />
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
