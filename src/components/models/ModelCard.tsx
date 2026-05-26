import React from 'react';
import { Link } from 'react-router-dom';
import { ArtifactRef, resolveCoverUrl } from '../../utils/artifactApi';

interface ModelCardProps {
  artifact: ArtifactRef;
}

function aliasFromId(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1];
}

function formatDate(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

const ModelCard: React.FC<ModelCardProps> = ({ artifact }) => {
  const manifest = artifact.manifest || {};
  const name: string = manifest.name || artifact.alias || aliasFromId(artifact.id);
  const description: string = manifest.description || '';
  const tissue: string | undefined = manifest.tissue;
  const tissues: string[] | undefined = Array.isArray(manifest.tissues)
    ? manifest.tissues
    : undefined;
  const isGlobalTransformer: boolean = manifest.global_transformer === true;
  const cover = resolveCoverUrl(manifest.cover, artifact.id);
  const alias = artifact.alias || aliasFromId(artifact.id);

  return (
    <Link
      to={`/models/${alias}`}
      className="group flex flex-col bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden"
    >
      <div className="relative w-full overflow-hidden bg-gray-50" style={{ paddingTop: '56.25%' }}>
        {cover ? (
          <img
            src={cover}
            alt={name}
            className="absolute inset-0 w-full h-full object-contain p-3 group-hover:scale-[1.02] transition-transform"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-300">
            <span className="text-4xl">🧬</span>
          </div>
        )}
      </div>

      <div className="flex flex-col flex-grow p-4">
        <h3
          className="text-base font-semibold text-gray-900 truncate"
          title={name}
        >
          {name}
        </h3>

        {description && (
          <p className="mt-1 text-sm text-gray-600 line-clamp-2 flex-grow">
            {description}
          </p>
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

        <div className="mt-3 text-xs text-gray-500 text-right">
          {formatDate(manifest.created_at || artifact.created_at)}
        </div>
      </div>
    </Link>
  );
};

export default ModelCard;
