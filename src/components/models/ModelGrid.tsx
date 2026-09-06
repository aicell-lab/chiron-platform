import React, { useEffect, useState, useCallback } from 'react';
import { ArtifactRef, listArtifactChildren } from '../../utils/artifactApi';
import ModelCard from './ModelCard';
import {
  CHIRON_MODELS,
  CHIRON_MODEL_FAMILIES,
  ChironModelFamily,
} from '../../config/chironModels';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

interface ModelGridProps {
  /** Collections to merge into one grid, in whatever order reads best. The
   *  grid sorts across all of them, so this order does not decide anything. */
  parentIds: string[];
  filters?: Record<string, any>;
  emptyMessage?: React.ReactNode;
  limit?: number;
}

/** Position of each foundation model in the grid, from the registry's own
 *  order: Tabula first, then the rest by how widely they are used. Anything
 *  that is not one of the four sorts after all of them. */
const FAMILY_RANK = new Map<string, number>(
  CHIRON_MODEL_FAMILIES.map((family, i) => [family as string, i])
);

/**
 * A grid of published artifacts from public Chiron collections.
 *
 * The listing is deliberately anonymous. Everything this grid shows is
 * committed and world-readable, so a token adds nothing, and sending one turns
 * every failure of the session into a failure of the page: Hypha rejects a
 * request whose Authorization header has expired rather than falling back to
 * anonymous, so a visitor with a stale login saw "Could not load models, HTTP
 * 401, the token has expired" on a page that needs no login at all.
 *
 * A collection that is not world-readable does not belong here. Reading one
 * means deciding what to do when the user is logged out or their token has
 * expired, and that decision differs per page.
 */
const ModelGrid: React.FC<ModelGridProps> = ({
  parentIds,
  filters,
  emptyMessage,
  limit = 50,
}) => {
  const [items, setItems] = useState<ArtifactRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Depend on the content of the array and the object, not on their identity.
  // Callers pass literals, so a render would otherwise be enough to refetch
  // every collection. eslint cannot see through the serialisation, which is
  // what the disable below is for.
  const parentIdsKey = JSON.stringify(parentIds);
  const filtersKey = JSON.stringify(filters || {});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pages = await Promise.all(
        parentIds.map(parentId =>
          listArtifactChildren(parentId, { filters, limit })
        )
      );
      const all = pages.flatMap(page => page.items);
      // Public Model Hub: hide anything still in the per-user review queue,
      // and anything the uploader has discarded (chiron-models grants `rw+`
      // not `delete`, so a user-side discard flips the manifest status
      // instead of removing the artifact — workspace admin sweeps later).
      // Curated/legacy artifacts have no `status` field and are always
      // shown (so the original tabula-* pretrained models keep appearing).
      const visible = all.filter(a => {
        const s = a.manifest?.status;
        if (s === 'in_review' || s === 'request_deletion') return false;
        // Weights belonging to a model this build cannot train yet. The
        // model's own card already says it is coming, and that is the whole
        // roadmap the page owes a visitor, so a second card offering the
        // weights is at best redundant and at worst reads as an offer: the
        // scGPT mirror is a finished upstream checkpoint and looks ready to
        // use. A card in `chiron-architectures` carries a `chiron` block and
        // is the model itself, so it always stays. An artifact with no family
        // at all is untouched, which is every tabula-* checkpoint.
        if (a.manifest?.chiron) return true;
        const family = a.manifest?.model_family as ChironModelFamily | undefined;
        return !family || CHIRON_MODELS[family]?.status !== 'coming-soon';
      });
      // The four foundation models lead the grid, in registry order, and
      // everything trained from them follows alphabetically. They are what a
      // visitor came to see, they are the entry point to every checkpoint
      // below them, and one of them being absent from the top of the page is
      // how a reader would conclude the platform does not have it. The
      // `chiron` block is what marks a card as the model itself rather than
      // weights trained from it, so every checkpoint sorts below all four,
      // exactly as it did when it had its own section.
      const rank = (a: ArtifactRef) =>
        FAMILY_RANK.get(a.manifest?.chiron?.model_family) ?? FAMILY_RANK.size;
      const sorted = visible.sort((a, b) => {
        const byFamily = rank(a) - rank(b);
        if (byFamily !== 0) return byFamily;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentIdsKey, filtersKey, limit]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500">
        <ArrowPathIcon className="w-8 h-8 animate-spin mb-3" />
        <span>Loading models…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-700">
        <div className="font-medium">Could not load models</div>
        <div className="mt-1 break-words">{error}</div>
        <button
          onClick={load}
          className="mt-3 text-red-700 underline hover:text-red-900"
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500 text-center">
        {emptyMessage || (
          <>
            <div className="text-lg font-medium text-gray-700 mb-1">No models yet</div>
            <div className="text-sm">Nothing has been published yet.</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
      {items.map((a) => (
        <ModelCard key={a.id} artifact={a} />
      ))}
    </div>
  );
};

export default ModelGrid;
