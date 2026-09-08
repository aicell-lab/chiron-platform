import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArtifactRef,
  ArtifactFile,
  getArtifactFileUrl,
  listArtifactFiles,
  readArtifact,
} from '../utils/artifactApi';
import CoverImage from '../components/models/CoverImage';
import { useHyphaStore } from '../store/hyphaStore';
import { ArrowPathIcon, ArrowLeftIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { BiLoaderAlt } from 'react-icons/bi';

function formatBytes(bytes?: number): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * An author as the card may carry it.
 *
 * Two spellings are accepted because the collection holds both. A checkpoint
 * an orchestrator uploads knows only an email address, while a curated card is
 * written by hand and names people properly, with affiliations and ORCIDs.
 * Normalising here keeps that difference out of the markup.
 */
interface ManifestAuthor {
  name: string;
  affiliation?: string;
  orcid?: string;
}

function normaliseAuthors(raw: unknown): ManifestAuthor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a): ManifestAuthor | null => {
      if (typeof a === 'string') return a.trim() ? { name: a.trim() } : null;
      if (a && typeof a === 'object') {
        const name = (a as any).name;
        if (typeof name !== 'string' || !name.trim()) return null;
        return {
          name: name.trim(),
          affiliation: (a as any).affiliation,
          orcid: (a as any).orcid,
        };
      }
      return null;
    })
    .filter((a): a is ManifestAuthor => a !== null);
}

/** A citation entry, either `{ text, url }` or a bare string. */
interface ManifestCitation {
  text: string;
  url?: string;
}

function normaliseCitations(raw: unknown): ManifestCitation[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((c): ManifestCitation | null => {
      if (typeof c === 'string') return c.trim() ? { text: c.trim() } : null;
      if (c && typeof c === 'object') {
        const text = (c as any).text;
        const url = (c as any).url || (c as any).doi;
        if (typeof text !== 'string' || !text.trim()) return null;
        return { text: text.trim(), url: typeof url === 'string' ? url : undefined };
      }
      return null;
    })
    .filter((c): c is ManifestCitation => c !== null);
}

