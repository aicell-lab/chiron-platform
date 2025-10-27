import React, { useEffect, useState, useCallback } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import { hyphaWebsocketClient } from 'hypha-rpc';
import { FaNetworkWired, FaPlay, FaStop, FaPlus, FaTrash, FaInfo, FaCheckCircle, FaTimesCircle, FaSpinner, FaClock } from 'react-icons/fa';
import { BiLoaderAlt } from 'react-icons/bi';

interface ManagerConnection {
  workspace: string;
  serviceId: string;
  service: any;
  isConnected: boolean;
  datasets?: Record<string, any>;
}

interface OrchestratorApp {
  managerId: string;
  appId: string;
  status: string;
  serviceIds: any[];
  artifactId: string;
}

interface TrainerApp {
  managerId: string;
  appId: string;
  status: string;
  serviceIds: any[];
  datasets: Record<string, any>;
  artifactId: string;
}

interface TrainingStatus {
  is_running: boolean;
  current_training_round: number;
  total_training_rounds: number;
  stage: string;
  trainers_progress: Record<string, {
    current_batch: number;
    total_batches: number;
  }>;
}

interface TrainingHistory {
  losses: [number, number][];  // Array of [epoch, value] pairs
  accuracies: [number, number][];  // Array of [epoch, value] pairs
}

interface ClusterStatus {
  total_cpu: number;
  available_cpu: number;
  total_gpu: number;
  available_gpu: number;
  total_memory: number;
  available_memory: number;
  total_object_store_memory: number;
  available_object_store_memory: number;
}

interface ManagerInfoModalData {
  workspace: string;
  clusterStatus: ClusterStatus | null;
  datasets: Record<string, any>;
}

interface OrchestratorInfoModalData {
  status: string;
  artifactId: string;
}

interface TrainerInfoModalData {
  appId: string;
  status: string;
  datasets: Record<string, any>;
  artifactId: string;
}

type InfoModalData = ManagerInfoModalData | OrchestratorInfoModalData | TrainerInfoModalData;

