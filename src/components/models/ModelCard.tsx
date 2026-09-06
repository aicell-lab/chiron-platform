import React from 'react';
import { Link } from 'react-router-dom';
import { ArtifactRef } from '../../utils/artifactApi';
import CoverImage from './CoverImage';
import { CHIRON_MODELS, ChironModelFamily } from '../../config/chironModels';

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
  const alias = artifact.alias || aliasFromId(artifact.id);
  // Whether this build of the platform can train the model yet. A model that
  // cannot be trained yet is still listed, so the roadmap is visible, but it
  // does not link anywhere: its detail page would describe something a user
  // cannot run.
  //
  // The frontend registry decides, not the artifact. A model's card in
  // `chiron-architectures` is one record shared by every deployment of the
  // site, while support for the model ships in a release of this app, so the
  // card can perfectly well hold a finished set of weights months before the
  // release that offers them. Reading the status off the card would make the
  // model announce itself as ready the moment the weights were uploaded.
  // `chiron.status` on the artifact stays the fallback for a family this
  // build does not know, which is what a fifth model's card looks like to an
  // older frontend.
  // Either spelling. The architecture cards carry the family under `chiron`,
  // while a mirrored set of published weights carries it at the top level, and
  // both are the same model as far as this question goes: the scGPT weights
  // mirror must not present itself as ready on a build where scGPT itself
  // reads "Coming soon", or the page contradicts itself about the same model.
  const family: string | undefined =
    manifest.chiron?.model_family || manifest.model_family;
  const registryEntry = family
    ? CHIRON_MODELS[family as ChironModelFamily]
    : undefined;
  const registryStatus = registryEntry?.status;
  const comingSoon: boolean =
    (registryStatus ?? manifest.chiron?.status) === 'coming-soon';
  // Which model a set of weights came from, on the weights themselves. The
  // grid used to answer this by placing the model's own card above its
  // checkpoints, but that card no longer takes a slot once the model's
  // foundation weights are published, and a checkpoint that only says
  // "Tabula" inside a sentence of prose is not something a reader can scan.
  // The badge carries the model's registry name and colour, so a page of
  // checkpoints from several models stays legible, and it hovers to the one
  // line describing what the architecture actually is. Not on a model's own
  // card, where the badge would repeat the heading directly above it.
  const familyBadge = manifest.chiron ? undefined : registryEntry;

  const body = (
    <>
      <div className="relative w-full overflow-hidden bg-gray-50" style={{ paddingTop: '56.25%' }}>
        <CoverImage
          cover={manifest.cover}
          artifactId={artifact.id}
          alt={name}
          className="absolute inset-0 w-full h-full object-contain p-3 group-hover:scale-[1.02] transition-transform"
          fallback={
            <div className="absolute inset-0 flex items-center justify-center text-gray-300">
              <span className="text-4xl">🧬</span>
            </div>
          }
        />
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
          {familyBadge && (
            <span
              className={`px-2 py-0.5 text-xs rounded-full border ${familyBadge.badgeClass}`}
              title={familyBadge.summary}
            >
              {familyBadge.displayName}
            </span>
          )}
          {comingSoon && (
            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full border border-gray-200">
              Coming soon
            </span>
          )}
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

        {/* No date on a card for a model that is not here yet. The only
            timestamp such an artifact has is when its entry was written, which
            says nothing about when the model arrives, and a date under a
            "Coming soon" pill reads as the date it is coming. */}
        {!comingSoon && (
          <div className="mt-3 text-xs text-gray-500 text-right">
            {formatDate(manifest.created_at || artifact.created_at)}
          </div>
        )}
      </div>
    </>
  );

  const shell =
    'group flex flex-col bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden';

  if (comingSoon) {
    return <div className={`${shell} opacity-75`}>{body}</div>;
  }

  return (
    <Link
      to={`/models/${alias}`}
      className={`${shell} hover:shadow-md hover:-translate-y-0.5 transition-all`}
    >
      {body}
    </Link>
  );
};

export default ModelCard;