function formatDate(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

const ModelDetail: React.FC = () => {
  const { alias } = useParams<{ alias: string }>();
  const navigate = useNavigate();
  const { hyphaToken, artifactManager, user } = useHyphaStore();
  const artifactId = alias ? `chiron-platform/${alias}` : '';

  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [files, setFiles] = useState<ArtifactFile[]>([]);
  const [docs, setDocs] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Publish action state for staged artifacts the user can commit.
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Discard action state — only available for owned in-review artifacts.
  // Two-step: open a confirm modal, then run the delete from there.
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!artifactId) return;
      setLoading(true);
      setError(null);
      try {
        // Anonymous first, the session token only as a fallback.
        //
        // Almost everything reachable here is a published artifact in a
        // world-readable collection, and Hypha rejects a request whose
        // Authorization header has expired rather than ignoring it and
        // serving the public copy. Sending the token first would therefore
        // turn a stale login into a dead page for a model anyone can read.
        //
        // The fallback exists because this same route also serves a user's
        // own staged and in-review artifacts, reached from My Models, and
        // those nobody else can see. Whichever credential got the record is
        // then used for the file list and the documentation, so a private
        // artifact does not half-load.
        let a: ArtifactRef;
        let readToken: string | undefined;
        try {
          a = await readArtifact(artifactId);
        } catch (anonymousError) {
          if (!hyphaToken) throw anonymousError;
          a = await readArtifact(artifactId, hyphaToken);
          readToken = hyphaToken;
        }
        if (cancelled) return;
        const f = await listArtifactFiles(artifactId, readToken);
        if (cancelled) return;
        setArtifact(a);
        setFiles(f);
        // Pull documentation.md (rendered as markdown below the description).
        // If the artifact doesn't have one, leave docs null and skip the panel.
        const hasDocs = f.some(file => file.name === 'documentation.md');
        if (hasDocs) {
          try {
            const headers: Record<string, string> = {};
            if (readToken) headers['Authorization'] = `Bearer ${readToken}`;
            const r = await fetch(getArtifactFileUrl(artifactId, 'documentation.md'), { headers });
            if (r.ok) {
              const text = await r.text();
              if (!cancelled) setDocs(text);
            }
          } catch { /* docs are optional */ }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load model');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [artifactId, hyphaToken]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-16 flex flex-col items-center text-gray-500">
        <ArrowPathIcon className="w-8 h-8 animate-spin mb-3" />
        <span>Loading model…</span>
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Link to="/models" className="inline-flex items-center text-blue-600 hover:underline">
          <ArrowLeftIcon className="w-4 h-4 mr-1" />
          Back to models
        </Link>
        <div className="mt-6 bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-700">
          {error || 'Model not found.'}
        </div>
      </div>
    );
  }

  const manifest = artifact.manifest || {};
  const name = manifest.name || artifact.alias || alias || '';
  const description = manifest.description || '';
  const tissue = manifest.tissue as string | undefined;
  const tissues = Array.isArray(manifest.tissues)
    ? (manifest.tissues as string[])
    : undefined;
  const isGlobalTransformer = manifest.global_transformer === true;
  // Architecture cards (chiron-architectures) carry a `chiron` block;
  // checkpoints in chiron-models do not. The two share this page but not what
  // is worth showing on it. An architecture card is editorial: a name, a cover
  // and the documentation below. Its owner, timestamps and attached files (a
  // cover image and the markdown already rendered) are platform bookkeeping
  // that says nothing to a visitor reading about the model. A checkpoint keeps
  // those, because there the files are the weights and who uploaded them when
  // is the provenance. Neither shows the raw manifest, and neither shows the
  // artifact id, which is an internal handle.
  const isArchitecture = !!manifest.chiron;
  // Credit and terms, carried by the artifact itself. A checkpoint states its
  // own, rather than inheriting from the architecture card, because a
  // checkpoint someone fine-tuned and published is not automatically covered
  // by the terms of the model it started from. `upstream` is the block a
  // mirrored third-party release carries, so it is the last place to look for
  // a repository, a licence or a citation.
  const upstream = (manifest.upstream || {}) as Record<string, any>;
  const authors = normaliseAuthors(manifest.authors);
  const citations = normaliseCitations(manifest.cite || manifest.citation || upstream.citation);
  const license: string | undefined = manifest.license || upstream.license;
  const licenseUrl: string | undefined = manifest.license_url || upstream.license_url;
  const repository: string | undefined = manifest.repository || upstream.repository;
  // `manifest.author` is a single address written by whichever service pushed
  // the artifact, so it is the uploader and not an author in the credit sense.
  const uploader: string | undefined = isArchitecture
    ? undefined
    : manifest.author || artifact.created_by;
  const createdAt: number | undefined = manifest.created_at || artifact.created_at;
  // Publish state lives on `manifest.status`:
  //   • "in_review"        — uploaded from the trainer/orchestrator, hidden
  //                          from the public Model Hub, awaiting owner review.
  //   • "published"        — owner clicked Publish; visible on the Hub.
  //   • "request_deletion" — owner clicked Discard. chiron-models grants
  //                          users rw+ (no delete), so the artifact stays
  //                          in the collection until a workspace admin
  //                          sweeps it; meanwhile both the Hub grid and
  //                          MyModels hide / annotate it.
  //   • undefined          — legacy artifact (predates the field). Treated
  //                          as published so curated tabula-* models keep
  //                          showing.
  const status = (manifest.status as string | undefined) || 'published';
  const isInReview = status === 'in_review';
  const isPendingDeletion = status === 'request_deletion';
  const userEmail = (user as any)?.email as string | undefined;
  const ownsArtifact = (
    (manifest.uploaded_by_user_id && manifest.uploaded_by_user_id === user?.id) ||
    (userEmail && manifest.uploaded_by_user_email && manifest.uploaded_by_user_email === userEmail)
  );

  const handlePublish = async () => {
    if (!artifactManager || !artifactId) return;
    setPublishError(null);
    setPublishing(true);
    try {
      // Flip the manifest status and persist. edit+commit, not just commit,
      // because the source of truth for visibility on the Model Hub is the
      // status field — Hypha's own staging flag is unreliable here (the
      // orchestrator's create(stage=True) auto-commits in practice).
      const newManifest = { ...manifest, status: 'published' };
      await artifactManager.edit({
        artifact_id: artifactId,
        manifest: newManifest,
        stage: true,
        _rkwargs: true,
      });
      await artifactManager.commit({ artifact_id: artifactId, _rkwargs: true });
      setArtifact(prev => prev ? ({ ...prev, manifest: newManifest } as ArtifactRef) : prev);
    } catch (e: any) {
      setPublishError(e?.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  };

  const handleDiscard = async () => {
    if (!artifactManager || !artifactId) return;
    setDiscardError(null);
    setDiscarding(true);
    try {
      // The chiron-models collection grants users `rw+` (read + write +
      // create), but NOT `delete` — only the workspace admin can actually
      // remove an artifact + its files. So instead of `artifact_manager.delete`,
      // flip the manifest status to `request_deletion`. The public Model Hub
      // grid filters these out; MyModels shows them greyed out with an
      // "Undo deletion request" affordance so the user can recover.
      //
      // Stash the current status under `previous_status` so Undo can put
      // the artifact back where it came from (in_review vs. published)
      // instead of guessing.
      const newManifest = {
        ...manifest,
        status: 'request_deletion',
        previous_status: status,
      };
      await artifactManager.edit({
        artifact_id: artifactId,
        manifest: newManifest,
        stage: true,
        _rkwargs: true,
      });
      await artifactManager.commit({ artifact_id: artifactId, _rkwargs: true });
      setShowDiscardConfirm(false);
      navigate('/my-models');
    } catch (e: any) {
      setDiscardError(e?.message || 'Failed to discard');
    } finally {
      setDiscarding(false);
    }
  };

  const handleUndoDiscard = async () => {
    if (!artifactManager || !artifactId) return;
    setDiscardError(null);
    setDiscarding(true);
    try {
      // Restore the status the artifact had before the discard request.
      // Falls back to "published" so artifacts whose previous_status was
      // never recorded (manually flipped, or pre-undo flow) still come
      // back somewhere sensible. We strip previous_status from the
      // manifest so a future Discard captures a fresh snapshot.
      const restored = (manifest.previous_status as string | undefined) || 'published';
      const { previous_status: _drop, ...rest } = manifest;
      const newManifest = { ...rest, status: restored };
      await artifactManager.edit({
        artifact_id: artifactId,
        manifest: newManifest,
        stage: true,
        _rkwargs: true,
      });
      await artifactManager.commit({ artifact_id: artifactId, _rkwargs: true });
      setArtifact(prev => prev ? ({ ...prev, manifest: newManifest } as ArtifactRef) : prev);
    } catch (e: any) {
      setDiscardError(e?.message || 'Failed to undo deletion request');
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Link to="/models" className="inline-flex items-center text-blue-600 hover:underline mb-4">
        <ArrowLeftIcon className="w-4 h-4 mr-1" />
        Back to models
      </Link>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {manifest.cover && (
          <div className="w-full bg-gray-50 flex items-center justify-center py-6 border-b border-gray-100">
            <CoverImage
              cover={manifest.cover}
              artifactId={artifact.id}
              alt={name}
              className="max-h-32 max-w-[60%] object-contain"
              loading="eager"
            />
          </div>
        )}

        <div className="p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {isPendingDeletion ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    Pending deletion
                  </span>
                ) : isInReview ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    In review
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Published
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-semibold text-gray-900">{name}</h1>
            </div>
            {ownsArtifact && (
              <div className="flex flex-col gap-2 flex-shrink-0">
                {isPendingDeletion ? (
                  <button
                    type="button"
                    onClick={handleUndoDiscard}
                    disabled={discarding}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.97]"
                  >
                    {discarding ? <><BiLoaderAlt className="animate-spin" size={14} /> Restoring…</> : 'Undo deletion request'}
                  </button>
                ) : (
                  <>
                    {isInReview && (
                      <button
                        type="button"
                        onClick={handlePublish}
                        disabled={publishing || discarding}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.97]"
                      >
                        {publishing ? <><BiLoaderAlt className="animate-spin" size={14} /> Publishing…</> : 'Publish to Model Hub'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setDiscardError(null); setShowDiscardConfirm(true); }}
                      disabled={publishing || discarding}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 hover:bg-red-50 text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.97]"
                    >
                      Discard Model
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {description && (
            <p className="mt-2 text-gray-700 whitespace-pre-line">{description}</p>
          )}
          {isInReview && ownsArtifact && (
            <p className="mt-2 text-xs text-gray-500">
              This model is in review and only visible to you on My Models. Publish it to make it appear in the public Model Hub.
            </p>
          )}
          {isPendingDeletion && ownsArtifact && (
            <p className="mt-2 text-xs text-gray-500">
              You requested this model be deleted. It's hidden from the public Model Hub until a workspace admin removes it. Click <span className="font-medium">Undo deletion request</span> to bring it back.
            </p>
          )}
          {publishError && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{publishError}</div>
          )}
          {discardError && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{discardError}</div>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {tissue && (
              <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100 capitalize">
                {tissue}
              </span>
            )}
            {tissues && tissues.map(t => (
              <span key={t} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100 capitalize">
                {t}
              </span>
            ))}
            {isGlobalTransformer && (
              <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-100">
                Global transformer
              </span>
            )}
          </div>

          {/* Who made the model, under what terms, and where it came from.
              This sits high on the page rather than in the documentation
              because it is what a visitor has to check before they can use a
              checkpoint at all, and Tabula's terms are not the permissive
              default anyone would assume. Shown for architecture cards too:
              credit and licensing describe the model, not the bookkeeping of
              the artifact that carries it. */}
          {(authors.length > 0 || license || repository || citations.length > 0 || uploader) && (
            <div className="mt-4 space-y-1.5 text-sm text-gray-600">
              {authors.length > 0 && (
                <div>
                  <span className="font-medium text-gray-700">Authors:</span>{' '}
                  {authors.map((a, i) => (
                    <React.Fragment key={`${a.name}-${i}`}>
                      {i > 0 && ', '}
                      {a.orcid ? (
                        <a
                          href={a.orcid.startsWith('http') ? a.orcid : `https://orcid.org/${a.orcid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                          title={a.affiliation}
                        >
                          {a.name}
                        </a>
                      ) : (
                        <span title={a.affiliation}>{a.name}</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}
              {license && (
                <div>
                  <span className="font-medium text-gray-700">License:</span>{' '}
                  {licenseUrl ? (
                    <a
                      href={licenseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {license}
                    </a>
                  ) : (
                    license
                  )}
                </div>
              )}
              {repository && (
                <div>
                  <span className="font-medium text-gray-700">Repository:</span>{' '}
                  <a
                    href={repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline break-all"
                  >
                    {repository.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              )}
              {citations.map((c, i) => (
                <div key={`cite-${i}`}>
                  <span className="font-medium text-gray-700">Cite:</span>{' '}
                  {c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {c.text}
                    </a>
                  ) : (
                    c.text
                  )}
                </div>
              ))}
              {uploader && (
                <div>
                  <span className="font-medium text-gray-700">Uploader:</span>{' '}
                  {uploader}
                </div>
              )}
            </div>
          )}

          {/* Dates last and small. They are provenance for a checkpoint rather
              than something a reader came for, so they close the box instead of
              competing with the authors and the licence above. */}
          {!isArchitecture && (createdAt || artifact.last_modified) && (
            <div className="mt-4 pt-3 border-t border-gray-100 text-xs text-gray-500">
              {createdAt && <>Created {formatDate(createdAt)}</>}
              {createdAt && artifact.last_modified && <span className="mx-2">·</span>}
              {artifact.last_modified && <>Last edited {formatDate(artifact.last_modified)}</>}
            </div>
          )}
        </div>
      </div>

      {docs && (
        <div className="mt-6 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Documentation</h2>
          </div>
          <article className="markdown-body px-6 py-4 prose prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{docs}</ReactMarkdown>
          </article>
        </div>
      )}

      {!isArchitecture && (
        <div className="mt-6 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Files</h2>
          </div>
          {files.length === 0 ? (
            <div className="px-6 py-6 text-sm text-gray-500">No files attached.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {files.map((f) => (
                <li key={f.name} className="px-6 py-3 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{f.name}</div>
                    <div className="text-xs text-gray-500">
                      {formatBytes(f.size)}
                      {f.last_modified && ` · ${formatDate(f.last_modified)}`}
                    </div>
                  </div>
                  <a
                    href={getArtifactFileUrl(artifact.id, f.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    <ArrowDownTrayIcon className="w-4 h-4 mr-1" />
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showDiscardConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Discard Model</h3>
            </div>
            <div className="px-6 py-4 text-sm text-gray-700">
              <p>
                This will mark{' '}
                <span className="font-mono text-gray-900">{artifactId}</span>{' '}
                for deletion. {!isInReview && (
                  <span className="font-medium text-red-700">
                    The model is currently published — it will disappear from the public Model Hub immediately.
                  </span>
                )} A workspace admin will permanently delete the artifact and
                its files later; you can undo the request from My Models until
                then.
              </p>
              <p className="mt-2">Are you sure?</p>
            </div>
            <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                disabled={discarding}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDiscard()}
                disabled={discarding}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {discarding ? <><BiLoaderAlt className="animate-spin" size={14} /> Discarding…</> : 'Discard Model'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelDetail;
