import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHyphaStore } from '../store/hyphaStore';
import { ArtifactRef, listArtifactChildren, resolveCoverUrl } from '../utils/artifactApi';
import { RiLoginBoxLine } from 'react-icons/ri';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { BiLoaderAlt } from 'react-icons/bi';

const MODELS_COLLECTION = 'chiron-platform/chiron-models';

const StagedBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
    Draft
  </span>
);

const PublishedBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
    Published
  </span>
);

interface ModelRowProps {
  artifact: ArtifactRef;
  onPublish: (artifact: ArtifactRef) => Promise<void>;
  isPublishing: boolean;
}

const ModelRow: React.FC<ModelRowProps> = ({ artifact, onPublish, isPublishing }) => {
  const manifest = artifact.manifest || {};
  const name: string = manifest.name || artifact.alias || artifact.id.split('/').pop() || artifact.id;
  const description: string = manifest.description || '';
  const cover = resolveCoverUrl(manifest.cover, artifact.id);
  const alias = artifact.alias || artifact.id.split('/').pop();
  // Hypha marks staged children with staging != null in the artifact record.
  // We also accept committed_at === null as a fallback.
  // Hypha's artifact record exposes `staging: true` while the artifact is a
  // draft, and `staging: false` after commit promotes it. `committed_at` is
  // not a reliable signal on this Hypha version (always null in our tests).
  const isStaged = (artifact as any).staging === true;

  return (
    <div className="flex items-stretch gap-4 bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="w-32 sm:w-44 flex-shrink-0 bg-gray-50 flex items-center justify-center">
        {cover ? (
          <img src={cover} alt={name} className="object-contain w-full h-full p-2" loading="lazy" />
        ) : (
          <span className="text-3xl text-gray-300">🧬</span>
        )}
      </div>
      <div className="flex-1 min-w-0 p-4 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 truncate" title={name}>
              {alias ? (
                <Link to={`/models/${alias}`} className="hover:underline">{name}</Link>
              ) : name}
            </h3>
            <p className="text-xs text-gray-400 font-mono truncate" title={artifact.id}>{artifact.id}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isStaged ? <StagedBadge /> : <PublishedBadge />}
          </div>
        </div>
        {description && (
          <p className="text-sm text-gray-600 line-clamp-2">{description}</p>
        )}
        {isStaged && (
          <div className="mt-auto pt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => { void onPublish(artifact); }}
              disabled={isPublishing}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isPublishing ? <><BiLoaderAlt className="animate-spin" size={14} /> Publishing…</> : 'Publish to Model Hub'}
            </button>
            <span className="text-xs text-gray-500">Drafts are visible only to you until you publish.</span>
          </div>
        )}
      </div>
    </div>
  );
};

const MyModels: React.FC = () => {
  const { user, isLoggedIn, artifactManager, hyphaToken } = useHyphaStore();
  const [items, setItems] = useState<ArtifactRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track in-flight publish actions per artifact id so multiple rows can
  // each show their own spinner without blocking the others.
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set());
  const [publishError, setPublishError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      // Pull both staged (drafts) and committed (published) artifacts under
      // the chiron-models collection, then JS-filter on either
      // manifest.uploaded_by_user_id or manifest.uploaded_by_user_email
      // matching the logged-in user. The same human can show up under
      // different Hypha ids depending on whether they authenticated via
      // OAuth (e.g. github|49943582) or via a personal token (e.g.
      // hungry-scooter-22449731) — the email is the only stable link, but
      // the id match still covers cases where the email is missing.
      const { items: allItems } = await listArtifactChildren(MODELS_COLLECTION, {
        stage: 'all',
        limit: 200,
        token: hyphaToken || undefined,
      });
      const myId = user.id;
      const myEmail = (user as any)?.email as string | undefined;
      const items = allItems.filter(a => {
        const m = (a.manifest || {}) as any;
        if (m.uploaded_by_user_id && m.uploaded_by_user_id === myId) return true;
        if (myEmail && m.uploaded_by_user_email && m.uploaded_by_user_email === myEmail) return true;
        return false;
      });
      // Sort: drafts first (so review is one click away), then by name.
      const sorted = [...items].sort((a, b) => {
        const aStaged = (a as any).staging === true;
        const bStaged = (b as any).staging === true;
        if (aStaged !== bStaged) return aStaged ? -1 : 1;
        const an = (a.manifest?.name || a.alias || '').toLowerCase();
        const bn = (b.manifest?.name || b.alias || '').toLowerCase();
        return an.localeCompare(bn);
      });
      setItems(sorted);
    } catch (e: any) {
      setError(e?.message || 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, [user?.id, hyphaToken]);

  useEffect(() => { void load(); }, [load]);

  const handlePublish = useCallback(async (artifact: ArtifactRef) => {
    if (!artifactManager) {
      setPublishError('Hypha is not connected; refresh and try again.');
      return;
    }
    setPublishError(null);
    setPublishingIds(prev => new Set(prev).add(artifact.id));
    try {
      await artifactManager.commit({ artifact_id: artifact.id, _rkwargs: true });
      // Optimistically flip the row in local state so the badge / button
      // updates immediately. The next load() pass will overwrite this
      // with whatever the server actually has.
      setItems(prev => prev.map(a => a.id === artifact.id ? { ...a, staging: false } as any : a));
    } catch (e: any) {
      setPublishError(e?.message || 'Failed to publish');
    } finally {
      setPublishingIds(prev => {
        const next = new Set(prev);
        next.delete(artifact.id);
        return next;
      });
    }
  }, [artifactManager]);

  if (!isLoggedIn || !user?.id) {
    return (
      <div className="container mx-auto px-4 py-16 flex flex-col items-center text-center">
        <RiLoginBoxLine className="w-12 h-12 text-gray-400 mb-3" />
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Log in to see your models</h1>
        <p className="text-gray-600 max-w-md">
          My Models lists the models you have uploaded from a Chiron training session, both drafts you haven&apos;t published yet and ones already in the{' '}
          <Link to="/models" className="text-blue-600 hover:underline">Model Hub</Link>. Log in to view yours.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">My Models</h1>
          <p className="mt-2 text-gray-600 text-sm">
            Models you&apos;ve uploaded from a Chiron training session. Drafts stay private until you publish them.
          </p>
        </div>
        <Link to="/models" className="text-sm text-blue-600 hover:underline">View Model Hub →</Link>
      </div>

      {publishError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{publishError}</div>
      )}

      {loading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-500">
          <ArrowPathIcon className="w-8 h-8 animate-spin mb-3" />
          <span>Loading models…</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-700">
          <div className="font-medium">Could not load models</div>
          <div className="mt-1 break-words">{error}</div>
          <button onClick={() => void load()} className="mt-3 text-red-700 underline hover:text-red-900">Retry</button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <div className="text-lg font-medium text-gray-700 mb-1">No models yet</div>
          <div className="text-sm">
            Train a model on the{' '}
            <Link to="/training" className="text-blue-600 hover:underline">Training</Link>{' '}
            page and click <span className="font-medium">Upload Model</span> to add it here.
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-3">
          {items.map(a => (
            <ModelRow
              key={a.id}
              artifact={a}
              onPublish={handlePublish}
              isPublishing={publishingIds.has(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default MyModels;
