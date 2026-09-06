import React from 'react';
import ModelGrid from '../components/models/ModelGrid';
import {
  AVAILABLE_MODEL_NAMES,
  AVAILABLE_MODEL_COUNT,
  UPCOMING_MODEL_NAMES,
  UPCOMING_MODEL_COUNT,
} from '../config/chironModels';

const Models: React.FC = () => {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-gray-900">Models</h1>
        <p className="mt-2 text-gray-600">
          The single-cell foundation model architectures Chiron supports, and the
          trained checkpoints published to the platform collection.
        </p>
      </div>

      {/* Architectures come first: they are what the platform is about, and
          they are the only place a visitor learns which of the four are still
          on the way. The names come from the model registry so this sentence
          cannot drift from the badges on the cards below it. */}
      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900">Architectures</h2>
        <p className="mt-1 mb-4 text-sm text-gray-600">
          {AVAILABLE_MODEL_NAMES}{' '}
          {AVAILABLE_MODEL_COUNT === 1 ? 'is' : 'are'} available to train today.
          {UPCOMING_MODEL_COUNT > 0 && (
            <>
              {' '}
              {UPCOMING_MODEL_NAMES}{' '}
              {UPCOMING_MODEL_COUNT === 1 ? 'is' : 'are'} in preparation and will
              be enabled one at a time.
            </>
          )}
        </p>
        <ModelGrid
          parentId="chiron-platform/chiron-architectures"
          emptyMessage={
            <>
              <div className="text-lg font-medium text-gray-700 mb-1">
                No architectures listed
              </div>
              <div className="text-sm">
                The architecture collection could not be read.
              </div>
            </>
          }
        />
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900">Trained checkpoints</h2>
        <p className="mt-1 mb-4 text-sm text-gray-600">
          Weights published to the Chiron Platform collection, from pretraining
          and from federated training runs.
        </p>
        <ModelGrid parentId="chiron-platform/chiron-models" />
      </section>
    </div>
  );
};

export default Models;
