import React from 'react';
import ModelGrid from '../components/models/ModelGrid';

const Models: React.FC = () => {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-gray-900">Models</h1>
        <p className="mt-2 text-gray-600">
          Trained checkpoints published to the Chiron Platform collection.
        </p>
      </div>
      <ModelGrid parentId="chiron-platform/chiron-models" />
    </div>
  );
};

export default Models;
