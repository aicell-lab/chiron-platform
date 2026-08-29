import React, { useEffect, useMemo, useState } from 'react';
import { buildIssueReport, submitIssueReport, IssueReportPayload } from '../utils/issueReport';

interface ReportIssueDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Collect a problem report from the browser.
 *
 * The description field is optional on purpose. A user who has just hit a bug
 * usually cannot say what went wrong, and the logs answer that better than
 * they can. What the description is good for is what the logs cannot show:
 * what the user was trying to do.
 *
 * Everything that would be sent is viewable before sending. A report carries
 * the reporter's browser details and the app's own log buffer, and it is not
 * reasonable to ask someone to send that without letting them look at it
 * first.
 */
const ReportIssueDialog: React.FC<ReportIssueDialogProps> = ({ open, onClose }) => {
  const [description, setDescription] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);

  // Snapshot the moment the dialog opens, so the buffer the reporter reviews
  // is the buffer that gets sent, and so nothing the dialog itself logs while
  // it is open ends up in the report.
  const [payload, setPayload] = useState<IssueReportPayload | null>(null);

  useEffect(() => {
    if (!open) return;
    setDescription('');
    setShowPayload(false);
    setSubmitting(false);
    setError(null);
    setArtifactId(null);
    try {
      setPayload(buildIssueReport(''));
    } catch (err) {
      // A report that cannot be assembled is still worth reporting; fall back
      // to a bare payload so the dialog stays usable.
      setError(err instanceof Error ? err.message : String(err));
      setPayload(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  const preview = useMemo(() => {
    if (!payload) return '';
    return JSON.stringify({ ...payload, description }, null, 2);
  }, [payload, description]);

  const handleSubmit = async () => {
    if (!payload) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitIssueReport(description, { ...payload, description });
      setArtifactId(result.artifactId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ zIndex: 60 }}
      onClick={() => { if (!submitting) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-issue-title"
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-start gap-4">
          <div className="min-w-0">
            <h3 id="report-issue-title" className="text-base font-semibold text-gray-900">
              Report an issue
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              No account needed. The platform attaches its own logs so you do not have to
              reconstruct what happened.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0 -mr-1 -mt-1 p-1 disabled:opacity-40"
            aria-label="Close report dialog"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {artifactId ? (
            <div className="text-sm text-gray-700 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 bg-green-50 border border-green-200 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Report sent. Thank you.</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Quote this id if you follow up:
                  </p>
                  <code className="text-xs bg-gray-100 rounded px-2 py-1 mt-1 inline-block break-all">
                    {artifactId}
                  </code>
                </div>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="report-issue-description" className="block text-sm font-medium text-gray-700 mb-1">
                What were you trying to do? <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                id="report-issue-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
                rows={5}
                placeholder="For example: I clicked Start Training and nothing happened."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50"
              />

              <div className="mt-4 border border-gray-200 rounded-lg">
                <button
                  type="button"
                  onClick={() => setShowPayload(!showPayload)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg"
                >
                  <span>What gets sent</span>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${showPayload ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showPayload && (
                  <div className="px-3 pb-3 border-t border-gray-100">
                    <ul className="text-xs text-gray-600 list-disc pl-4 my-2 space-y-1">
                      <li>Your description, exactly as typed above.</li>
                      <li>Browser, window size and the page you are on.</li>
                      <li>
                        The platform&apos;s log buffer
                        {payload ? ` (${payload.logs.length} entries)` : ''}, with access tokens
                        and file paths stripped out.
                      </li>
                      <li>
                        {payload?.identity
                          ? `Your Hypha account (${payload.identity.email || payload.identity.id}), because you are signed in.`
                          : 'No account details, because you are not signed in.'}
                      </li>
                    </ul>
                    <pre className="text-[11px] leading-relaxed font-mono bg-gray-50 border border-gray-200 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-gray-700">
                      {preview}
                    </pre>
                  </div>
                )}
              </div>

              {error && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-sm font-medium text-red-800">Could not send the report</p>
                  <pre className="text-xs text-red-700 whitespace-pre-wrap break-words mt-1 max-h-32 overflow-auto">
                    {error}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 flex-shrink-0">
          {artifactId ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !payload}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Sending…' : 'Send report'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportIssueDialog;
