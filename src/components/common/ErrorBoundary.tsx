import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Shown when a child throws. A function receives the error for a tailored message. */
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
}

interface State {
  error: Error | null;
}

/**
 * Catches render/effect errors so one failing panel cannot blank the whole application.
 *
 * This exists because it did: the 3D viewport constructs a `WebGLRenderer` in an effect,
 * and on a machine without a usable WebGL context that throws. With no boundary, React
 * unmounts the entire tree and the user sees a white page with no explanation — which is
 * exactly what was reported from a second workstation. An error boundary keeps the rest
 * of the UI (and the actual message) on screen, where it can be acted on.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the detail in the console; the UI shows a readable summary.
    console.error('Panel error:', error, info?.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') return <>{fallback(error)}</>;
    if (fallback !== undefined) return <>{fallback}</>;

    return (
      <div className="h-full w-full flex items-center justify-center bg-[#1e1e1e] text-[#d4d4d4] p-6">
        <div className="max-w-lg space-y-3">
          <h2 className="text-sm font-semibold text-red-400">This panel failed to render</h2>
          <p className="text-xs text-[#a0a0a0]">
            The rest of the application is still usable. The error was:
          </p>
          <pre className="text-[11px] whitespace-pre-wrap break-words bg-[#252526] border border-[#3c3c3c] rounded p-3 text-[#e0a0a0]">
            {error.message}
          </pre>
          <button
            onClick={this.reset}
            className="px-3 py-1 bg-[#3c3c3c] hover:bg-[#4a4a4a] rounded text-xs"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
