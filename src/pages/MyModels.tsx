import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHyphaStore } from '../store/hyphaStore';
import { ArtifactRef, listArtifactChildren, resolveCoverUrl } from '../utils/artifactApi';
import { RiLoginBoxLine } from 'react-icons/ri';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

const MODELS_COLLECTION = 'chiron-platform/chiron-models';

const InReviewBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
    In review
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
}

const ModelRow: React.FC<ModelRowProps> = ({ artifact }) => {
  const manifest = artifact.manifest || {};
  const name: string = manifest.name || artifact.alias || artifact.id.split('/').pop() || artifact.id;
  const description: string = manifest.description || '';
  const cover = resolveCoverUrl(manifest.cover, artifact.id);
  const alias = artifact.alias || artifact.id.split('/').pop();
  // Status semantics live on `manifest.status` (single source of truth across
  // the Trainer/Orchestrator save_*_weights writers and the ModelDetail
  // Publish button). Missing status = legacy artifact = treat as published.
  const isInReview = manifest.status === 'in_review';

  const card = (
    <div className="flex items-stretch gap-4 bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden hover:shadow-md hover:border-blue-200 transition-all">
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
            <h3 className="text-base font-semibold text-gray-900 truncate" title={name}>{name}</h3>
            <p className="text-xs text-gray-400 font-mono truncate" title={artifact.id}>{artifact.id}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isInReview ? <InReviewBadge /> : <PublishedBadge />}
          </div>
        </div>
        {description && (
          <p className="text-sm text-gray-600 line-clamp-2">{description}</p>
        )}
        {isInReview && (
          <div className="mt-auto pt-2">
            <span className="text-xs text-gray-500">Open the model to review and publish it.</span>
          </div>
        )}
      </div>
    </div>
  );

  return alias ? <Link to={`/models/${alias}`} className="block">{card}</Link> : card;
};

const MyModels: React.FC = () => {
  const { user, isLoggedIn, hyphaToken } = useHyphaStore();
  const [items, setItems] = useState<ArtifactRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        // Artifacts the user has discarded are still in the collection
        // (chiron-models grants `rw+` to all but not `delete`) — hide them
        // from My Models so a discard click immediately removes the row.
        if (m.status === 'request_deletion') return false;
        if (m.uploaded_by_user_id && m.uploaded_by_user_id === myId) return true;
        if (myEmail && m.uploaded_by_user_email && m.uploaded_by_user_email === myEmail) return true;
        return false;
      });
      // Sort: in-review first (so the review action is one click away),
      // then by name.
      const sorted = [...items].sort((a, b) => {
        const aReview = a.manifest?.status === 'in_review';
        const bReview = b.manifest?.status === 'in_review';
        if (aReview !== bReview) return aReview ? -1 : 1;
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
            <ModelRow key={a.id} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
};

export default MyModels;
