import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BioEngineGuide from './BioEngineGuide';

/**
 * `/worker` — the worker setup guide and nothing else.
 *
 * The list of reachable BioEngine instances used to live below the guide on
 * this same page. It now has its own route (`/worker/instances`), reached
 * through the button in the header, so a 10 second auto-refresh no longer
 * redraws itself under someone filling in the configurator.
 */
const BioEngineHome: React.FC = () => {
  const navigate = useNavigate();

  // The guide's closing step points back at the header button. Scrolling it
  // into view is not enough on a page this long, so it also rings for a moment
  // to say "this one".
  const workersButtonRef = useRef<HTMLButtonElement>(null);
  const [highlightWorkersButton, setHighlightWorkersButton] = useState(false);

  const scrollToWorkers = () => {
    workersButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightWorkersButton(true);
    setTimeout(() => setHighlightWorkersButton(false), 1600);
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-start mb-12">
        <div className="flex-1" />
        <div className="text-center">
          <div className="flex items-end justify-center gap-4 mb-4">
            <img src="/bioengine-icon.svg" alt="BioEngine Logo" className="w-12 h-12 mb-3" />
            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 via-purple-600 to-cyan-600 bg-clip-text text-transparent leading-tight">
              BioEngine
            </h1>
          </div>
          <div className="w-24 h-1 bg-gradient-to-r from-blue-500 to-purple-500 mx-auto mt-4 rounded-full"></div>
          <p className="mt-4 text-xl text-gray-600 font-medium">
            Unveiling cloud-powered AI for simplified Single-Cell Biology
          </p>
        </div>
        <div className="flex-1 flex justify-end">
          <button
            ref={workersButtonRef}
            onClick={() => navigate('/worker/instances')}
            className={`inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl shadow-md hover:shadow-lg hover:from-blue-700 hover:to-purple-700 active:scale-[0.98] transition-all duration-200 text-sm font-semibold ${highlightWorkersButton ? 'ring-4 ring-blue-300 ring-offset-2' : ''}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
            View BioEngine Workers
          </button>
        </div>
      </div>

      {/* BioEngine Guide */}
      <div className="max-w-6xl mx-auto mb-8">
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-6 hover:shadow-md transition-all duration-200">
          <BioEngineGuide onScrollToWorkers={scrollToWorkers} />
        </div>
      </div>
    </div>
  );
};

export default BioEngineHome;
