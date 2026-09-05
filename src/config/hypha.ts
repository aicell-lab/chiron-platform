/**
 * Single source of truth for the Hypha server URL.
 *
 * Defaults to the production endpoint (https://hypha.aicell.io). Override
 * via the REACT_APP_HYPHA_SERVER_URL environment variable at build time
 * (or REACT_APP_SERVER_URL for backwards compatibility with the existing
 * chiron-platform env) — useful for staging deployments, self-hosted
 * Hypha instances, or local outage simulations during development.
 *
 * Always import this constant instead of hardcoding the URL so that
 * environment-based overrides flow through every fetch, link, and code
 * example consistently.
 */
export const HYPHA_SERVER_URL =
  process.env.REACT_APP_HYPHA_SERVER_URL
  || process.env.REACT_APP_SERVER_URL
  || 'https://hypha.aicell.io';

/**
 * Collection that Report Issue writes into. Configured to let anyone, signed
 * in or not, create a child and attach files to it, and to let nobody read,
 * edit or delete one. See scripts/create_issues_collection.py for the exact
 * permission list and why it is spelled out rather than using a short code.
 */
export const ISSUES_COLLECTION_ID =
  process.env.REACT_APP_ISSUES_COLLECTION || 'chiron-platform/issues';

/**
 * Svamp channel that a submitted report pings so a maintainer session picks it
 * up without polling. All three values are compiled into the browser bundle
 * and are therefore public.
 *
 * The key is not a secret and the design does not need it to be. Anyone can
 * read it out of the bundle and send us a message, so a message is treated as
 * a hint and nothing more: it names an artifact id, and the first thing the
 * maintainer does is read that artifact out of the issues collection. An id
 * that does not resolve there is dropped. The evidence is the artifact.
 *
 * Leave the URL empty to disable the ping. Reports still land in the
 * collection and the daily sweep still finds them.
 */
export const ISSUE_CHANNEL_URL =
  process.env.REACT_APP_ISSUE_CHANNEL_URL
  || 'https://hypha.aicell.io/ws-user-github%7C49943582/services/machine-europa-a5a8fc28:channels/send';
export const ISSUE_CHANNEL_ID = process.env.REACT_APP_ISSUE_CHANNEL_ID || 'chiron-issues';
export const ISSUE_CHANNEL_KEY = process.env.REACT_APP_ISSUE_CHANNEL_KEY || 'ck_LATefAsttNW3twrI3lUYSHS6';
