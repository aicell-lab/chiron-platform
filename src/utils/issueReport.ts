/**
 * Submit a problem report from the browser.
 *
 * A report is one artifact in the `chiron-platform/issues` collection. The
 * collection grants `list`, `draft` and `attach` to everyone, so a visitor who
 * is not signed in can file one, and grants no `read` and no `get_file`, so
 * nobody can read anybody else's. The manifest is deliberately content free
 * because `list` cannot be withheld (creating a child needs it) and `list`
 * returns manifests. Everything that matters lives in the attached
 * `report.json`, which is unreadable without maintainer credentials.
 *
 * Two details that look like style choices but are not:
 *
 * 1. This connects over the websocket client rather than the HTTP helper the
 *    rest of the app uses. An unauthenticated HTTP call to Hypha runs as the
 *    single shared identity `anonymouz-http`, and a new artifact grants its
 *    creator `*`, so a report filed over HTTP would be readable and editable
 *    by every later anonymous HTTP visitor. An unauthenticated websocket
 *    connection mints a fresh short-lived identity per connection instead.
 * 2. The alias placeholders are expanded server side, so the browser never
 *    picks the id and a reporter cannot guess or collide with another one.
 */

import { hyphaWebsocketClient } from 'hypha-rpc';
import {
  HYPHA_SERVER_URL,
  ISSUES_COLLECTION_ID,
  ISSUE_CHANNEL_URL,
  ISSUE_CHANNEL_ID,
  ISSUE_CHANNEL_KEY,
} from '../config/hypha';
import { API_VERSION } from './env';
import { useHyphaStore } from '../store/hyphaStore';
import { logger, LogEntry } from './logger';

/** Hard ceiling on the serialised payload. Oldest log entries are dropped to fit. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface IssueReportContext {
  userAgent: string;
  language: string;
  viewport: string;
  /** Route only, never the query string, which carries ids the reporter has not agreed to hand over. */
  route: string;
  appVersion: string;
  hyphaServerUrl: string;
  /** Browser clock offset, so a timestamp in the logs can be read against ours. */
  timezone: string;
}

export interface IssueReportIdentity {
  id: string;
  email?: string;
}

export interface IssueReportPayload {
  schema: 1;
  submittedAt: string;
  /** Free text from the reporter. Optional, and a hint rather than evidence. */
  description: string;
  context: IssueReportContext;
  /** The signed-in user, or null for an anonymous report. */
  identity: IssueReportIdentity | null;
  logs: LogEntry[];
  /** Set when log entries had to be dropped to fit the size cap. */
  logsTruncated?: number;
}

/** Everything that would be sent right now, so the dialog can show it first. */
export function buildIssueReport(description: string): IssueReportPayload {
  const state = useHyphaStore.getState();
  const user = state.user;

  return {
    schema: 1,
    submittedAt: new Date().toISOString(),
    description,
    context: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      route: window.location.hash.split('?')[0] || '#/',
      appVersion: API_VERSION,
      hyphaServerUrl: HYPHA_SERVER_URL,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    identity: user?.id ? { id: user.id, email: user.email } : null,
    logs: logger.snapshot(),
  };
}

/**
 * Serialise, dropping oldest log entries until the payload fits. A report that
 * is too large to send is worth less than a report that is missing its first
 * few lines.
 */
function serialiseWithinCap(payload: IssueReportPayload): string {
  let dropped = 0;
  let body = { ...payload };
  let text = JSON.stringify(body);
  while (text.length > MAX_PAYLOAD_BYTES && body.logs.length > 0) {
    const drop = Math.max(1, Math.ceil(body.logs.length * 0.1));
    body = { ...body, logs: body.logs.slice(drop), logsTruncated: (dropped += drop) };
    text = JSON.stringify(body);
  }
  return text;
}

/**
 * Tell a maintainer session that a report arrived. Fire and forget by design:
 * the artifact is already committed by the time this runs, so a failure here
 * costs a few hours of latency (the daily sweep picks it up) and never costs
 * the report.
 */
async function notifyChannel(artifactId: string): Promise<void> {
  if (!ISSUE_CHANNEL_URL) return;
  try {
    await fetch(ISSUE_CHANNEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The Hypha gateway drops a raw body and a ?channel= query string alike.
      // The arguments have to arrive wrapped in `kwargs`.
      body: JSON.stringify({
        kwargs: {
          channel: ISSUE_CHANNEL_ID,
          from: 'chiron-platform-web',
          key: ISSUE_CHANNEL_KEY,
          // Nothing here waits for an answer, so do not park the message in a
          // reply queue the browser will never poll.
          no_reply: true,
          message: `New issue report: ${artifactId}`,
        },
      }),
    });
    logger.info('issueReport', 'Notified maintainer channel', { artifactId });
  } catch (error) {
    logger.warn('issueReport', 'Channel notification failed, report is already filed', { artifactId }, error);
  }
}

export interface SubmitIssueReportResult {
  artifactId: string;
}

/**
 * Write the report and return the artifact id. Throws with a message fit to
 * show the reporter.
 */
export async function submitIssueReport(
  description: string,
  payloadOverride?: IssueReportPayload,
): Promise<SubmitIssueReportResult> {
  const payload = payloadOverride ?? buildIssueReport(description);
  const text = serialiseWithinCap(payload);

  const token = useHyphaStore.getState().hyphaToken ?? undefined;
  logger.info('issueReport', 'Submitting report', {
    bytes: text.length,
    logs: payload.logs.length,
    authenticated: !!token,
    hasDescription: !!description.trim(),
  });

  let server: any = null;
  try {
    // A dedicated connection, not the app's shared one: an anonymous visitor
    // has no shared connection to reuse, and a signed-in one should not have
    // the app's session disturbed by a report.
    server = await hyphaWebsocketClient.connectToServer({
      server_url: HYPHA_SERVER_URL,
      token,
      client_id: `chiron-issue-${Math.random().toString(36).slice(2, 10)}`,
    });
    const artifactManager = await server.getService('public/artifact-manager');

    const artifact = await artifactManager.create({
      parent_id: ISSUES_COLLECTION_ID,
      alias: 'issue-{timestamp}-{uuid}',
      stage: true,
      manifest: {
        name: 'Chiron issue report',
        description: 'Submitted from the web UI',
      },
      _rkwargs: true,
    });

    const putUrl = await artifactManager.put_file({
      artifact_id: artifact.id,
      file_path: 'report.json',
      _rkwargs: true,
    });
    const upload = await fetch(putUrl, {
      method: 'PUT',
      body: text,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!upload.ok) {
      const body = await upload.text();
      throw new Error(`Upload failed with HTTP ${upload.status}: ${body.slice(0, 500)}`);
    }

    await artifactManager.commit({ artifact_id: artifact.id, _rkwargs: true });
    logger.info('issueReport', 'Report filed', { artifactId: artifact.id });

    await notifyChannel(artifact.id);
    return { artifactId: artifact.id };
  } catch (error) {
    logger.error('issueReport', 'Failed to file report', error);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      await server?.disconnect();
    } catch {
      // The report is already committed. A connection that will not close
      // cleanly is not worth failing the submission over.
    }
  }
}
