import React, { useEffect, useState, useCallback } from 'react';
import { useHyphaStore } from '../../store/hyphaStore';
import { ArtifactRef, listArtifactChildren } from '../../utils/artifactApi';
import ModelCard from './ModelCard';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

interface ModelGridProps {
  parentId: string;
  filters?: Record<string, any>;
  emptyMessage?: React.ReactNode;
  limit?: number;
}

const ModelGrid: React.FC<ModelGridProps> = ({
  parentId,
  filters,
  emptyMessage,
  limit = 50,
}) => {
  const { hyphaToken } = useHyphaStore();
  const [items, setItems] = useState<ArtifactRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await listArtifactChildren(parentId, {
        filters,
        limit,
        token: hyphaToken || undefined,
      });
      // Public Model Hub: hide anything still in the per-user review queue.
      // Curated/legacy artifacts have no `status` field and are always
      // shown (so the original tabula-* pretrained models keep appearing).
      const visible = items.filter(a => a.manifest?.status !== 'in_review');
      const sorted = visible.sort((a, b) => {
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
  }, [parentId, JSON.stringify(filters || {}), limit, hyphaToken]);

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
            <div className="text-sm">Nothing has been published to this collection.</div>
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
