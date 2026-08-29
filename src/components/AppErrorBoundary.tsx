import React from 'react';
import { logger } from '../utils/logger';
import ReportIssueDialog from './ReportIssueDialog';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  reportOpen: boolean;
}

/**
 * Catches a render-time crash anywhere below it.
 *
 * Without a boundary React unmounts the whole tree on an uncaught render
 * error, which the user sees as a blank white page with no footer and so no
 * way to report it. The point of catching here is to keep the page addressable:
 * the stack goes into the log buffer at error level, and the fallback carries
 * its own Report Issue button, because the footer's is gone along with the rest
 * of the tree and a crash is exactly the moment a report is worth most.
 */
class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, reportOpen: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error('react', 'Uncaught render error', error, {
      componentStack: info.componentStack,
    });
  }

  render(): React.ReactNode {
    const { error, reportOpen } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-lg w-full bg-white border border-gray-200 rounded-lg shadow-sm p-6 text-center">
          <h1 className="text-lg font-semibold text-gray-900 mb-2">
            Something went wrong on this page
          </h1>
          <p className="text-sm text-gray-600 mb-4">
            The error has been recorded in this tab's log. Send it to us, or reload
            to continue.
          </p>
          <p className="text-xs font-mono text-gray-500 bg-gray-50 rounded p-2 mb-4 break-words">
            {error.message}
          </p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => this.setState({ reportOpen: true })}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm rounded-md hover:bg-gray-50 transition-colors"
            >
              Report Issue
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>

        <ReportIssueDialog
          open={reportOpen}
          onClose={() => this.setState({ reportOpen: false })}
        />
      </div>
    );
  }
}

export default AppErrorBoundary;
