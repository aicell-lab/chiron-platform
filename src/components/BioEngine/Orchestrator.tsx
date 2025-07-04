import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useHyphaStore } from '../../store/hyphaStore';

// Types
interface Client {
  id: string;
  name: string;
  handle: any;
  properties: {
    client_name?: string;
    client_id?: string;
    train_samples?: number;
    validation_samples?: number;
    device?: string;
    lr?: number;
    validation_accuracy?: number;
  };
}

interface TrainingHistory {
  losses: Array<{ round: number; loss: number }>;
  metrics: Array<{ round: number; metrics: any }>;
}

const Orchestrator: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { server, isLoggedIn } = useHyphaStore();
  
  // URL parameters
  const searchParams = new URLSearchParams(location.search);
  const serviceId = searchParams.get('service_id');
  const appId = searchParams.get('app_id') || 'chiron_platform_tabula_orchestrator';
  
  // State management
  const [orchestrator, setOrchestrator] = useState<any>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [isTraining, setIsTraining] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Training state
  const [numRounds, setNumRounds] = useState(10);
  const [timeout, setTimeout] = useState(300);
  const [showTrainingDialog, setShowTrainingDialog] = useState(false);
  const [trainingHistory, setTrainingHistory] = useState<TrainingHistory>({ losses: [], metrics: [] });
  
  // Current metrics
  const [currentMetrics, setCurrentMetrics] = useState({
    trainingLoss: null as number | null,
    trainingAcc: null as number | null,
    validationLoss: null as number | null,
    validationAcc: null as number | null,
    currentRound: 0,
    message: null as string | null
  });
  
  // Client management
  const [newClientId, setNewClientId] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  
  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(true);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // System status
  const [systemBusy, setSystemBusy] = useState(false);

  // Clear system busy state on successful operations
  const clearSystemBusy = () => {
    if (systemBusy) {
      setSystemBusy(false);
    }
  };

  // Initialize orchestrator connection
  useEffect(() => {
    if (!isLoggedIn || !serviceId || !appId) {
      if (!isLoggedIn) {
        setError('Please log in to access the orchestrator');
      } else {
        setError('Missing service_id or app_id in URL parameters');
      }
      setLoading(false);
      return;
    }

    const initializeOrchestrator = async () => {
      try {
        setLoading(true);
        const svc = await server.getService(serviceId);
        const orch = svc[appId];
        setOrchestrator(orch);
        
        // Initial data load - sequential to prevent backpressure
        await loadClients(orch);
        await checkTrainingStatus(orch);
        await loadTrainingHistory(orch);
        
        setError(null);
      } catch (err) {
        console.error('Failed to initialize orchestrator:', err);
        setError(`Failed to connect to orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    };

    initializeOrchestrator();
  }, [isLoggedIn, serviceId, appId, server]);

  // Auto-refresh effect with staggered requests to prevent backpressure
  useEffect(() => {
    if (!orchestrator || !autoRefresh) return;

    const refresh = async () => {
      try {
        // Make requests sequential to prevent backpressure (was parallel before)
        await loadClients(orchestrator);
        await checkTrainingStatus(orchestrator);
        await loadTrainingHistory(orchestrator);
      } catch (err) {
        console.error('Auto-refresh failed:', err);
        // If we get backpressure, slow down the refresh rate temporarily
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes('backpressure') || errorMessage.includes('503')) {
          console.log('Backpressure detected, slowing down refresh rate');
        }
      }
    };

    // Increase refresh interval to 10 seconds to reduce load
    refreshIntervalRef.current = setInterval(refresh, 10000);

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [orchestrator, autoRefresh]);

  // Load clients with backpressure handling
  const loadClients = async (orch: any) => {
    try {
      const clientList = await orch.get_clients();
      setClients(clientList || []);
      clearSystemBusy(); // Clear busy state on success
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      if (errorMessage.includes('backpressure') || errorMessage.includes('503')) {
        console.log('Client list temporarily unavailable due to system load');
        setSystemBusy(true);
      } else {
        console.error('Failed to load clients:', err);
      }
    }
  };

  // Check training status with backpressure handling
  const checkTrainingStatus = async (orch: any) => {
    try {
      const training = await orch.is_training();
      setIsTraining(training);
      clearSystemBusy(); // Clear busy state on success
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      if (errorMessage.includes('backpressure') || errorMessage.includes('503')) {
        console.log('Training status temporarily unavailable due to system load');
      } else {
        console.error('Failed to check training status:', err);
      }
    }
  };

  // Load training history with backpressure handling
  const loadTrainingHistory = async (orch: any) => {
    try {
      const history = await orch.get_history();
      setTrainingHistory(history || { losses: [], metrics: [] });
      
      // Update current metrics from latest history
      if (history?.losses && history.losses.length > 0) {
        const latestLoss = history.losses[history.losses.length - 1];
        setCurrentMetrics(prev => ({
          ...prev,
          validationLoss: latestLoss.loss,
          currentRound: latestLoss.round
        }));
      }
      clearSystemBusy(); // Clear busy state on success
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      // Handle backpressure gracefully - don't spam console
      if (errorMessage.includes('backpressure') || errorMessage.includes('503')) {
        console.log('Training history temporarily unavailable due to system load');
      } else {
        console.error('Failed to load training history:', err);
      }
    }
  };

  // Add client
  const handleAddClient = async () => {
    if (!newClientId.trim() || !orchestrator) return;
    
    try {
      setAddingClient(true);
      setClientError(null);
      
      await orchestrator.add_client(newClientId.trim());
      await loadClients(orchestrator);
      
      setNewClientId('');
    } catch (err) {
      console.error('Failed to add client:', err);
      setClientError(`Failed to add client: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAddingClient(false);
    }
  };

  // Start training
  const handleStartTraining = async () => {
    if (!orchestrator) return;
    
    try {
      setShowTrainingDialog(false);
      await orchestrator.start_training(numRounds, timeout);
      await checkTrainingStatus(orchestrator);
      
      // Clear previous history
      setTrainingHistory({ losses: [], metrics: [] });
      setCurrentMetrics({
        trainingLoss: null,
        trainingAcc: null,
        validationLoss: null,
        validationAcc: null,
        currentRound: 0,
        message: null
      });
    } catch (err) {
      console.error('Failed to start training:', err);
      setError(`Failed to start training: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Stop training
  const handleStopTraining = async () => {
    if (!orchestrator) return;
    
    try {
      await orchestrator.stop_training();
      await checkTrainingStatus(orchestrator);
    } catch (err) {
      console.error('Failed to stop training:', err);
      setError(`Failed to stop training: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Sidebar component
  const Sidebar = () => (
    <div className={`
      flex flex-col bg-gray-800 text-white 
      ${sidebarOpen ? 'w-64' : 'w-16'}
      h-screen fixed top-0 left-0 transition-all duration-300 z-10
    `}>
      <div className="flex items-center justify-between px-4 py-4">
        {sidebarOpen && <span className="text-xl font-bold">Tabula Orchestrator</span>}
        <button
          className="focus:outline-none"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle Sidebar"
        >
          <svg className="h-6 w-6 transition-transform duration-300 hover:scale-125" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>
      
      <nav className="mt-2 flex-1 px-2">
        <ul className="space-y-2">
          <li>
            <a href="#clients" className="block py-2 px-2 rounded hover:bg-gray-700 transition-colors duration-200">
              {sidebarOpen ? '👥 Federated Clients' : '👥'}
            </a>
          </li>
          <li>
            <a href="#training" className="block py-2 px-2 rounded hover:bg-gray-700 transition-colors duration-200">
              {sidebarOpen ? '🚀 Training Control' : '🚀'}
            </a>
          </li>
          <li>
            <a href="#progress" className="block py-2 px-2 rounded hover:bg-gray-700 transition-colors duration-200">
              {sidebarOpen ? '📊 Training Progress' : '📊'}
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );

  // Client card component
  const ClientCard = ({ client }: { client: Client }) => {
    const { client_name, client_id, train_samples, validation_samples, device, lr, validation_accuracy } = client.properties || {};
    const displayName = client_name || client_id || client.id.split(':')[1] || 'Unknown Client';

    return (
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 hover:shadow-md transition-all duration-200 p-6">
        <h3 className="text-lg font-semibold mb-3 text-gray-800">{displayName}</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-600">Train Samples:</span>
            <span className="font-medium ml-2">{train_samples ?? 'N/A'}</span>
          </div>
          <div>
            <span className="text-gray-600">Val Samples:</span>
            <span className="font-medium ml-2">{validation_samples ?? 'N/A'}</span>
          </div>
          <div>
            <span className="text-gray-600">Device:</span>
            <span className="font-medium ml-2">{device ?? 'N/A'}</span>
          </div>
          <div>
            <span className="text-gray-600">Learning Rate:</span>
            <span className="font-medium ml-2">{lr ?? 'N/A'}</span>
          </div>
          {validation_accuracy !== undefined && (
            <div className="col-span-2">
              <span className="text-gray-600">Validation Accuracy:</span>
              <span className="font-medium ml-2">{(validation_accuracy * 100).toFixed(2)}%</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Training configuration dialog
  const TrainingDialog = () => (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-lg max-w-md w-full mx-4">
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800">Start Training</h3>
          <p className="text-sm text-gray-600 mt-1">Configure federated learning parameters</p>
        </div>
        
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Number of Rounds</label>
            <input
              type="number"
              min="1"
              max="1000"
              value={numRounds}
              onChange={(e) => setNumRounds(parseInt(e.target.value) || 1)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Number of training rounds"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Timeout (seconds)</label>
            <input
              type="number"
              min="60"
              max="3600"
              value={timeout}
              onChange={(e) => setTimeout(parseInt(e.target.value) || 300)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Training timeout in seconds"
            />
          </div>
          
          <div className="text-sm text-gray-600 bg-blue-50 p-3 rounded-lg">
            <p><strong>Clients:</strong> {clients.length}</p>
            <p><strong>Total Rounds:</strong> {numRounds}</p>
            <p><strong>Estimated Time:</strong> {Math.ceil(numRounds * timeout / 60)} minutes</p>
          </div>
        </div>
        
        <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
          <button
            onClick={() => setShowTrainingDialog(false)}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleStartTraining}
            disabled={clients.length === 0}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            Start Training
          </button>
        </div>
      </div>
    </div>
  );

  // Advanced Progress Chart component with dual metrics
  const ProgressChart = () => {
    const { losses, metrics } = trainingHistory;
    
    // Create chart data for losses
    const lossData = losses.map(l => ({ x: l.round, y: l.loss }));
    
    // Extract accuracy data from metrics if available
    const accuracyData = metrics.map(m => ({
      x: m.round,
      y: m.metrics?.accuracy || 0
    })).filter(d => d.y > 0);
    
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Loss Chart */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-6">
          <h3 className="text-lg font-semibold mb-4 text-gray-800">Training Loss</h3>
          
          {lossData.length > 0 ? (
            <div className="space-y-4">
              <div className="h-64 bg-gray-50 rounded-lg p-4 flex items-end space-x-1">
                {lossData.map((point, index) => {
                  const maxLoss = Math.max(...lossData.map(p => p.y), 1);
                  const height = Math.max((1 - point.y / maxLoss) * 100, 5);
                  return (
                    <div
                      key={index}
                      className="bg-blue-500 rounded-t min-w-[4px] flex-1 transition-all duration-300 hover:bg-blue-600"
                      style={{ height: `${height}%` }}
                      title={`Round ${point.x}: ${point.y.toFixed(4)}`}
                    />
                  );
                })}
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-600">Latest Loss:</span>
                  <span className="font-medium ml-2">
                    {lossData.length > 0 ? lossData[lossData.length - 1].y.toFixed(4) : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Trend:</span>
                  <span className="font-medium ml-2">
                    {lossData.length > 1 ? (
                      lossData[lossData.length - 1].y < lossData[lossData.length - 2].y ? (
                        <span className="text-green-600">↓ Improving</span>
                      ) : (
                        <span className="text-red-600">↑ Increasing</span>
                      )
                    ) : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-center py-8">
              <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              No training data available
            </div>
          )}
        </div>

        {/* Accuracy Chart */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-6">
          <h3 className="text-lg font-semibold mb-4 text-gray-800">Training Accuracy</h3>
          
          {accuracyData.length > 0 ? (
            <div className="space-y-4">
              <div className="h-64 bg-gray-50 rounded-lg p-4 flex items-end space-x-1">
                {accuracyData.map((point, index) => {
                  const height = point.y * 100; // Convert to percentage
                  return (
                    <div
                      key={index}
                      className="bg-green-500 rounded-t min-w-[4px] flex-1 transition-all duration-300 hover:bg-green-600"
                      style={{ height: `${Math.max(height, 5)}%` }}
                      title={`Round ${point.x}: ${(point.y * 100).toFixed(2)}%`}
                    />
                  );
                })}
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-600">Latest Accuracy:</span>
                  <span className="font-medium ml-2">
                    {accuracyData.length > 0 ? (accuracyData[accuracyData.length - 1].y * 100).toFixed(2) + '%' : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Best:</span>
                  <span className="font-medium ml-2">
                    {accuracyData.length > 0 ? (Math.max(...accuracyData.map(p => p.y)) * 100).toFixed(2) + '%' : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-center py-8">
              <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              No accuracy data available
            </div>
          )}
        </div>
      </div>
    );
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-2 border-gray-300 border-t-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading orchestrator...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xl font-semibold">Error</p>
            <p className="text-gray-600">{error}</p>
          </div>
          <button
            onClick={() => navigate('/bioengine')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Back to BioEngine
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <Sidebar />
      
      <div className={`
        flex-1 transition-all duration-300
        ${sidebarOpen ? 'ml-64' : 'ml-16'}
      `}>
        {/* Header */}
        <header className="bg-white/80 backdrop-blur-sm shadow-sm p-6 border-b border-white/20">
          <div className="flex justify-between items-center">
            <div>
              <div className="flex items-center mb-2">
                <button
                  onClick={() => navigate('/bioengine')}
                  className="flex items-center text-blue-600 hover:text-blue-800 transition-colors duration-200 mr-4"
                >
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  <span className="text-sm font-medium">Back</span>
                </button>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                  Tabula Orchestrator
                </h1>
              </div>
              <p className="text-gray-600">Federated learning orchestration dashboard</p>
            </div>
            
            <div className="flex items-center space-x-4">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Auto-refresh</span>
              </label>
              
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                isTraining 
                  ? 'bg-green-100 text-green-700' 
                  : 'bg-gray-100 text-gray-700'
              }`}>
                {isTraining ? '🟢 Training Active' : '⚫ Training Idle'}
              </div>
              
              {systemBusy && (
                <div className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-700 animate-pulse">
                  ⚠️ System Busy
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="p-6 space-y-8">
          {/* System Busy Notification */}
          {systemBusy && (
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded-lg">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="w-5 h-5 text-yellow-400 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </div>
                <div className="ml-3">
                  <p className="text-sm text-yellow-700">
                    <span className="font-medium">System Load Alert:</span> The orchestrator is experiencing high load. 
                    Some operations may be temporarily delayed. Data will refresh automatically when available.
                  </p>
                </div>
              </div>
            </div>
          )}
          {/* Federated Clients Section */}
          <section id="clients">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800">👥 Federated Clients</h2>
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={newClientId}
                    onChange={(e) => setNewClientId(e.target.value)}
                    placeholder="Enter client ID (e.g., workspace/service)"
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[300px]"
                  />
                  <button
                    onClick={handleAddClient}
                    disabled={!newClientId.trim() || addingClient}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {addingClient ? 'Adding...' : 'Add Client'}
                  </button>
                </div>
              </div>
            </div>
            
            {clientError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {clientError}
              </div>
            )}
            
            {clients.length === 0 ? (
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-12 text-center">
                <div className="text-gray-400 mb-4">
                  <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-600 mb-2">No Clients Connected</h3>
                <p className="text-gray-500">Add clients using the form above to start federated learning</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {clients.map((client, index) => (
                  <ClientCard key={client.id || index} client={client} />
                ))}
              </div>
            )}
          </section>

          {/* Training Control Section */}
          <section id="training">
            <h2 className="text-2xl font-bold text-gray-800 mb-6">🚀 Training Control</h2>
            
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-6">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-800">Training Management</h3>
                  <p className="text-sm text-gray-600">Control federated learning training sessions</p>
                </div>
                
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => setShowTrainingDialog(true)}
                    disabled={clients.length === 0 || isTraining}
                    className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                  >
                    Start Training
                  </button>
                  
                  <button
                    onClick={handleStopTraining}
                    disabled={!isTraining}
                    className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                  >
                    Stop Training
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-gray-50 p-3 rounded-lg">
                  <span className="text-gray-600">Connected Clients:</span>
                  <span className="font-medium ml-2">{clients.length}</span>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg">
                  <span className="text-gray-600">Training Status:</span>
                  <span className="font-medium ml-2">{isTraining ? 'Active' : 'Idle'}</span>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg">
                  <span className="text-gray-600">Current Round:</span>
                  <span className="font-medium ml-2">{currentMetrics.currentRound}</span>
                </div>
              </div>
            </div>
          </section>

          {/* Training Progress Section */}
          <section id="progress">
            <h2 className="text-2xl font-bold text-gray-800 mb-6">📊 Training Progress</h2>
            
            {/* Live Training Status */}
            {isTraining && (
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm border border-white/20 p-6 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-800">Live Training Status</h3>
                  <div className="flex items-center space-x-2">
                    <div className="animate-pulse w-3 h-3 bg-green-500 rounded-full"></div>
                    <span className="text-sm font-medium text-green-600">Training Active</span>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                  <div className="bg-blue-50 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-blue-600">{currentMetrics.currentRound}</div>
                    <div className="text-sm text-blue-600">Current Round</div>
                  </div>
                  <div className="bg-green-50 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-green-600">{clients.length}</div>
                    <div className="text-sm text-green-600">Active Clients</div>
                  </div>
                  <div className="bg-purple-50 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-purple-600">
                      {currentMetrics.validationLoss?.toFixed(4) ?? '--'}
                    </div>
                    <div className="text-sm text-purple-600">Latest Loss</div>
                  </div>
                  <div className="bg-orange-50 p-4 rounded-lg text-center">
                    <div className="text-2xl font-bold text-orange-600">
                      {currentMetrics.validationAcc ? (currentMetrics.validationAcc * 100).toFixed(1) + '%' : '--'}
                    </div>
                    <div className="text-sm text-orange-600">Latest Accuracy</div>
                  </div>
                </div>
                
                {currentMetrics.message && (
                  <div className="bg-gray-50 border-l-4 border-blue-500 p-4 rounded">
                    <p className="text-sm text-gray-700">
                      <span className="font-medium">Status:</span> {currentMetrics.message}
                    </p>
                  </div>
                )}
              </div>
            )}
            
            <ProgressChart />
          </section>
        </main>
      </div>
      
      {/* Training Configuration Dialog */}
      {showTrainingDialog && <TrainingDialog />}
    </div>
  );
};

export default Orchestrator; 