import React from 'react';
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import { formatDistanceToNow } from 'date-fns';

interface Author {
  name: string;
}

interface AdminResourceCardProps {
  title: string;
  description: string;
  tags: string[];
  image?: string;
  downloadUrl?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onManage?: () => void;
  isStaged?: boolean;
  status: 'staged' | 'published';
  authors?: Author[];
  createdAt?: number;
  lastModified?: number;
  artifactType?: string;
  hideEdit?: boolean;
}

const AdminResourceCard: React.FC<AdminResourceCardProps> = ({
  title,
  description,
  tags,
  image,
  downloadUrl,
  onEdit,
  onDelete,
  onManage,
  isStaged,
  status,
  authors = [],
  createdAt,
  lastModified,
  artifactType,
  hideEdit = false
}) => {
  const handleClick = (e: React.MouseEvent, callback?: () => void) => {
    e.stopPropagation();
    if (callback) callback();
  };

  return (
    <div className={`relative bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow duration-200 h-[260px] flex flex-col ${
      isStaged ? 'bg-yellow-50' : ''
    }`}>
      <div className="absolute top-2 right-2 z-10">
        {status === 'staged' ? (
          <span className="inline-flex items-center rounded-md bg-yellow-50 px-2 py-1 text-xs font-medium text-yellow-800 ring-1 ring-inset ring-yellow-600/20">
            Staged
          </span>
        ) : status === 'published' && (
          <span className="inline-flex items-center rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-800 ring-1 ring-inset ring-green-600/20">
            Published
          </span>
        )}
      </div>
      
      <div className="p-4">
        <div className="flex-none">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
          <p className="text-sm text-gray-600 mb-4 line-clamp-2">{description}</p>
        </div>
        
        <div className="flex-1">
          {authors.length > 0 && (
            <div className="mb-3 text-sm text-gray-600">
              By: {authors.map(author => author.name).join(', ')}
            </div>
          )}

          <div className="mb-3 text-xs text-gray-500">
            {createdAt && (
              <div>Created: {formatDistanceToNow(createdAt * 1000)} ago</div>
            )}
            {lastModified && (
              <div>Modified: {formatDistanceToNow(lastModified * 1000)} ago</div>
            )}
          </div>
          
          <div className="flex flex-wrap gap-2">
            {tags.slice(0, 5).map((tag, index) => (
              <span
                key={index}
                className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex justify-between items-center mt-4 border-t pt-4 flex-none">
          <div className="flex items-center space-x-2">
          {onManage && (
              <button
                onClick={(e) => handleClick(e, onManage)}
                className="flex items-center p-2 text-gray-600 hover:text-purple-600 rounded-lg hover:bg-purple-50"
                title="Manage Worker"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="ml-1">Manage</span>
              </button>
            )}
            {!hideEdit && onEdit && (
              <button
                onClick={(e) => handleClick(e, onEdit)}
                className="flex items-center p-2 text-gray-600 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                title="Edit"
              >
                <PencilIcon className="w-5 h-5" />
                <span className="ml-1">Edit</span>
              </button>
            )}
            {isStaged && onDelete && (
              <button
                onClick={(e) => handleClick(e, onDelete)}
                className="flex items-center p-2 text-gray-600 hover:text-red-600 rounded-lg hover:bg-red-50"
                title="Delete"
              >
                <TrashIcon className="w-5 h-5" />
                <span className="ml-1">Delete</span>
              </button>
            )}
            
            {artifactType && (
              <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-700">
                {artifactType}
              </span>
            )}
          </div>
          
          {downloadUrl && (
            <a
              href={downloadUrl}
              onClick={(e) => e.stopPropagation()}
              className="text-sm text-blue-600 hover:text-blue-800"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminResourceCard; 