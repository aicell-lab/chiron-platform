import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import HyphaStatusBanner from './components/HyphaStatusBanner';
import AppErrorBoundary from './components/AppErrorBoundary';

import Snackbar from './components/Snackbar';
import About from './components/About';
import Footer from './components/Footer';
import './index.css'
import './github-markdown.css'
import { HyphaProvider } from './HyphaContext';
import { ProjectsProvider } from './providers/ProjectsProvider';
import BioEngineHome from './components/BioEngine/BioEngineHome';
import BioEngineWorker from './components/BioEngine/BioEngineWorker';
import BioEngineWorkerList from './components/BioEngine/BioEngineWorkerList';
import AgentLab from './pages/AgentLab';
import Training from './components/training/Training';
import Runs from './pages/Runs';
import Models from './pages/Models';
import ModelDetail from './pages/ModelDetail';
import MyModels from './pages/MyModels';
import Landing from './pages/Landing';
import { logger } from './utils/logger';

// BioEngine builds the "Manage BioEngine worker at:" line it prints on
// startup as `<dashboard-url>/worker?service_id=<id>` (bioengine/worker/
// worker.py), and the setup guide sets --dashboard-url to
// "https://chiron.aicell.io/#/worker", so the link an operator copies out of
// their container logs arrives here. Forward it to the dashboard rather than
// adding a second canonical URL for the same page, keeping the query string
// the service id rides in.
const WorkerLogLinkRedirect: React.FC = () => {
  const location = useLocation();
  return (
    <Navigate to={{ pathname: '/worker/dashboard', search: location.search }} replace />
  );
};

// Create a wrapper component that uses Router hooks
const AppContent: React.FC = () => {
  const location = useLocation();
  const isAgentLabRoute = location.pathname === '/lab' || location.pathname === '/notebook';
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Add state for Snackbar
  const [snackbarOpen, setSnackbarOpen] = React.useState(false);
  const [snackbarMessage, setSnackbarMessage] = React.useState('');

  // Add search handlers
  const handleSearchChange = (value: string) => {
    // Implement search logic
  };

  const handleSearchConfirm = (value: string) => {
    // Implement search confirmation logic
  };

  // Scope the "reset scroll on navigation" to actual route changes
  // (pathname). Depending on `location` as a whole meant every replaceState
  // inside a page — e.g. Training.tsx syncing ?step=<workers|apps|train>
  // or ?orchestrator_id=… — fired this effect and stomped whatever
  // targeted scroll the page had just requested (the Train step's below-
  // navbar landing, for one). Query / hash tweaks are always in-page
  // interactions; only a new pathname is an actual "navigated somewhere".
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // A report is far easier to read when it starts with where the user was.
  // Only the pathname, never the query string, which carries ids a reporter
  // has not agreed to hand over.
  useEffect(() => {
    logger.info('router', 'Navigated', { pathname: location.pathname });
  }, [location.pathname]);

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen);
  };

  // Close sidebar on mobile when route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // For agent lab route, don't show the Navbar and use full-screen layout
  if (isAgentLabRoute) {
    return (
      <div className="flex flex-col h-screen">
        <HyphaStatusBanner />
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <Routes>
            <Route path="/lab" element={<AgentLab />} />
            <Route path="/notebook" element={<Navigate to="/lab" replace />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <HyphaStatusBanner />
      <Navbar />
      <Snackbar 
        isOpen={snackbarOpen}
        message={snackbarMessage}
        onClose={() => setSnackbarOpen(false)}
      />
      <main>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/about" element={<div className="container mx-auto px-4"><About /></div>} />
          <Route path="/worker" element={<div className="container mx-auto px-4"><BioEngineHome /></div>} />
          <Route path="/worker/instances" element={<div className="container mx-auto px-4"><BioEngineWorkerList /></div>} />
          <Route path="/worker/dashboard" element={<div className="container mx-auto px-4"><BioEngineWorker /></div>} />
          <Route path="/worker/worker" element={<WorkerLogLinkRedirect />} />
          <Route path="/bioengine" element={<Navigate to="/worker" replace />} />
          <Route path="/bioengine/worker" element={<Navigate to="/worker/dashboard" replace />} />
          <Route path="/training" element={<Training />} />
          <Route path="/models" element={<Models />} />
          <Route path="/models/:alias" element={<ModelDetail />} />
          <Route path="/my-models" element={<MyModels />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/lab" element={<AgentLab />} />
          <Route path="/notebook" element={<Navigate to="/lab" replace />} />
          {/* An address that matches nothing used to render the navbar and the
              footer around an empty page, which reads as the platform having
              broken rather than as the address being wrong. Send it home. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
};

// Main App component that provides Router context
const App: React.FC = () => {
  return (
    <AppErrorBoundary>
      <HyphaProvider>
        <ProjectsProvider>
          <HashRouter>
            <AppContent />
          </HashRouter>
        </ProjectsProvider>
      </HyphaProvider>
    </AppErrorBoundary>
  );
};

export default App;
