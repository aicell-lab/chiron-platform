import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';

import ResourceGrid from './components/ResourceGrid';
import ResourceDetails from './components/ResourceDetails';
import Snackbar from './components/Snackbar';
import About from './components/About';
import Footer from './components/Footer';
import Edit from './components/Edit';
import './index.css'
import './github-markdown.css'
import { HyphaProvider } from './HyphaContext';
import { ProjectsProvider } from './providers/ProjectsProvider';
import ModelTrainer from './components/ModelTrainer';
import ManageWorker from './components/ManageWorker';
import BioEngineHome from './components/BioEngine/BioEngineHome';
import BioEngineWorker from './components/BioEngine/BioEngineWorker';
import Orchestrator from './components/BioEngine/Orchestrator';
import AgentLab from './pages/AgentLab';
import Training from './components/training/Training';

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

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

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
      <Navbar />
      <Snackbar 
        isOpen={snackbarOpen}
        message={snackbarMessage}
        onClose={() => setSnackbarOpen(false)}
      />
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/training" replace />} />
          <Route path="/resources/:id" element={<div className="container mx-auto px-4"><ResourceDetails /></div>} />
          <Route path="/about" element={<div className="container mx-auto px-4"><About /></div>} />
          <Route path="/workers" element={<div className="container mx-auto px-4"><ResourceGrid type="worker" /></div>} />
          <Route path="/notebooks" element={<div className="container mx-auto px-4"><ResourceGrid type="notebook" /></div>} />
          <Route path="/edit/:artifactId" element={<div className="container mx-auto px-4"><Edit /></div>} />
          <Route path="/model-trainer/:id" element={<div className="container mx-auto px-4"><ModelTrainer /></div>} />
          <Route path="/manage-worker/:artifactId" element={<div className="container mx-auto px-4"><ManageWorker /></div>} />
          <Route path="/worker" element={<div className="container mx-auto px-4"><BioEngineHome /></div>} />
          <Route path="/worker/dashboard" element={<div className="container mx-auto px-4"><BioEngineWorker /></div>} />
          <Route path="/bioengine" element={<Navigate to="/worker" replace />} />
          <Route path="/bioengine/worker" element={<Navigate to="/worker/dashboard" replace />} />
          <Route path="/orchestrator" element={<div className="container mx-auto px-4"><Orchestrator /></div>} />
          <Route path="/training" element={<Training />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
};

// Main App component that provides Router context
const App: React.FC = () => {
  return (
    <HyphaProvider>
      <ProjectsProvider>
        <HashRouter>
          <AppContent />
        </HashRouter>
      </ProjectsProvider>
    </HyphaProvider>
  );
};

export default App;
