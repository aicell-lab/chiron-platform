import React from 'react';
import ModelGrid from '../components/models/ModelGrid';
import { CHIRON_MODELS, CHIRON_MODEL_FAMILIES } from '../config/chironModels';

/** Names of the foundation models in one state or the other, in registry
 *  order, joined the way a sentence wants them. The intro sentence below has
 *  to keep pace with the platform as models are enabled one at a time, and
 *  the registry is already where that fact is recorded. */
const namesWithStatus = (status: 'available' | 'coming-soon'): string[] =>
  CHIRON_MODEL_FAMILIES.filter(f => CHIRON_MODELS[f].status === status).map(
    f => CHIRON_MODELS[f].displayName
  );

const asList = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const Models: React.FC = () => {
  const available = namesWithStatus('available');
  const upcoming = namesWithStatus('coming-soon');

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-gray-900">Models</h1>
        <p className="mt-2 text-gray-600">
          The single-cell foundation models Chiron federates, and the weights
          published to the platform collection. {asList(available)}{' '}
          {available.length === 1 ? 'is' : 'are'} available to train today.
          {upcoming.length > 0 && (
            <>
              {' '}
              {asList(upcoming)} {upcoming.length === 1 ? 'is' : 'are'} in
              preparation and will be enabled one at a time.
            </>
          )}
        </p>
      </div>

      {/* One grid over both collections rather than a labelled section each.
          The split between a foundation model and a checkpoint trained from it
          is a fact about how the platform stores weights, not a question a
          visitor arrives with, and heading each half made the page read as two
          catalogues. ModelGrid puts the foundation models first, so the
          ordering still carries what the headings used to say. */}
      <ModelGrid
        parentIds={[
          'chiron-platform/chiron-architectures',
          'chiron-platform/chiron-models',
        ]}
      />
    </div>
  );
};

export default Models;
