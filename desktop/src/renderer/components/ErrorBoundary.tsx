import { Component, type ReactNode, type ErrorInfo } from "react";

const api = (window as any).electronAPI;

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-level error boundary (EA-M7). A render exception in any view would
 * otherwise unmount the whole tree and leave a white screen with no recovery
 * path or signal — especially bad for an auto-updated client where a regression
 * could ship widely. This catches it, shows a fallback with a Reload action,
 * and reports to the local opt-in telemetry log (EA-M6).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      api?.reportError?.({
        source: "renderer:boundary",
        message: error.message,
        stack: error.stack,
        extra: { componentStack: info.componentStack ?? undefined },
      });
    } catch {
      /* never let reporting throw from the boundary */
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-8">
        <div className="max-w-md text-center">
          <p className="text-3xl mb-3">⚠️</p>
          <h1 className="text-lg font-semibold text-surface-text mb-1">Something went wrong</h1>
          <p className="text-sm text-surface-faint mb-4">
            The app hit an unexpected error. You can reload to recover — your chats and
            work are saved locally.
          </p>
          <pre className="text-left text-[11px] text-surface-muted bg-surface-panel border rounded p-2 mb-4 overflow-auto max-h-32 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
