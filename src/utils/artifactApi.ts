// Lightweight HTTP helpers for the Hypha Artifact Manager — used by the model
// browsing UI. Mirrors the per-artifact endpoint pattern already used by
// hyphaStore.fetchResources / fetchResource (REST under /<ws>/artifacts/...).
// Keeps the Models / MyModels pages usable for anonymous visitors too: the
// chiron-platform/chiron-models collection has {"*": "r+"} permissions, so
// listing + reading works without auth; only the per-user filter needs a
// logged-in user.

const HYPHA_BASE = 'https://hypha.aicell.io';

export interface ArtifactRef {
  id: string;
  alias?: string;
  type?: string;
  workspace?: string;
  parent_id?: string | null;
  manifest?: Record<string, any>;
  created_at?: number;
  created_by?: string;
  last_modified?: number;
  download_count?: number;
  view_count?: number;
  file_count?: number;
  versions?: { version: string; comment?: string; created_at?: number }[];
  config?: Record<string, any>;
}

export interface ArtifactFile {
  name: string;
  type?: string;
  size?: number;
  last_modified?: number;
}

export interface ListChildrenOptions {
  /** JSON filters object — e.g. `{ created_by: userId }`. */
  filters?: Record<string, any>;
  /** Comma-separated keyword search. */
  keywords?: string;
  /** Page size (default 50). */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** Auth token for non-public collections. */
  token?: string;
  /** "all" returns committed + staged children; "committed" (default) only
   * published artifacts; "staged" only drafts. Needed for My Models so the
   * operator can review their uploaded-but-not-yet-published artifacts. */
  stage?: 'all' | 'committed' | 'staged';
}

/**
 * GET /<workspace>/artifacts/<alias>/children — returns a plain array of
 * children. `parentId` must be "<workspace>/<alias>".
 */
export async function listArtifactChildren(
  parentId: string,
  opts: ListChildrenOptions = {},
): Promise<{ items: ArtifactRef[]; total: number }> {
  const [workspace, ...rest] = parentId.split('/');
  const alias = rest.join('/');
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const url = new URL(`${HYPHA_BASE}/${workspace}/artifacts/${alias}/children`);
  url.searchParams.set('pagination', 'true');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (opts.filters && Object.keys(opts.filters).length > 0) {
    url.searchParams.set('filters', JSON.stringify(opts.filters));
  }
  if (opts.keywords) {
    url.searchParams.set('keywords', opts.keywords);
  }
  if (opts.stage) {
    url.searchParams.set('stage', opts.stage);
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} listing ${parentId}/children: ${await res.text()}`);
  }
  const data = await res.json();
  // Paginated response shape: { items, total }; non-paginated: bare array
  if (Array.isArray(data)) {
    return { items: data as ArtifactRef[], total: data.length };
  }
  return { items: (data.items || []) as ArtifactRef[], total: data.total ?? 0 };
}

/**
 * GET /<workspace>/artifacts/<alias> — returns the artifact's full record.
 */
export async function readArtifact(artifactId: string, token?: string): Promise<ArtifactRef> {
  const [workspace, ...rest] = artifactId.split('/');
  const alias = rest.join('/');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${HYPHA_BASE}/${workspace}/artifacts/${alias}`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} reading ${artifactId}: ${await res.text()}`);
  }
  return (await res.json()) as ArtifactRef;
}

/**
 * GET /<workspace>/artifacts/<alias>/files/ — list of files attached to the
 * artifact. Each entry has `name`, `size`, etc.
 */
export async function listArtifactFiles(artifactId: string, token?: string): Promise<ArtifactFile[]> {
  const [workspace, ...rest] = artifactId.split('/');
  const alias = rest.join('/');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Trailing slash matters — without it Hypha 404s.
  const res = await fetch(`${HYPHA_BASE}/${workspace}/artifacts/${alias}/files/`, { headers });
  if (!res.ok) {
    // Some artifacts have no files endpoint — return empty rather than throwing.
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items || []);
}

/**
 * Stable download/view URL for a file inside an artifact. The Hypha gateway
 * 302-redirects to a presigned S3 URL.
 */
export function getArtifactFileUrl(artifactId: string, filePath: string): string {
  const [workspace, ...rest] = artifactId.split('/');
  const alias = rest.join('/');
  return `${HYPHA_BASE}/${workspace}/artifacts/${alias}/files/${filePath}`;
}

/**
 * Resolve a manifest `cover` field into something a browser `<img src>` can
 * use. Accepts either an absolute https URL (used by our seed script) or a
 * relative path (resolved against the artifact's file root).
 */
export function resolveCoverUrl(manifestCover: unknown, artifactId: string): string | null {
  if (!manifestCover || typeof manifestCover !== 'string') return null;
  if (manifestCover.startsWith('http://') || manifestCover.startsWith('https://')) {
    return manifestCover;
  }
  return getArtifactFileUrl(artifactId, manifestCover);
}
