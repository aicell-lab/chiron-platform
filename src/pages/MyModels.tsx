import React from 'react';
import { Link } from 'react-router-dom';
import { useHyphaStore } from '../store/hyphaStore';
import ModelGrid from '../components/models/ModelGrid';
import { RiLoginBoxLine } from 'react-icons/ri';

const MyModels: React.FC = () => {
  const { user, isLoggedIn } = useHyphaStore();

  if (!isLoggedIn || !user?.id) {
    return (
      <div className="container mx-auto px-4 py-16 flex flex-col items-center text-center">
        <RiLoginBoxLine className="w-12 h-12 text-gray-400 mb-3" />
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Log in to see your models</h1>
        <p className="text-gray-600 max-w-md">
          My Models lists the model artifacts you have published to{' '}
          <code className="text-sm bg-gray-100 px-1.5 py-0.5 rounded">
            chiron-platform/chiron-models
          </code>
          . Log in to view yours.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">My Models</h1>
          <p className="mt-2 text-gray-600">
            Model artifacts you have published to the Chiron Platform collection.
          </p>
        </div>
        <Link
          to="/models"
          className="text-sm text-blue-600 hover:underline"
        >
          View all models →
        </Link>
      </div>
      <ModelGrid
        parentId="chiron-platform/chiron-models"
        filters={{ created_by: user.id }}
        emptyMessage={
          <>
            <div className="text-lg font-medium text-gray-700 mb-1">
              You haven't published any models yet
            </div>
            <div className="text-sm">
              Train a model in the{' '}
              <Link to="/training" className="text-blue-600 hover:underline">
                Training
              </Link>{' '}
              page and click <span className="font-medium">Publish</span> to add it here.
            </div>
          </>
        }
      />
    </div>
  );
};

export default MyModels;