const Training: React.FC = () => {
  const { server, isLoggedIn, user } = useHyphaStore();

  // Manager connections state
  const [managers, setManagers] = useState<ManagerConnection[]>([]);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [connectingWorkspace, setConnectingWorkspace] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Error popup state
  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const [errorPopupMessage, setErrorPopupMessage] = useState('');
  const [errorPopupDetails, setErrorPopupDetails] = useState('');

  // Orchestrators and trainers state
  const [orchestrators, setOrchestrators] = useState<OrchestratorApp[]>([]);
  const [trainers, setTrainers] = useState<TrainerApp[]>([]);
  const [selectedOrchestrator, setSelectedOrchestrator] = useState<string | null>(null);
  const [selectedTrainers, setSelectedTrainers] = useState<Set<string>>(new Set());

  // Create app state
  const [showCreateOrchestrator, setShowCreateOrchestrator] = useState(false);
  const [showCreateTrainer, setShowCreateTrainer] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [isCreatingOrchestrator, setIsCreatingOrchestrator] = useState(false);
  const [isCreatingTrainer, setIsCreatingTrainer] = useState(false);
  const [newOrchestratorArtifactId, setNewOrchestratorArtifactId] = useState('chiron-platform/tabula-trainer');
  const [newTrainerDatasets, setNewTrainerDatasets] = useState<string[]>([]);
  const [newTrainerArtifactId, setNewTrainerArtifactId] = useState('chiron-platform/tabula-trainer');
  const [newTrainerInitialWeights, setNewTrainerInitialWeights] = useState('');

  // Per-worker timers for status updates
  const [workerTimers, setWorkerTimers] = useState<Record<string, NodeJS.Timeout>>({});

  // Training state
  const [isTraining, setIsTraining] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [trainingHistory, setTrainingHistory] = useState<TrainingHistory | null>(null);
  const [numRounds, setNumRounds] = useState(5);
  const [addedTrainers, setAddedTrainers] = useState<string[]>([]);
  const [isPreparingTraining, setIsPreparingTraining] = useState(false);

  // Info modal state
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [infoModalData, setInfoModalData] = useState<InfoModalData | null>(null);
  const [infoModalType, setInfoModalType] = useState<'manager' | 'orchestrator' | 'trainer'>('manager');

  // Set default workspace when server is available
  useEffect(() => {
    if (server?.config?.workspace && newWorkspace === '') {
      setNewWorkspace(server.config.workspace);
    }
  }, [server, newWorkspace]);

  // Add manager connection
  const addManager = async () => {
    if (!newWorkspace.trim()) return;

    // Check if worker already exists
    if (managers.find(m => m.workspace === newWorkspace)) {
      setErrorPopupMessage('Worker Already Added');
      setErrorPopupDetails(`A worker from workspace "${newWorkspace}" is already connected. Each worker can only be added once.`);
      setShowErrorPopup(true);
      return;
    }

    setConnectingWorkspace(newWorkspace);
    setConnectError(null);

    try {
      // Get manager service ID from the workspace
      const url = `https://hypha.aicell.io/${newWorkspace}/services/chiron-manager?_mode=last`;
      let response;
      let data;

      try {
        response = await fetch(url);
        data = await response.json();
      } catch (fetchError) {
        throw new Error(`Failed to fetch manager service information. The workspace may not exist or the service may not be available. Error: ${fetchError instanceof Error ? fetchError.message : 'Network error'}`);
      }

      if (!data.id) {
        throw new Error('Manager service not found in workspace. Please ensure the chiron-manager service is running in this workspace.');
      }

      const serviceId = data.id;

      // Connect to the manager service
      let managerService;
      try {
        managerService = await server.getService(serviceId);
      } catch (serviceError) {
        throw new Error(`Failed to connect to manager service (${serviceId}). The service may not be reachable. Error: ${serviceError instanceof Error ? serviceError.message : 'Connection error'}`);
      }

      // Get worker info to fetch datasets
      let workerInfo;
      try {
        workerInfo = await managerService.get_worker_info();
      } catch (workerInfoError) {
        throw new Error(`Failed to retrieve worker information. The manager service may be unhealthy or not responding. Error: ${workerInfoError instanceof Error ? workerInfoError.message : 'Communication error'}`);
      }

      setManagers(prev => [...prev, {
        workspace: newWorkspace,
        serviceId: serviceId,
        service: managerService,
        isConnected: true,
        datasets: workerInfo.datasets || {}
      }]);

      // Check for existing orchestrator
      if (workerInfo.orchestrator_status && Object.keys(workerInfo.orchestrator_status).length > 0) {
        const orchStatus = workerInfo.orchestrator_status;
        setOrchestrators(prev => [...prev, {
          managerId: newWorkspace,
          appId: 'chiron-orchestrator',
          status: orchStatus.status,
          serviceIds: orchStatus.service_ids || [],
          artifactId: orchStatus.artifact_id || 'chiron-platform/tabula-trainer'
        }]);
      }

      // Check for existing trainers
      if (workerInfo.trainers_status) {
        const newTrainers: TrainerApp[] = [];
        for (const [appId, trainerStatus] of Object.entries(workerInfo.trainers_status)) {
          newTrainers.push({
            managerId: newWorkspace,
            appId: appId,
            status: (trainerStatus as any).status,
            serviceIds: (trainerStatus as any).service_ids || [],
            datasets: (trainerStatus as any).datasets || {},
            artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer'
          });
        }
        setTrainers(prev => [...prev, ...newTrainers]);
      }

      // Start timer for periodic updates
      const workspace = newWorkspace;
      setNewWorkspace('');

      // Use setTimeout to ensure state is updated before starting the refresh cycle
      setTimeout(() => {
        scheduleWorkerRefresh(workspace);
      }, 0);
    } catch (error) {
      console.error('Failed to connect to manager:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to manager';
      setErrorPopupMessage('Failed to Add Worker');
      setErrorPopupDetails(errorMessage);
      setShowErrorPopup(true);
      setConnectError(errorMessage);
    } finally {
      setConnectingWorkspace(null);
    }
  };

  // Remove manager connection
  const removeManager = (workspace: string) => {
    setManagers(prev => prev.filter(m => m.workspace !== workspace));
    // Clear timer for this worker
    if (workerTimers[workspace]) {
      clearTimeout(workerTimers[workspace]);
      setWorkerTimers(prev => {
        const newTimers = { ...prev };
        delete newTimers[workspace];
        return newTimers;
      });
    }
    // Also remove any orchestrators/trainers from this manager
    setOrchestrators(prev => prev.filter(o => o.managerId !== workspace));
    setTrainers(prev => prev.filter(t => t.managerId !== workspace));
  };

  // Refresh a specific manager's worker info
  const refreshWorkerInfo = useCallback(async (workspace: string) => {
    const manager = managers.find(m => m.workspace === workspace);
    if (!manager) return;

    try {
      const workerInfo = await manager.service.get_worker_info();

      // Update datasets
      setManagers(prev => prev.map(m =>
        m.workspace === workspace
          ? { ...m, datasets: workerInfo.datasets || {} }
          : m
      ));

      // Update orchestrator
      setOrchestrators(prev => {
        const filtered = prev.filter(o => o.managerId !== workspace);
        if (workerInfo.orchestrator_status && Object.keys(workerInfo.orchestrator_status).length > 0) {
          const orchStatus = workerInfo.orchestrator_status;
          return [...filtered, {
            managerId: workspace,
            appId: 'chiron-orchestrator',
            status: orchStatus.status,
            serviceIds: orchStatus.service_ids || [],
            artifactId: orchStatus.artifact_id || 'chiron-platform/tabula-trainer'
          }];
        }
        return filtered;
      });

      // Update trainers
      setTrainers(prev => {
        const filtered = prev.filter(t => t.managerId !== workspace);
        const newTrainers: TrainerApp[] = [];
        if (workerInfo.trainers_status) {
          for (const [appId, trainerStatus] of Object.entries(workerInfo.trainers_status)) {
            newTrainers.push({
              managerId: workspace,
              appId: appId,
              status: (trainerStatus as any).status,
              serviceIds: (trainerStatus as any).service_ids || [],
              datasets: (trainerStatus as any).datasets || {},
              artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer'
            });
          }
        }
        return [...filtered, ...newTrainers];
      });
    } catch (error) {
      console.error(`Failed to refresh worker ${workspace}:`, error);
    }
  }, [managers]);

  // Schedule next refresh for a worker (5 seconds)
  const scheduleWorkerRefresh = useCallback((workspace: string) => {
    // Clear existing timer
    if (workerTimers[workspace]) {
      clearTimeout(workerTimers[workspace]);
    }

    // Set new timer
    const timer = setTimeout(() => {
      refreshWorkerInfo(workspace).then(() => {
        scheduleWorkerRefresh(workspace);
      });
    }, 5000);

    setWorkerTimers(prev => ({ ...prev, [workspace]: timer }));
  }, [workerTimers, refreshWorkerInfo]);

  // Refresh all managers (initial load and when managers change)
  const refreshAllManagers = useCallback(async () => {
    for (const manager of managers) {
      await refreshWorkerInfo(manager.workspace);
      scheduleWorkerRefresh(manager.workspace);
    }
  }, [managers, refreshWorkerInfo, scheduleWorkerRefresh]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      Object.values(workerTimers).forEach(timer => clearTimeout(timer));
    };
  }, [workerTimers]);

  // Create orchestrator
  const createOrchestrator = async (managerId: string) => {
    const manager = managers.find(m => m.workspace === managerId);
    if (!manager) return;

    setIsCreatingOrchestrator(true);

    try {
      // Generate token
      const applicationToken = await server.generateToken({
        workspace: server.config.workspace,
        permission: 'read_write',
        expires_in: 3600 * 24 * 30
      });

      await manager.service.create_orchestrator({
        token: applicationToken,
        trainer_artifact_id: newOrchestratorArtifactId,
        _rkwargs: true
      });

      // Fetch updated worker info
      await refreshWorkerInfo(managerId);

      // Reset the timer for this worker
      scheduleWorkerRefresh(managerId);

      // Close the modal
      setShowCreateOrchestrator(false);
      setCreatingFor(null);
      setIsCreatingOrchestrator(false);
    } catch (error) {
      console.error('Failed to create orchestrator:', error);
      setErrorPopupMessage('Failed to Create Orchestrator');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while creating the orchestrator');
      setShowErrorPopup(true);
      setIsCreatingOrchestrator(false);
    }
  };

  // Create trainer
  const createTrainer = async (managerId: string) => {
    const manager = managers.find(m => m.workspace === managerId);
    if (!manager || newTrainerDatasets.length === 0) return;

    setIsCreatingTrainer(true);

    try {
      // Generate token
      const applicationToken = await server.generateToken({
        workspace: server.config.workspace,
        permission: 'read_write',
        expires_in: 3600 * 24 * 30
      });

      await manager.service.create_trainer({
        token: applicationToken,
        datasets: newTrainerDatasets,
        trainer_artifact_id: newTrainerArtifactId,
        initial_weights: newTrainerInitialWeights || null,
        _rkwargs: true
      });

      // Fetch updated worker info
      await refreshWorkerInfo(managerId);

      // Reset the timer for this worker
      scheduleWorkerRefresh(managerId);

      // Close the modal and reset state
      setShowCreateTrainer(false);
      setCreatingFor(null);
      setNewTrainerDatasets([]);
      setNewTrainerInitialWeights('');
      setIsCreatingTrainer(false);
    } catch (error) {
      console.error('Failed to create trainer:', error);
      setErrorPopupMessage('Failed to Create Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while creating the trainer');
      setShowErrorPopup(true);
      setIsCreatingTrainer(false);
    }
  };

  // Remove orchestrator
  const removeOrchestrator = async (managerId: string) => {
    const manager = managers.find(m => m.workspace === managerId);
    if (!manager) return;

    // Immediately mark as deleting in UI
    setOrchestrators(prev => prev.map(o =>
      o.managerId === managerId ? { ...o, status: 'DELETING' } : o
    ));

    try {
      await manager.service.remove_orchestrator();

      // Immediately refresh worker info and reset timer
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    } catch (error) {
      console.error('Failed to remove orchestrator:', error);
      setErrorPopupMessage('Failed to Remove Orchestrator');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while removing the orchestrator');
      setShowErrorPopup(true);
      // Refresh to restore the correct state
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    }
  };

  // Remove trainer
  const removeTrainer = async (managerId: string, appId: string) => {
    const manager = managers.find(m => m.workspace === managerId);
    if (!manager) return;

    // Immediately mark as deleting in UI
    setTrainers(prev => prev.map(t =>
      t.managerId === managerId && t.appId === appId ? { ...t, status: 'DELETING' } : t
    ));

    try {
      await manager.service.remove_trainer(appId);

      // Immediately refresh worker info and reset timer
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    } catch (error) {
      console.error('Failed to remove trainer:', error);
      setErrorPopupMessage('Failed to Remove Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while removing the trainer');
      setShowErrorPopup(true);
      // Refresh to restore the correct state
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    }
  };

  // Show info modal
  const showInfo = async (type: 'manager' | 'orchestrator' | 'trainer', id: string) => {
    const manager = managers.find(m => m.workspace === id.split('::')[0]);
    if (!manager) return;

    try {
      // Fetch fresh worker info and reset timer
      await refreshWorkerInfo(manager.workspace);
      scheduleWorkerRefresh(manager.workspace);

      const workerInfo = await manager.service.get_worker_info();

      if (type === 'manager') {
        setInfoModalData({
          workspace: manager.workspace,
          clusterStatus: workerInfo.cluster_status || null,
          datasets: workerInfo.datasets || {}
        });
      } else if (type === 'orchestrator') {
        setInfoModalData({
          status: workerInfo.orchestrator_status?.status,
          artifactId: workerInfo.orchestrator_status?.artifact_id
        });
      } else if (type === 'trainer') {
        const appId = id.split('::')[1];
        const trainerStatus = workerInfo.trainers_status?.[appId];
        setInfoModalData({
          appId,
          status: trainerStatus?.status,
          datasets: trainerStatus?.datasets || {},
          artifactId: trainerStatus?.artifact_id
        });
      }

      setInfoModalType(type);
      setShowInfoModal(true);
    } catch (error) {
      console.error('Failed to get info:', error);
      setErrorPopupMessage('Failed to Get Information');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while retrieving information');
      setShowErrorPopup(true);
    }
  };

  // Sync trainers with orchestrator
  const syncTrainersWithOrchestrator = useCallback(async () => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);

      // Get currently added trainers
      const currentTrainers = await orchestratorService.list_trainers();

      // Get selected trainer service IDs
      const selectedTrainerServiceIds = new Set<string>();
      const selectedTrainersArray = Array.from(selectedTrainers);
      for (const trainerId of selectedTrainersArray) {
        const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
        if (trainer && trainer.status === 'RUNNING') {
          selectedTrainerServiceIds.add(trainer.serviceIds[0].websocket_service_id);
        }
      }

      // Remove trainers that are not selected
      for (const trainerServiceId of currentTrainers) {
        if (!selectedTrainerServiceIds.has(trainerServiceId)) {
          await orchestratorService.remove_trainer(trainerServiceId);
        }
      }

      // Add trainers that are selected but not yet added
      for (const trainerId of selectedTrainersArray) {
        const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
        if (trainer && trainer.status === 'RUNNING') {
          const trainerServiceId = trainer.serviceIds[0].websocket_service_id;
          if (!currentTrainers.includes(trainerServiceId)) {
            await orchestratorService.add_trainer(trainerServiceId);
          }
        }
      }

      // Get updated list of trainers
      const updatedTrainers = await orchestratorService.list_trainers();
      setAddedTrainers(updatedTrainers);
    } catch (error) {
      console.error('Failed to sync trainers:', error);
      setErrorPopupMessage('Failed to Sync Trainers');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while syncing trainers with the orchestrator');
      setShowErrorPopup(true);
    }
  }, [selectedOrchestrator, selectedTrainers, orchestrators, trainers, server]);

  // Automatically sync trainers when selection changes
  useEffect(() => {
    if (selectedOrchestrator && selectedTrainers.size > 0) {
      syncTrainersWithOrchestrator();
    }
  }, [selectedOrchestrator, selectedTrainers, syncTrainersWithOrchestrator]);

  // Fetch training history when orchestrator is selected
  useEffect(() => {
    const fetchTrainingHistory = async () => {
      if (!selectedOrchestrator) {
        setTrainingHistory(null);
        return;
      }

      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') return;

      try {
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const history = await orchestratorService.get_training_history();
        
        // Only set if we have valid data
        if (history && history.losses && history.losses.length > 0) {
          setTrainingHistory(history);
        }
      } catch (error) {
        // Silently handle - orchestrator might not have history yet
        console.debug('No training history available yet:', error);
      }
    };

    fetchTrainingHistory();
  }, [selectedOrchestrator, orchestrators, server]);

  // Start training
  const startTraining = async () => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    setIsPreparingTraining(true);

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);

      // Ensure correct trainers are added before starting
      const currentTrainers = await orchestratorService.list_trainers();
      console.log('Trainers ready for training:', currentTrainers);

      setIsPreparingTraining(false);
      setIsTraining(true);
      setTrainingHistory(null);

      // Start training in background
      orchestratorService.start_training({ num_rounds: numRounds, timeout: 600, _rkwargs: true }).catch((error: Error) => {
        console.error('Training failed:', error);
        setErrorPopupMessage('Training Failed');
        setErrorPopupDetails(error.message);
        setShowErrorPopup(true);
        setIsTraining(false);
      });

      // Poll for status (every 3 seconds)
      const statusInterval = setInterval(async () => {
        try {
          const status = await orchestratorService.get_training_status();
          setTrainingStatus(status);

          if (!status.is_running) {
            setIsTraining(false);
            clearInterval(statusInterval);

            // Get training history
            const history = await orchestratorService.get_training_history();
            setTrainingHistory(history);
          }
        } catch (error) {
          console.error('Failed to get training status:', error);
        }
      }, 3000);
    } catch (error) {
      console.error('Failed to start training:', error);
      setErrorPopupMessage('Failed to Start Training');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while starting the training');
      setShowErrorPopup(true);
      setIsPreparingTraining(false);
      setIsTraining(false);
    }
  };

  // Stop training
  const stopTraining = async () => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.stop_training();
      setIsTraining(false);
      setTrainingStatus(null);
    } catch (error) {
      console.error('Failed to stop training:', error);
      setErrorPopupMessage('Failed to Stop Training');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while stopping the training');
      setShowErrorPopup(true);
    }
  };

  // Check if user has access to a dataset
  const hasDatasetAccess = (dataset: any) => {
    if (!dataset.authorized_users) return true; // If no restriction, allow access
    if (dataset.authorized_users.includes('*')) return true; // Wildcard access

    const userId = server?.config?.user?.id;
    const userEmail = server?.config?.user?.email;

    return dataset.authorized_users.includes(userId) || dataset.authorized_users.includes(userEmail);
  };

  // Get trainer app ID from service ID
  const getTrainerAppId = (serviceId: string): string => {
    const trainer = trainers.find(t => 
      t.serviceIds && t.serviceIds[0] && t.serviceIds[0].websocket_service_id === serviceId
    );
    return trainer ? trainer.appId : serviceId;
  };

  // Get status badge
  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; icon: any }> = {
      'NOT_STARTED': { color: 'bg-gray-100 text-gray-800', icon: FaClock },
      'DEPLOYING': { color: 'bg-blue-100 text-blue-800', icon: BiLoaderAlt },
      'DEPLOY_FAILED': { color: 'bg-red-100 text-red-800', icon: FaTimesCircle },
      'RUNNING': { color: 'bg-green-100 text-green-800', icon: FaCheckCircle },
      'UNHEALTHY': { color: 'bg-yellow-100 text-yellow-800', icon: FaTimesCircle },
      'DELETING': { color: 'bg-orange-100 text-orange-800', icon: BiLoaderAlt }
    };

    const config = statusConfig[status] || statusConfig['NOT_STARTED'];
    const Icon = config.icon;

    return (
      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
        <Icon className={`mr-1 ${status === 'DEPLOYING' || status === 'DELETING' ? 'animate-spin' : ''}`} />
        {status}
      </span>
    );
  };

  if (!isLoggedIn) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Federated Training</h1>
          <p className="text-gray-600 mb-8">Please log in to access federated training.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-2">
          Federated Training
        </h1>
        <p className="text-gray-600">
          Set up and run federated training across multiple BioEngine workers
        </p>
      </div>

      {/* Step 1: Connect to Workers */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
          <FaNetworkWired className="mr-2 text-blue-600" />
          Step 1: Connect to BioEngine Workers
        </h2>

        <div className="mb-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={newWorkspace}
              onChange={(e) => setNewWorkspace(e.target.value)}
              placeholder="Workspace name"
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyPress={(e) => e.key === 'Enter' && addManager()}
            />
            <button
              onClick={addManager}
              disabled={!newWorkspace.trim() || !!connectingWorkspace}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center"
            >
              {connectingWorkspace ? (
                <>
                  <BiLoaderAlt className="mr-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <FaPlus className="mr-2" />
                  Add Worker
                </>
              )}
            </button>
          </div>
        </div>

        {/* Managers list */}
        <div className="space-y-2">
          {managers.map((manager) => (
            <div key={manager.workspace} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center">
                <FaCheckCircle className="text-green-500 mr-3" />
                <div>
                  <p className="font-medium text-gray-900">{manager.workspace}</p>
                  <p className="text-sm text-gray-500">Service ID: {manager.serviceId}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => showInfo('manager', manager.workspace)}
                  className="p-2 text-blue-600 hover:bg-blue-50 rounded"
                  title="Show info"
                >
                  <FaInfo />
                </button>
                <button
                  onClick={() => removeManager(manager.workspace)}
                  className="p-2 text-red-600 hover:bg-red-50 rounded"
                  title="Remove manager"
                >
                  <FaTrash />
                </button>
              </div>
            </div>
          ))}
          {managers.length === 0 && (
            <p className="text-gray-500 text-center py-4">No managers connected yet</p>
          )}
        </div>
      </div>

      {/* Step 2: Create Orchestrators and Trainers */}
      {managers.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Step 2: Start Orchestrators and Trainers
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {managers.map((manager) => (
              <div key={manager.workspace} className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-medium text-gray-900 mb-3">{manager.workspace}</h3>

                {/* Orchestrator section */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700">Orchestrator</span>
                    {!orchestrators.find(o => o.managerId === manager.workspace) && (
                      <button
                        onClick={() => {
                          setCreatingFor(manager.workspace);
                          setShowCreateOrchestrator(true);
                        }}
                        className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                      >
                        Create
                      </button>
                    )}
                  </div>

                  {orchestrators.filter(o => o.managerId === manager.workspace).map((orch) => (
                    <div key={orch.appId} className="bg-gray-50 p-3 rounded flex items-center justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-medium">{orch.appId}</p>
                        <p className="text-xs text-gray-500">{orch.artifactId}</p>
                        <div className="mt-1">{getStatusBadge(orch.status)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => showInfo('orchestrator', `${manager.workspace}::${orch.appId}`)}
                          className="p-2 text-blue-600 hover:bg-blue-100 rounded"
                        >
                          <FaInfo />
                        </button>
                        <button
                          onClick={() => removeOrchestrator(manager.workspace)}
                          className="p-2 text-red-600 hover:bg-red-50 rounded"
                          title="Remove orchestrator"
                        >
                          <FaTrash />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Trainers section */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700">Trainers</span>
                    <button
                      onClick={() => {
                        setCreatingFor(manager.workspace);
                        setShowCreateTrainer(true);
                      }}
                      className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                    >
                      Create
                    </button>
                  </div>

                  <div className="space-y-2">
                    {trainers.filter(t => t.managerId === manager.workspace).map((trainer) => (
                      <div key={trainer.appId} className="bg-gray-50 p-3 rounded">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex-1">
                            <p className="text-sm font-medium">{trainer.appId}</p>
                            <p className="text-xs text-gray-500">{Object.keys(trainer.datasets).join(', ')}</p>
                            <div className="mt-1">{getStatusBadge(trainer.status)}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => showInfo('trainer', `${manager.workspace}::${trainer.appId}`)}
                              className="p-2 text-blue-600 hover:bg-blue-100 rounded"
                            >
                              <FaInfo />
                            </button>
                            <button
                              onClick={() => removeTrainer(manager.workspace, trainer.appId)}
                              className="p-2 text-red-600 hover:bg-red-50 rounded"
                            >
                              <FaTrash />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {trainers.filter(t => t.managerId === manager.workspace).length === 0 && (
                      <p className="text-xs text-gray-500 text-center py-2">No trainers</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Selection section */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h3 className="font-medium text-gray-900 mb-3">Select Applications for Training</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Select orchestrator */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Orchestrator (select one)
                </label>
                <div className="space-y-2">
                  {orchestrators.filter(o => o.status === 'RUNNING').map((orch) => (
                    <label key={`${orch.managerId}::${orch.appId}`} className="flex items-center p-3 bg-gray-50 rounded cursor-pointer hover:bg-gray-100">
                      <input
                        type="radio"
                        name="orchestrator"
                        checked={selectedOrchestrator === `${orch.managerId}::${orch.appId}`}
                        onChange={() => setSelectedOrchestrator(`${orch.managerId}::${orch.appId}`)}
                        className="mr-3"
                      />
                      <div>
                        <p className="text-sm font-medium">{orch.appId}</p>
                        <p className="text-xs text-gray-500">{orch.managerId}</p>
                      </div>
                    </label>
                  ))}
                  {orchestrators.filter(o => o.status === 'RUNNING').length === 0 && (
                    <p className="text-sm text-gray-500">No running orchestrators available</p>
                  )}
                </div>
              </div>

              {/* Select trainers */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Trainers (select multiple)
                </label>
                <div className="space-y-2">
                  {trainers.filter(t => t.status === 'RUNNING').map((trainer) => (
                    <label key={`${trainer.managerId}::${trainer.appId}`} className="flex items-center p-3 bg-gray-50 rounded cursor-pointer hover:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={selectedTrainers.has(`${trainer.managerId}::${trainer.appId}`)}
                        onChange={(e) => {
                          const id = `${trainer.managerId}::${trainer.appId}`;
                          setSelectedTrainers(prev => {
                            const newSet = new Set(prev);
                            if (e.target.checked) {
                              newSet.add(id);
                            } else {
                              newSet.delete(id);
                            }
                            return newSet;
                          });
                        }}
                        className="mr-3"
                      />
                      <div>
                        <p className="text-sm font-medium">{trainer.appId}</p>
                        <p className="text-xs text-gray-500">{trainer.managerId} - {Object.keys(trainer.datasets).join(', ')}</p>
                      </div>
                    </label>
                  ))}
                  {trainers.filter(t => t.status === 'RUNNING').length === 0 && (
                    <p className="text-sm text-gray-500">No running trainers available</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Start Training */}
      {selectedOrchestrator && selectedTrainers.size > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Step 3: Start Federated Training
          </h2>

          {/* Training controls */}
          <div className="flex items-center gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Number of Rounds
              </label>
              <input
                type="number"
                value={numRounds}
                onChange={(e) => setNumRounds(parseInt(e.target.value) || 1)}
                min="1"
                className="px-4 py-2 border border-gray-300 rounded-lg w-32"
                disabled={isTraining}
              />
            </div>

            <div className="flex-1"></div>

            {!isTraining ? (
              <button
                onClick={startTraining}
                disabled={isPreparingTraining}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center font-medium"
              >
                {isPreparingTraining ? (
                  <>
                    <BiLoaderAlt className="mr-2 animate-spin" />
                    Preparing...
                  </>
                ) : (
                  <>
                    <FaPlay className="mr-2" />
                    Start Training
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={stopTraining}
                className="px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center font-medium"
              >
                <FaStop className="mr-2" />
                Stop Training
              </button>
            )}
          </div>

          {/* Training status - only show when actively training */}
          {isTraining && trainingStatus && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-blue-900">
                  Training Round {trainingStatus.current_training_round} / {trainingStatus.total_training_rounds}
                </h3>
                <span className="text-sm font-medium text-blue-700 uppercase">
                  {trainingStatus.stage}
                </span>
              </div>

              <div className="space-y-2">
                {Object.entries(trainingStatus.trainers_progress).map(([trainerId, progress]) => (
                  <div key={trainerId}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700">Trainer {getTrainerAppId(trainerId)}</span>
                      <span className="text-gray-600">
                        {progress.current_batch} / {progress.total_batches} batches
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300 relative"
                        style={{ width: `${(progress.current_batch / progress.total_batches) * 100}%` }}
                      >
                        {/* Animated shimmer effect */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Training history */}
          {trainingHistory && trainingHistory.losses && trainingHistory.losses.length > 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <h3 className="font-medium text-gray-900 mb-4">Training History</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Loss chart */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Loss</h4>
                  <div className="relative h-64 bg-white border border-gray-200 rounded p-4">
                    <svg className="w-full h-full" viewBox="0 0 450 200">
                      {(() => {
                        // Extract values from [[epoch, value], [epoch, value], ...]
                        const lossData = trainingHistory.losses.map(item => ({
                          epoch: item[0],
                          value: item[1]
                        }));
                        
                        const lossValues = lossData.map(d => d.value);
                        const maxLoss = Math.max(...lossValues);
                        const minLoss = Math.min(...lossValues);
                        const range = maxLoss - minLoss || 1;
                        const numYTicks = 5;
                        
                        return (
                          <>
                            {/* Grid lines and Y-axis labels */}
                            {Array.from({ length: numYTicks }).map((_, i) => {
                              const value = maxLoss - (i * range / (numYTicks - 1));
                              const y = 20 + (i * 140 / (numYTicks - 1));
                              return (
                                <g key={i}>
                                  <line x1="50" y1={y} x2="420" y2={y} stroke="#e5e7eb" strokeWidth="1" />
                                  <text x="45" y={y + 4} textAnchor="end" fontSize="10" fill="#6b7280">
                                    {value.toFixed(2)}
                                  </text>
                                </g>
                              );
                            })}
                            
                            {/* X-axis labels - show epoch numbers */}
                            {lossData.map((d, i) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              return (
                                <text key={i} x={x} y="180" textAnchor="middle" fontSize="10" fill="#6b7280">
                                  {d.epoch}
                                </text>
                              );
                            })}
                            
                            {/* X-axis label */}
                            <text x="235" y="195" textAnchor="middle" fontSize="11" fill="#374151" fontWeight="500">
                              Epoch
                            </text>
                            
                            {/* Plot line */}
                            <polyline
                              points={lossData.map((d, i) => {
                                const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                                const y = 20 + ((maxLoss - d.value) / range) * 140;
                                return `${x},${y}`;
                              }).join(' ')}
                              fill="none"
                              stroke="#ef4444"
                              strokeWidth="2"
                            />
                            
                            {/* Plot points */}
                            {lossData.map((d, i) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              const y = 20 + ((maxLoss - d.value) / range) * 140;
                              return (
                                <circle
                                  key={i}
                                  cx={x}
                                  cy={y}
                                  r="4"
                                  fill="#ef4444"
                                />
                              );
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                </div>

                {/* Accuracy chart */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Accuracy</h4>
                  <div className="relative h-64 bg-white border border-gray-200 rounded p-4">
                    <svg className="w-full h-full" viewBox="0 0 450 200">
                      {(() => {
                        // Extract values from [[epoch, value], [epoch, value], ...]
                        const accData = trainingHistory.accuracies.map(item => ({
                          epoch: item[0],
                          value: item[1]
                        }));
                        
                        const numYTicks = 5;
                        
                        return (
                          <>
                            {/* Grid lines and Y-axis labels */}
                            {Array.from({ length: numYTicks }).map((_, i) => {
                              const value = 1 - (i * 1 / (numYTicks - 1));
                              const y = 20 + (i * 140 / (numYTicks - 1));
                              return (
                                <g key={i}>
                                  <line x1="50" y1={y} x2="420" y2={y} stroke="#e5e7eb" strokeWidth="1" />
                                  <text x="45" y={y + 4} textAnchor="end" fontSize="10" fill="#6b7280">
                                    {value.toFixed(2)}
                                  </text>
                                </g>
                              );
                            })}
                            
                            {/* X-axis labels - show epoch numbers */}
                            {accData.map((d, i) => {
                              const x = 50 + (i / Math.max(accData.length - 1, 1)) * 370;
                              return (
                                <text key={i} x={x} y="180" textAnchor="middle" fontSize="10" fill="#6b7280">
                                  {d.epoch}
                                </text>
                              );
                            })}
                            
                            {/* X-axis label */}
                            <text x="235" y="195" textAnchor="middle" fontSize="11" fill="#374151" fontWeight="500">
                              Epoch
                            </text>
                            
                            {/* Plot line */}
                            <polyline
                              points={accData.map((d, i) => {
                                const x = 50 + (i / Math.max(accData.length - 1, 1)) * 370;
                                const y = 20 + ((1 - d.value) * 140);
                                return `${x},${y}`;
                              }).join(' ')}
                              fill="none"
                              stroke="#10b981"
                              strokeWidth="2"
                            />
                            
                            {/* Plot points */}
                            {accData.map((d, i) => {
                              const x = 50 + (i / Math.max(accData.length - 1, 1)) * 370;
                              const y = 20 + ((1 - d.value) * 140);
                              return (
                                <circle
                                  key={i}
                                  cx={x}
                                  cy={y}
                                  r="4"
                                  fill="#10b981"
                                />
                              );
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Orchestrator Modal */}
      {showCreateOrchestrator && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Create Orchestrator</h3>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Trainer Artifact ID
              </label>
              <input
                type="text"
                value={newOrchestratorArtifactId}
                onChange={(e) => setNewOrchestratorArtifactId(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowCreateOrchestrator(false);
                  setCreatingFor(null);
                }}
                disabled={isCreatingOrchestrator}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-200 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={() => creatingFor && createOrchestrator(creatingFor)}
                disabled={isCreatingOrchestrator}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {isCreatingOrchestrator ? (
                  <>
                    <BiLoaderAlt className="mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Trainer Modal */}
      {showCreateTrainer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Create Trainer</h3>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Datasets (select at least one)
              </label>
              <div className="max-h-48 overflow-y-auto border border-gray-300 rounded-lg p-2">
                {creatingFor && managers.find(m => m.workspace === creatingFor)?.datasets &&
                  Object.entries(managers.find(m => m.workspace === creatingFor)!.datasets!).map(([datasetId, manifest]: [string, any]) => {
                    const hasAccess = hasDatasetAccess(manifest);
                    return (
                      <label
                        key={datasetId}
                        className={`flex items-center p-2 rounded ${hasAccess ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                        title={!hasAccess ? 'You do not have access to this dataset' : ''}
                      >
                        <input
                          type="checkbox"
                          checked={newTrainerDatasets.includes(datasetId)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewTrainerDatasets([...newTrainerDatasets, datasetId]);
                            } else {
                              setNewTrainerDatasets(newTrainerDatasets.filter(d => d !== datasetId));
                            }
                          }}
                          disabled={!hasAccess}
                          className="mr-2"
                        />
                        <div className="flex-1">
                          <span className="text-sm">{manifest.name || datasetId}</span>
                          {!hasAccess && <span className="ml-2 text-xs text-red-600">(No access)</span>}
                        </div>
                      </label>
                    );
                  })
                }
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Trainer Artifact ID
              </label>
              <input
                type="text"
                value={newTrainerArtifactId}
                onChange={(e) => setNewTrainerArtifactId(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Initial Weights (optional)
              </label>
              <input
                type="text"
                value={newTrainerInitialWeights}
                onChange={(e) => setNewTrainerInitialWeights(e.target.value)}
                placeholder="Leave empty for default"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowCreateTrainer(false);
                  setCreatingFor(null);
                  setNewTrainerDatasets([]);
                  setNewTrainerInitialWeights('');
                }}
                disabled={isCreatingTrainer}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-200 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={() => creatingFor && createTrainer(creatingFor)}
                disabled={newTrainerDatasets.length === 0 || isCreatingTrainer}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {isCreatingTrainer ? (
                  <>
                    <BiLoaderAlt className="mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info Modal */}
      {showInfoModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-4">
              {infoModalType === 'manager' && 'Manager Information'}
              {infoModalType === 'orchestrator' && 'Orchestrator Information'}
              {infoModalType === 'trainer' && 'Trainer Information'}
            </h3>

            {infoModalType === 'manager' && infoModalData && 'workspace' in infoModalData && (
              <div>
                <h4 className="font-medium text-gray-900 mb-2">Workspace: {infoModalData.workspace}</h4>

                {/* Cluster Status */}
                {infoModalData.clusterStatus && (
                  <div className="mb-4">
                    <h5 className="font-medium text-gray-700 mb-2">Cluster Status:</h5>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="grid grid-cols-2 gap-4">
                        {/* CPU */}
                        <div>
                          <p className="text-xs font-medium text-gray-600 mb-1">CPU</p>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">
                              {infoModalData.clusterStatus.available_cpu?.toFixed(1)} / {infoModalData.clusterStatus.total_cpu?.toFixed(1)} cores
                            </span>
                          </div>
                          <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-blue-600 h-2 rounded-full"
                              style={{ width: `${((infoModalData.clusterStatus.available_cpu || 0) / (infoModalData.clusterStatus.total_cpu || 1)) * 100}%` }}
                            ></div>
                          </div>
                        </div>

                        {/* GPU */}
                        {infoModalData.clusterStatus.total_gpu > 0 && (
                          <div>
                            <p className="text-xs font-medium text-gray-600 mb-1">GPU</p>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-700">
                                {infoModalData.clusterStatus.available_gpu} / {infoModalData.clusterStatus.total_gpu} GPUs
                              </span>
                            </div>
                            <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-green-600 h-2 rounded-full"
                                style={{ width: `${((infoModalData.clusterStatus.available_gpu || 0) / (infoModalData.clusterStatus.total_gpu || 1)) * 100}%` }}
                              ></div>
                            </div>
                          </div>
                        )}

                        {/* Memory */}
                        <div>
                          <p className="text-xs font-medium text-gray-600 mb-1">Memory</p>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">
                              {(infoModalData.clusterStatus.available_memory / (1024 ** 3)).toFixed(1)} / {(infoModalData.clusterStatus.total_memory / (1024 ** 3)).toFixed(1)} GB
                            </span>
                          </div>
                          <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-purple-600 h-2 rounded-full"
                              style={{ width: `${((infoModalData.clusterStatus.available_memory || 0) / (infoModalData.clusterStatus.total_memory || 1)) * 100}%` }}
                            ></div>
                          </div>
                        </div>

                        {/* Object Store Memory */}
                        <div>
                          <p className="text-xs font-medium text-gray-600 mb-1">Object Store</p>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">
                              {(infoModalData.clusterStatus.available_object_store_memory / (1024 ** 3)).toFixed(1)} / {(infoModalData.clusterStatus.total_object_store_memory / (1024 ** 3)).toFixed(1)} GB
                            </span>
                          </div>
                          <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-orange-600 h-2 rounded-full"
                              style={{ width: `${((infoModalData.clusterStatus.available_object_store_memory || 0) / (infoModalData.clusterStatus.total_object_store_memory || 1)) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <h5 className="font-medium text-gray-700 mb-2">Available Datasets:</h5>
                <div className="space-y-3">
                  {Object.entries(infoModalData.datasets).map(([datasetId, manifest]: [string, any]) => {
                    const hasAccess = hasDatasetAccess(manifest);
                    return (
                      <div key={datasetId} className={`p-3 rounded-lg ${hasAccess ? 'bg-gray-50' : 'bg-red-50 border border-red-200'}`}>
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm">{manifest.name || datasetId}</p>
                          {!hasAccess && <span className="text-xs text-red-600 font-medium">No Access</span>}
                        </div>
                        <p className="text-xs text-gray-600 mt-1">{manifest.description}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {manifest.files && Object.entries(manifest.files).map(([fileName, fileInfo]: [string, any]) => (
                            <span key={fileName} className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                              {fileName} ({fileInfo.n_samples} samples{fileInfo.n_vars ? `, ${fileInfo.n_vars} vars` : ''})
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {infoModalType === 'orchestrator' && infoModalData && 'status' in infoModalData && 'artifactId' in infoModalData && !('appId' in infoModalData) && (
              <div>
                <div className="mb-3">
                  <span className="text-sm font-medium text-gray-700">Status: </span>
                  {getStatusBadge(infoModalData.status)}
                </div>
                <div>
                  <span className="text-sm font-medium text-gray-700">Artifact ID: </span>
                  <span className="text-sm text-gray-600">{infoModalData.artifactId}</span>
                </div>
              </div>
            )}

            {infoModalType === 'trainer' && infoModalData && 'appId' in infoModalData && (
              <div>
                <div className="mb-3">
                  <span className="text-sm font-medium text-gray-700">App ID: </span>
                  <span className="text-sm text-gray-600">{infoModalData.appId}</span>
                </div>
                <div className="mb-3">
                  <span className="text-sm font-medium text-gray-700">Status: </span>
                  {getStatusBadge(infoModalData.status)}
                </div>
                <div className="mb-3">
                  <span className="text-sm font-medium text-gray-700">Artifact ID: </span>
                  <span className="text-sm text-gray-600">{infoModalData.artifactId}</span>
                </div>
                <div>
                  <span className="text-sm font-medium text-gray-700">Datasets: </span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {Object.keys(infoModalData.datasets).map((datasetId: string) => (
                      <span key={datasetId} className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                        {datasetId}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={() => setShowInfoModal(false)}
              className="mt-6 w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Error Popup Modal */}
      {showErrorPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <FaTimesCircle className="text-red-600 text-3xl" />
              </div>
              <div className="ml-4 flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{errorPopupMessage}</h3>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto mb-4 px-1">
              <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{errorPopupDetails}</p>
            </div>
            <button
              onClick={() => {
                setShowErrorPopup(false);
                setErrorPopupMessage('');
                setErrorPopupDetails('');
              }}
              className="w-full px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Training;
