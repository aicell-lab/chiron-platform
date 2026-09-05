/**
 * Points the user at the Report Issue button when something unexpected breaks.
 *
 * The button lives in the footer, which on most pages is several screens below
 * the fold. When an error banner appears mid-page there is nothing to connect
 * it to the reporting path, so the error reads as a dead end. This module lets
 * any error surface say "an unexpected error is now on screen" without knowing
 * where the button is, and lets the footer answer by scrolling itself into view
 * and ringing the button.
 *
 * Deliberately an event on `window` rather than a store: the only subscriber is
 * the footer, the payload is a single string, and a store slice would make
 * every error surface import the store just to fire one call.
 */

const EVENT = 'chiron:report-issue-prompt';

/**
 * Minimum gap between two prompts.
 *
 * Errors arrive in bursts. A failing poll can raise the same banner every few
 * seconds, and a page that scroll-jumps to the footer on each one is worse than
 * one that never points at the button at all. One prompt per minute is enough
 * to be noticed once and not enough to fight the user for the scroll position.
 */
const COOLDOWN_MS = 60_000;

let lastPromptAt = 0;

export interface ReportIssuePromptDetail {
  /** Short human-readable reason, shown in the footer's callout. */
  reason: string;
}

/**
 * Ask the footer to draw attention to the Report Issue button.
 *
 * Call this only for errors the user can actually see and would not expect.
 * Recoverable or self-healing conditions (a retried poll, a cancelled request)
 * must not call it: a prompt that fires on noise trains the user to ignore it.
 */
export function promptReportIssue(reason: string): void {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  if (now - lastPromptAt < COOLDOWN_MS) return;
  lastPromptAt = now;

  window.dispatchEvent(
    new CustomEvent<ReportIssuePromptDetail>(EVENT, { detail: { reason } })
  );
}

/** Subscribe to prompts. Returns an unsubscribe function. */
export function onReportIssuePrompt(
  handler: (detail: ReportIssuePromptDetail) => void
): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<ReportIssuePromptDetail>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

let globalHandlersInstalled = false;

/**
 * Prompt on errors that escape every `try/catch` in the app.
 *
 * An uncaught error or a rejected promise with no handler is the definition of
 * unexpected: no component chose to render it, so there is no banner and often
 * no visible symptom beyond a half-finished screen. These are the reports worth
 * the most, because the log buffer holds the only record of them.
 *
 * ResizeObserver's benign loop warning is excluded. Browsers raise it as an
 * uncaught error on any layout that settles over two frames, it is harmless,
 * and it is common enough to consume the cooldown that a real error needs.
 */
export function installUnexpectedErrorPrompt(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return;
  globalHandlersInstalled = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const message = event.message || event.error?.message || 'Unexpected error';
    if (message.includes('ResizeObserver loop')) return;
    promptReportIssue(message);
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
    promptReportIssue(message);
  });
}
