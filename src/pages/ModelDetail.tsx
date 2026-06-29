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
  resolveCoverUrl,
} from '../utils/artifactApi';
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
        const [a, f] = await Promise.all([
          readArtifact(artifactId, hyphaToken || undefined),
          listArtifactFiles(artifactId, hyphaToken || undefined),
        ]);
        if (cancelled) return;
        setArtifact(a);
        setFiles(f);
        // Pull documentation.md (rendered as markdown below the description).
        // If the artifact doesn't have one, leave docs null and skip the panel.
        const hasDocs = f.some(file => file.name === 'documentation.md');
        if (hasDocs) {
          try {
            const headers: Record<string, string> = {};
            if (hyphaToken) headers['Authorization'] = `Bearer ${hyphaToken}`;
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
  const cover = resolveCoverUrl(manifest.cover, artifact.id);
  const tissue = manifest.tissue as string | undefined;
  const tissues = Array.isArray(manifest.tissues)
    ? (manifest.tissues as string[])
    : undefined;
  const isGlobalTransformer = manifest.global_transformer === true;
  // Publish state lives on `manifest.status`:
  //   • "in_review"  — uploaded from the trainer/orchestrator, hidden
  //                    from the public Model Hub, awaiting owner review.
  //   • "published"  — owner clicked Publish; visible on the Hub.
  //   • undefined    — legacy artifact (predates the field). Treated as
  //                    published so curated tabula-* models keep showing.
  const status = (manifest.status as string | undefined) || 'published';
  const isInReview = status === 'in_review';
  const userEmail = (user as any)?.email as string | undefined;
  const ownsArtifact = (
    (manifest.uploaded_by_user_id && manifest.uploaded_by_user_id === user?.id) ||
    (userEmail && manifest.uploaded_by_user_email && manifest.uploaded_by_user_email === userEmail)
  );

  // Surface a curated list of manifest fields plus everything else under "Other fields".
  const featuredKeys = ['name', 'description', 'cover', 'tissue', 'tissues', 'global_transformer', 'source', 'author', 'created_at', 'uploaded_by_user_id', 'uploaded_by_user_email', 'status'];
  const otherEntries = Object.entries(manifest).filter(
    ([k]) => !featuredKeys.includes(k),
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
      // The orchestrator/trainer write the artifact with create(stage=True)
      // and the staging flag often resolves immediately on Hypha — so
      // version="stage" can already be invalid by the time the user clicks
      // discard. Try the staged-version delete first; if that fails because
      // there's no staged version, fall back to a recursive delete of the
      // committed artifact.
      try {
        await artifactManager.delete({
          artifact_id: artifactId,
          version: 'stage',
          delete_files: true,
          recursive: true,
          _rkwargs: true,
        });
      } catch (stageErr: any) {
        await artifactManager.delete({
          artifact_id: artifactId,
          delete_files: true,
          recursive: true,
          _rkwargs: true,
        });
      }
      setShowDiscardConfirm(false);
      navigate('/my-models');
    } catch (e: any) {
      setDiscardError(e?.message || 'Failed to discard');
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
        {cover && (
          <div className="w-full bg-gray-50 flex items-center justify-center py-6 border-b border-gray-100">
            <img
              src={cover}
              alt={name}
              className="max-h-32 max-w-[60%] object-contain"
            />
          </div>
        )}

        <div className="p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {isInReview ? (
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
            {isInReview && ownsArtifact && (
              <div className="flex flex-col gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={publishing || discarding}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.97]"
                >
                  {publishing ? <><BiLoaderAlt className="animate-spin" size={14} /> Publishing…</> : 'Publish to Model Hub'}
                </button>
                <button
                  type="button"
                  onClick={() => { setDiscardError(null); setShowDiscardConfirm(true); }}
                  disabled={publishing || discarding}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 hover:bg-red-50 text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.97]"
                >
                  Discard Model
                </button>
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

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-gray-600">
            <div>
              <span className="font-medium text-gray-700">Artifact ID:</span>{' '}
              <code className="text-xs bg-gray-50 px-1.5 py-0.5 rounded">{artifact.id}</code>
            </div>
            {(manifest.author || artifact.created_by) && (
              <div>
                <span className="font-medium text-gray-700">Created by:</span>{' '}
                {manifest.author || artifact.created_by}
              </div>
            )}
            {(manifest.created_at || artifact.created_at) && (
              <div>
                <span className="font-medium text-gray-700">Created:</span>{' '}
                {formatDate(manifest.created_at || artifact.created_at)}
              </div>
            )}
            {artifact.last_modified && (
              <div>
                <span className="font-medium text-gray-700">Last modified:</span>{' '}
                {formatDate(artifact.last_modified)}
              </div>
            )}
          </div>
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

      {otherEntries.length > 0 && (
        <div className="mt-6 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Manifest</h2>
          </div>
          <div className="px-6 py-4">
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              {otherEntries.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="font-medium text-gray-700">{k}</dt>
                  <dd className="sm:col-span-2 text-gray-600 break-words">
                    {typeof v === 'object' ? (
                      <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(v, null, 2)}
                      </pre>
                    ) : (
                      String(v)
                    )}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
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
                This will permanently delete{' '}
                <span className="font-mono text-gray-900">{artifactId}</span>{' '}
                and all of its files from Chiron Models. This cannot be undone.
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
