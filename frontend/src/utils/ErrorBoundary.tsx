/**
 * Containment: a crash in one panel must never blank the whole app (map,
 * timeline, and the other panels keep working). Renders a compact retry card.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`[${this.props.label}] crashed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: '10px 12px',
            margin: 8,
            fontSize: 12,
            color: 'var(--color-text-muted)',
            background: 'var(--color-card-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
          }}
        >
          {this.props.label} hit an error.{' '}
          <button
            style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
