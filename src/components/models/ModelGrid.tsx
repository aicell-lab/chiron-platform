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

/** The model an artifact belongs to, in either spelling. A card in
 *  `chiron-architectures` carries the family under `chiron`, published
 *  weights carry it at the top level. */
const familyOf = (a: ArtifactRef): ChironModelFamily | undefined =>
  (a.manifest?.chiron?.model_family || a.manifest?.model_family) as
    | ChironModelFamily
    | undefined;

const aliasOf = (a: ArtifactRef): string =>
  (a.alias || a.id.split('/').pop() || '').toLowerCase();

/** Whether this artifact is its model's published foundation checkpoint, the
 *  weights every other checkpoint of the family was trained from. The registry
 *  names it per model, so a family that has not published one yet has no
 *  candidate and this is false for all of its artifacts. */
const isFoundation = (a: ArtifactRef): boolean => {
  const family = familyOf(a);
  const expected = family && CHIRON_MODELS[family]?.foundationAlias;
  return !!expected && aliasOf(a) === expected;
};

/** Whether this artifact is the model's own card rather than weights. */
const isArchitecture = (a: ArtifactRef): boolean => !!a.manifest?.chiron;

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
      // One card per model at the head of the grid, not two. A model's own
      // card and its published foundation weights describe the same thing to
      // a visitor: the base model, the one to start from. Showing both puts
      // Tabula on the page twice, and the second card is the weaker of the
      // two, because the card is editorial while the checkpoint is the thing
      // you can actually train from and download.
      //
      // So a model is represented by its foundation checkpoint once that
      // checkpoint is on the page, and by its own card until then. Nothing is
      // deleted anywhere: the card stays in `chiron-architectures`, where the
      // trainer reads it on every run to find the base weights, and its detail
      // page stays reachable. It just stops competing for a slot in the grid.
      //
      // A model this build cannot train yet has its weights filtered out
      // above, so its card is the only candidate left and keeps carrying the
      // roadmap, which is the whole reason to list it.
      const led = new Set(
        visible.filter(isFoundation).map(a => familyOf(a) as string)
      );
      const shown = visible.filter(
        a => !(isArchitecture(a) && led.has(familyOf(a) as string))
      );
      // Those representatives lead the grid, in registry order, and everything
      // trained from them follows alphabetically. They are what a visitor came
      // to see, they are the entry point to every checkpoint below them, and
      // one of them being absent from the top of the page is how a reader
      // would conclude the platform does not have it. A model's other
      // checkpoints sort below all four however they are named, exactly as
      // they did when they had their own section.
      const rank = (a: ArtifactRef) => {
        const family = familyOf(a);
        if (!family || !(isArchitecture(a) || isFoundation(a))) {
          return FAMILY_RANK.size;
        }
        return FAMILY_RANK.get(family) ?? FAMILY_RANK.size;
      };
      const sorted = shown.sort((a, b) => {
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
