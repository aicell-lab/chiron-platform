import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';

import ResourceGrid from './components/ResourceGrid';
import ResourceDetails from './components/ResourceDetails';
import Snackbar from './components/Snackbar';
import About from './components/About';
import Footer from './components/Footer';
import Upload from './components/Upload';
import MyArtifacts from './components/MyArtifacts';
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
import Training from './pages/Training';

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
      <main className="container mx-auto px-4">
        <Routes>
          <Route path="/" element={<ResourceGrid />} />
          <Route path="/resources/:id" element={<ResourceDetails />} />
          <Route path="/about" element={<About />} />
          <Route path="/models" element={<ResourceGrid type="model" />} />
          <Route path="/workers" element={<ResourceGrid type="worker" />} />
          <Route path="/notebooks" element={<ResourceGrid type="notebook" />} />
          <Route path="/datasets" element={<ResourceGrid type="dataset" />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/my-artifacts" element={<MyArtifacts />} />
          <Route path="/edit/:artifactId" element={<Edit />} />
          <Route path="/model-trainer/:id" element={<ModelTrainer />} />
          <Route path="/manage-worker/:artifactId" element={<ManageWorker />} />
          <Route path="/bioengine" element={<BioEngineHome />} />
          <Route path="/bioengine/worker" element={<BioEngineWorker />} />
          <Route path="/orchestrator" element={<Orchestrator />} />
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
