import React, { useEffect, useState, useCallback } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import { hyphaWebsocketClient } from 'hypha-rpc';
import { FaNetworkWired, FaPlay, FaStop, FaPlus, FaTrash, FaInfo, FaCheckCircle, FaTimesCircle, FaSpinner, FaClock, FaUnlink } from 'react-icons/fa';
import { BiLoaderAlt } from 'react-icons/bi';

interface WorkerInfo {
  cluster_status?: ClusterStatus;
  datasets?: Record<string, any>;
  orchestrator_status?: {
    status: string;
    service_ids: any[];
    artifact_id: string;
  };
  trainers_status?: Record<string, {
    status: string;
    service_ids: any[];
    datasets: Record<string, any>;
    artifact_id: string;
  }>;
}

interface ManagerConnection {
  workspace: string;
  serviceId: string;
  service: any;
  isConnected: boolean;
  workerInfo?: WorkerInfo;
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
  target_round: number;
  stage: string | null;
  trainers_progress: Record<string, {
    current_batch: number;
    total_batches: number;
    progress: number;
    error?: string;
  }>;
}

interface TrainingHistory {
  training_losses: [number, number][];  // Array of [round, loss] pairs
  validation_losses: [number, number][];  // Array of [round, loss] pairs
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
  status?: string;
  artifactId?: string;
}

interface TrainerInfoModalData {
  appId: string;
  status?: string;
  datasets: Record<string, any>;
  artifactId?: string;
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
  const [limitTrainBatches, setLimitTrainBatches] = useState<number | null>(null);
  const [limitEvalBatches, setLimitEvalBatches] = useState<number | null>(null);
  const [addedTrainers, setAddedTrainers] = useState<string[]>([]);
  const [isPreparingTraining, setIsPreparingTraining] = useState(false);
  
  // Error modal state
  const [showErrorDetailModal, setShowErrorDetailModal] = useState(false);
  const [errorDetailTrainerId, setErrorDetailTrainerId] = useState<string>('');
  const [errorDetailMessage, setErrorDetailMessage] = useState<string>('');

  // Confirmation modal state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalTitle, setConfirmModalTitle] = useState<string>('');
  const [confirmModalMessage, setConfirmModalMessage] = useState<string>('');
  const [confirmModalAction, setConfirmModalAction] = useState<(() => void) | null>(null);

  // Info modal state
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [infoModalData, setInfoModalData] = useState<InfoModalData | null>(null);
  const [infoModalType, setInfoModalType] = useState<'manager' | 'orchestrator' | 'trainer'>('manager');
  const [isInfoModalLoading, setIsInfoModalLoading] = useState(false);

  // Service selection modal state
  const [showServiceSelectionModal, setShowServiceSelectionModal] = useState(false);
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [pendingWorkspace, setPendingWorkspace] = useState<string>('');

  // Set default workspace when server is available
  useEffect(() => {
    if (server?.config?.workspace && newWorkspace === '') {
      setNewWorkspace(server.config.workspace);
    }
  }, [server, newWorkspace]);

  // Add manager connection
  const addManager = async () => {
    if (!newWorkspace.trim()) return;

    // No pre-check needed here - we'll check for duplicate serviceIds after fetching them
    // A workspace can have multiple workers, each with their own unique serviceId

    setConnectingWorkspace(newWorkspace);
    setConnectError(null);

    try {
      // Get manager service ID from the workspace (without _mode=last)
      const url = `https://hypha.aicell.io/${newWorkspace}/services/chiron-manager`;
      let response;
      let data;

      try {
        response = await fetch(url);
        data = await response.json();
      } catch (fetchError) {
        throw new Error(`Failed to fetch manager service information. The workspace may not exist or the service may not be available. Error: ${fetchError instanceof Error ? fetchError.message : 'Network error'}`);
      }

      // Check if we have a single service (success case)
      if (data.id) {
        // Single service found
        await connectToManagerService(newWorkspace, [data.id]);
        return;
      }

      // Check for error response
      if (!data.success && data.detail) {
        const detail = data.detail;
        
        // Check if it's a "multiple services" error
        if (detail.includes('Multiple services found')) {
          // Extract service IDs from the error message
          // Pattern: b'services:public|bioengine-apps:ws-user-github|49943582/ID:chiron-manager@*'
          // We need to extract: ws-user-github|49943582/ID:chiron-manager
          const servicePattern = /b'services:[^:]+:([^@]+):chiron-manager@\*'/g;
          const matches = [...detail.matchAll(servicePattern)];
          const serviceIds = matches.map(match => `${match[1]}:chiron-manager`);
          
          if (serviceIds.length > 0) {
            // Remove duplicates by converting to Set and back to array
            const uniqueServiceIds = Array.from(new Set(serviceIds));
            
            // Show service selection modal
            setAvailableServices(uniqueServiceIds);
            setSelectedServices(new Set(uniqueServiceIds)); // Default to all selected
            setPendingWorkspace(newWorkspace);
            setShowServiceSelectionModal(true);
            setConnectingWorkspace(null);
            return;
          }
        }
        
        // Check if it's a "service not found" error
        if (detail.includes('Service not found')) {
          throw new Error('Manager service not found in workspace. Please ensure the chiron-manager service is running in this workspace.');
        }
        
        // Unknown error format
        throw new Error(`Failed to fetch manager service: ${detail}`);
      }

      // Unexpected response format
      throw new Error('Unexpected response format from service endpoint.');
    } catch (error) {
      console.error('Failed to connect to manager:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to manager';
      setErrorPopupMessage('Failed to Add Worker');
      setErrorPopupDetails(errorMessage);
      setShowErrorPopup(true);
      setConnectError(errorMessage);
      setConnectingWorkspace(null);
    }
  };

  // Connect to one or more manager services
  const connectToManagerService = async (workspace: string, serviceIds: string[]) => {
    try {
      // Check for duplicate serviceIds before connecting
      for (const serviceId of serviceIds) {
        if (managers.find(m => m.serviceId === serviceId)) {
          throw new Error(`This worker (${serviceId}) is already connected. Each worker can only be added once.`);
        }
      }

      // Accumulate all changes before setting state
      const newManagers: ManagerConnection[] = [];
      const newOrchestrators: OrchestratorApp[] = [];
      const newTrainers: TrainerApp[] = [];

      for (const serviceId of serviceIds) {
        // Connect to the manager service
        let managerService;
        try {
          managerService = await server.getService(serviceId);
        } catch (serviceError) {
          throw new Error(`Failed to connect to manager service (${serviceId}). The service may not be reachable. Error: ${serviceError instanceof Error ? serviceError.message : 'Connection error'}`);
        }

        // Get worker info to fetch datasets - retry if not fully initialized
        let workerInfo;
        let retryCount = 0;
        const maxRetries = 12; // 12 retries * 2.5 seconds = 30 seconds max wait
        const retryDelay = 2500; // 2.5 seconds between retries

        while (retryCount < maxRetries) {
          try {
            workerInfo = await managerService.get_worker_info();
            break; // Success, exit retry loop
          } catch (workerInfoError) {
            const errorMessage = workerInfoError instanceof Error ? workerInfoError.message : '';
            
            // Check if this is the known initialization error
            if (errorMessage.includes("'NoneType' object has no attribute 'get_status'")) {
              retryCount++;
              if (retryCount < maxRetries) {
                console.log(`Manager ${serviceId} not fully initialized yet. Retrying in ${retryDelay / 1000}s... (${retryCount}/${maxRetries})`);
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
              } else {
                throw new Error(`Failed to retrieve worker information after ${maxRetries} retries. The manager service may still be initializing. Error: ${errorMessage}`);
              }
            } else {
              // Different error, don't retry
              throw new Error(`Failed to retrieve worker information. The manager service may be unhealthy or not responding. Error: ${errorMessage}`);
            }
          }
        }

        // Add manager - serviceId is the unique identifier (already contains workspace)
        newManagers.push({
          workspace: workspace,
          serviceId: serviceId,
          service: managerService,
          isConnected: true,
          workerInfo
        });

        // Use serviceId as managerId - it's already unique (format: workspace/client-id:chiron-manager)
        const managerId = serviceId;

        // Check for existing orchestrator - only add if it has a valid status
        if (workerInfo!.orchestrator_status && workerInfo!.orchestrator_status.status) {
          const orchStatus = workerInfo!.orchestrator_status;
          newOrchestrators.push({
            managerId: managerId,
            appId: 'chiron-orchestrator',
            status: orchStatus.status,
            serviceIds: orchStatus.service_ids || [],
            artifactId: orchStatus.artifact_id || 'chiron-platform/tabula-trainer'
          });
        }

        // Check for existing trainers
        if (workerInfo!.trainers_status) {
          for (const [appId, trainerStatus] of Object.entries(workerInfo!.trainers_status)) {
            newTrainers.push({
              managerId: managerId,
              appId: appId,
              status: (trainerStatus as any).status,
              serviceIds: (trainerStatus as any).service_ids || [],
              datasets: (trainerStatus as any).datasets || {},
              artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer'
            });
          }
        }

        // Start timer for periodic updates - immediately after connection
        scheduleWorkerRefresh(serviceId);
      }

      // Now set all the state at once
      setManagers(prev => [...prev, ...newManagers]);
      setOrchestrators(prev => [...prev, ...newOrchestrators]);
      setTrainers(prev => [...prev, ...newTrainers]);

      // Log successful connections
      console.log(`✓ Connected to ${serviceIds.length} worker(s) in workspace "${workspace}":`, serviceIds.map(id => id.split('/')[1]));

      setNewWorkspace('');
      setConnectingWorkspace(null);
    } catch (error) {
      console.error('Failed to connect to manager service:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to manager';
      setErrorPopupMessage('Failed to Add Worker');
      setErrorPopupDetails(errorMessage);
      setShowErrorPopup(true);
      setConnectError(errorMessage);
      setConnectingWorkspace(null);
      throw error;
    }
  };

  // Handle service selection confirmation
  const handleServiceSelectionConfirm = async () => {
    if (selectedServices.size === 0) {
      setErrorPopupMessage('No Services Selected');
      setErrorPopupDetails('Please select at least one manager service to connect.');
      setShowErrorPopup(true);
      return;
    }

    setShowServiceSelectionModal(false);
    setConnectingWorkspace(pendingWorkspace);
    
    try {
      await connectToManagerService(pendingWorkspace, Array.from(selectedServices));
    } catch (error) {
      // Error already handled in connectToManagerService
    } finally {
      setPendingWorkspace('');
      setAvailableServices([]);
      setSelectedServices(new Set());
    }
  };

  // Remove manager connection
  const removeManager = (serviceId: string) => {
    // serviceId is the unique identifier (format: workspace/client-id:chiron-manager)
    const managerId = serviceId;
    const manager = managers.find(m => m.serviceId === serviceId);
    const workspace = manager?.workspace || 'Unknown';

    // Check if this manager has the selected orchestrator
    const hasSelectedOrchestrator = selectedOrchestrator && 
      orchestrators.some(o => o.managerId === managerId && `${o.managerId}::${o.appId}` === selectedOrchestrator);
    
    // Check if we have selected trainers from this manager
    const managersTrainers = trainers.filter(t => t.managerId === managerId);
    const hasSelectedTrainers = managersTrainers.some(t => selectedTrainers.has(`${t.managerId}::${t.appId}`));

    // Build warning message
    let warningMessage = `Disconnecting from BioEngine Worker "${workspace}" (Manager: ${serviceId.substring(0, 12)}...) will:\n\n`;
    warningMessage += '• Remove this worker connection from your interface\n';
    warningMessage += '• Keep the orchestrator and trainer applications running on the worker\n';
    
    if (hasSelectedOrchestrator) {
      warningMessage += '• Deselect the currently selected orchestrator\n';
    }
    
    if (hasSelectedTrainers) {
      warningMessage += '• Deselect the trainers from this worker\n';
      if (isTraining) {
        warningMessage += '• Selected trainers will finish the current round but won\'t participate in future rounds\n';
      }
    }

    warningMessage += '\nAre you sure you want to disconnect?';

    // Show confirmation modal
    setConfirmModalTitle('Disconnect Worker');
    setConfirmModalMessage(warningMessage);
    setConfirmModalAction(() => () => {
      performRemoveManager(serviceId);
    });
    setShowConfirmModal(true);
  };

  // Perform the actual manager removal
  const performRemoveManager = async (serviceId: string) => {
    // serviceId is the unique identifier
    const managerId = serviceId;

    // Unregister and deselect trainers from this manager
    const managersTrainers = trainers.filter(t => t.managerId === managerId);
    if (managersTrainers.length > 0) {
      // Unregister each selected trainer
      for (const trainer of managersTrainers) {
        const trainerId = `${trainer.managerId}::${trainer.appId}`;
        if (selectedTrainers.has(trainerId)) {
          await unregisterTrainer(trainerId);
        }
      }
      
      // Deselect trainers
      setSelectedTrainers(prev => {
        const newSet = new Set(prev);
        managersTrainers.forEach(t => {
          newSet.delete(`${t.managerId}::${t.appId}`);
        });
        return newSet;
      });
    }

    // Deselect orchestrator if it belongs to this manager
    if (selectedOrchestrator && 
        orchestrators.some(o => o.managerId === managerId && `${o.managerId}::${o.appId}` === selectedOrchestrator)) {
      setSelectedOrchestrator(null);
      setTrainingHistory(null);
    }

    // Remove only this specific manager (by serviceId)
    setManagers(prev => prev.filter(m => m.serviceId !== serviceId));
    
    // Clear timer for this specific manager
    setWorkerTimers(prev => {
      const timer = prev[managerId];
      if (timer) {
        clearTimeout(timer);
        const newTimers = { ...prev };
        delete newTimers[managerId];
        return newTimers;
      }
      return prev;
    });
    
    // Remove orchestrators/trainers only from this specific manager
    setOrchestrators(prev => prev.filter(o => o.managerId !== managerId));
    setTrainers(prev => prev.filter(t => t.managerId !== managerId));
  };

  // Refresh a specific manager's worker info
  const refreshWorkerInfo = useCallback(async (serviceId: string) => {
    const managerId = serviceId;
    
    // Get current manager from state
    const manager = managers.find(m => m.serviceId === serviceId);
    
    if (!manager) {
      console.warn(`[${serviceId}] Manager not found, skipping refresh`);
      return;
    }

    console.log(`[${serviceId}] Starting refreshWorkerInfo...`);

    try {
      // Try to verify service is still available by getting worker info
      // Retry once if we get the initialization error
      let workerInfo;
      let retryOnce = true;

      try {
        // Set up a 10-second timeout for the worker info request
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Worker info request timeout (10s)')), 10000)
        );
        workerInfo = await Promise.race([manager.service.get_worker_info(), timeoutPromise]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';
        
        // Check if this is a timeout
        if (errorMessage.includes('timeout')) {
          throw new Error('Worker is not responding (timeout after 10s)');
        }
        
        // Check if this is the known initialization error and we haven't retried yet
        if (retryOnce && errorMessage.includes("'NoneType' object has no attribute 'get_status'")) {
          console.debug(`[${serviceId}] Temporary initialization issue, retrying in 2s...`);
          retryOnce = false;
          
          // Wait 2 seconds and retry once (with new timeout)
          await new Promise(resolve => setTimeout(resolve, 2000));
          const retryTimeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Worker info request timeout (10s)')), 10000)
          );
          workerInfo = await Promise.race([manager.service.get_worker_info(), retryTimeoutPromise]);
        } else {
          throw error;
        }
      }

      console.log(`[${serviceId}] refreshWorkerInfo - orchestrator_status:`, workerInfo.orchestrator_status);

      // Mark as connected and update worker info
      setManagers(prev => prev.map(m =>
        m.serviceId === serviceId
          ? { ...m, isConnected: true, workerInfo }
          : m
      ));

      // Update orchestrator
      setOrchestrators(prev => {
        const filtered = prev.filter(o => o.managerId !== managerId);
        // Only add orchestrator if it has a valid status (not empty string or undefined)
        if (workerInfo.orchestrator_status && workerInfo.orchestrator_status.status) {
          const orchStatus = workerInfo.orchestrator_status;
          console.log(`[${serviceId}] Updating orchestrator in state with status: ${orchStatus.status}`);
          return [...filtered, {
            managerId: managerId,
            appId: 'chiron-orchestrator',
            status: orchStatus.status,
            serviceIds: orchStatus.service_ids || [],
            artifactId: orchStatus.artifact_id || 'chiron-platform/tabula-trainer'
          }];
        }
        console.log(`[${serviceId}] No valid orchestrator status found, not adding to state`);
        return filtered;
      });

      // Update trainers
      setTrainers(prev => {
        const filtered = prev.filter(t => t.managerId !== managerId);
        const newTrainers: TrainerApp[] = [];
        if (workerInfo.trainers_status) {
          for (const [appId, trainerStatus] of Object.entries(workerInfo.trainers_status)) {
            newTrainers.push({
              managerId: managerId,
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
      console.error(`Failed to refresh worker (${serviceId}):`, error);
      // Mark manager as disconnected - service is no longer available or not responding
      setManagers(prev => prev.map(m =>
        m.serviceId === serviceId
          ? { ...m, isConnected: false }
          : m
      ));
      // Stop refreshing this manager since it's unavailable
      setWorkerTimers(prev => {
        const timer = prev[managerId];
        if (timer) {
          clearTimeout(timer);
          const newTimers = { ...prev };
          delete newTimers[managerId];
          return newTimers;
        }
        return prev;
      });
    }
  }, [managers]); // Need managers to find the manager connection

  // Schedule next refresh for a worker (5 seconds)
  const scheduleWorkerRefresh = useCallback((serviceId: string) => {
    const managerId = serviceId;
    
    // Set new timer
    const timer = setTimeout(() => {
      refreshWorkerInfo(serviceId).then(() => {
        scheduleWorkerRefresh(serviceId);
      }).catch((error) => {
        console.error(`[${serviceId}] Refresh failed:`, error);
      });
    }, 5000);

    setWorkerTimers(prev => {
      // Clear existing timer if any
      if (prev[managerId]) {
        clearTimeout(prev[managerId]);
      }
      return { ...prev, [managerId]: timer };
    });
  }, [refreshWorkerInfo]);

  // Refresh all managers (initial load and when managers change)
  const refreshAllManagers = useCallback(async () => {
    // Use functional update to get current managers
    let currentManagers: ManagerConnection[] = [];
    setManagers(prev => {
      currentManagers = prev;
      return prev; // No change, just reading
    });
    
    for (const manager of currentManagers) {
      const managerId = manager.serviceId;
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    }
  }, [refreshWorkerInfo, scheduleWorkerRefresh]);

  // Refresh all managers for a specific workspace
  const refreshWorkspace = useCallback(async (workspace: string) => {
    // Use functional update to get current managers
    let currentManagers: ManagerConnection[] = [];
    setManagers(prev => {
      currentManagers = prev.filter(m => m.workspace === workspace);
      return prev; // No change, just reading
    });
    
    for (const manager of currentManagers) {
      const managerId = manager.serviceId;
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    }
  }, [refreshWorkerInfo, scheduleWorkerRefresh]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      Object.values(workerTimers).forEach(timer => clearTimeout(timer));
    };
  }, [workerTimers]);

  // Create orchestrator
  const createOrchestrator = async (managerId: string) => {
    // managerId is the serviceId (format: workspace/client-id:chiron-manager)
    const manager = managers.find(m => m.serviceId === managerId);
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

      console.log(`[${managerId.split('/')[1]}] Orchestrator creation initiated, waiting for orchestrator to appear...`);

      // Wait for orchestrator to appear in worker info (retry up to 40 times with 500ms delay = 20 seconds)
      let retries = 40;
      let orchestratorFound = false;
      
      while (retries > 0 && !orchestratorFound) {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        try {
          const workerInfo = await manager.service.get_worker_info();
          
          // Check if orchestrator appears with any status
          if (workerInfo.orchestrator_status && workerInfo.orchestrator_status.status) {
            orchestratorFound = true;
            console.log(`✓ Orchestrator found on worker ${managerId.split('/')[1]} with status: ${workerInfo.orchestrator_status.status}`);
          } else {
            retries--;
            if (retries % 5 === 0) { // Log every 2.5 seconds
              console.log(`[${managerId.split('/')[1]}] Waiting for orchestrator to appear... (${retries * 0.5}s remaining)`);
            }
          }
        } catch (error) {
          console.warn(`[${managerId.split('/')[1]}] Failed to poll worker info:`, error);
          retries--;
        }
      }

      if (!orchestratorFound) {
        throw new Error('Orchestrator deployment timed out. The orchestrator may still be starting in the background.');
      }

      console.log(`[${managerId.split('/')[1]}] Calling refreshWorkerInfo after orchestrator creation...`);
      
      // Refresh worker info immediately to update state and reset timer
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
      
      console.log(`[${managerId.split('/')[1]}] Refresh complete, closing modal`);
      
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
    // managerId is the serviceId (format: workspace/client-id:chiron-manager)
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager || newTrainerDatasets.length === 0) return;

    setIsCreatingTrainer(true);

    try {
      // Generate token
      const applicationToken = await server.generateToken({
        workspace: server.config.workspace,
        permission: 'read_write',
        expires_in: 3600 * 24 * 30
      });

      const createdTrainerId = await manager.service.create_trainer({
        token: applicationToken,
        datasets: newTrainerDatasets,
        trainer_artifact_id: newTrainerArtifactId,
        initial_weights: newTrainerInitialWeights || null,
        _rkwargs: true
      });

      console.log(`[${managerId.split('/')[1]}] Trainer creation initiated (ID: ${createdTrainerId}), waiting for trainer to appear...`);

      // Wait for the specific trainer to appear in worker info (retry up to 40 times with 500ms delay = 20 seconds)
      let retries = 40;
      let trainerFound = false;
      
      while (retries > 0 && !trainerFound) {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        try {
          const workerInfo = await manager.service.get_worker_info();
          
          // Check if the created trainer appears in trainers_status
          if (workerInfo.trainers_status && workerInfo.trainers_status[createdTrainerId]) {
            const status = workerInfo.trainers_status[createdTrainerId].status;
            trainerFound = true;
            console.log(`✓ Trainer ${createdTrainerId} found on worker ${managerId.split('/')[1]} with status: ${status}`);
          } else {
            retries--;
            if (retries % 5 === 0) { // Log every 2.5 seconds
              console.log(`[${managerId.split('/')[1]}] Waiting for trainer ${createdTrainerId} to appear... (${retries * 0.5}s remaining)`);
            }
          }
        } catch (error) {
          console.warn(`[${managerId.split('/')[1]}] Failed to poll worker info:`, error);
          retries--;
        }
      }

      if (!trainerFound) {
        throw new Error('Trainer deployment timed out. The trainer may still be starting in the background.');
      }

      console.log(`[${managerId.split('/')[1]}] Calling refreshWorkerInfo after trainer creation...`);
      
      // Refresh worker info immediately to update state and reset timer
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
      
      console.log(`[${managerId.split('/')[1]}] Refresh complete, closing modal`);
      
      // Close the modal
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
    // managerId is the serviceId
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;

    // Check if this orchestrator has training history (only if it's selected, since we only load history for selected orchestrator)
    const orchestratorId = `${managerId}::chiron-orchestrator`;
    const isSelected = orchestratorId === selectedOrchestrator;
    
    if (isSelected && trainingHistory && 
        ((trainingHistory.training_losses && trainingHistory.training_losses.length > 0) || 
         (trainingHistory.validation_losses && trainingHistory.validation_losses.length > 0))) {
      // Show confirmation modal for orchestrator with known training history
      setConfirmModalTitle('Delete Orchestrator with Training History');
      setConfirmModalMessage(
        'This orchestrator has training history that will be permanently lost. ' +
        'Are you sure you want to delete it?'
      );
      setConfirmModalAction(() => async () => {
        await performRemoveOrchestrator(managerId);
      });
      setShowConfirmModal(true);
      return;
    }

    // If orchestrator is selected but we're unsure about history, or if it's not selected, show generic warning
    const orchestrator = orchestrators.find(o => o.managerId === managerId);
    if (orchestrator && orchestrator.status === 'RUNNING') {
      setConfirmModalTitle('Delete Orchestrator');
      setConfirmModalMessage(
        'Are you sure you want to delete this orchestrator? ' +
        (isSelected ? 'Any training history will be permanently lost.' : 'Any training history on this orchestrator will be permanently lost.')
      );
      setConfirmModalAction(() => async () => {
        await performRemoveOrchestrator(managerId);
      });
      setShowConfirmModal(true);
      return;
    }

    // Not running, proceed directly
    await performRemoveOrchestrator(managerId);
  };

  // Perform the actual orchestrator removal
  const performRemoveOrchestrator = async (managerId: string) => {
    // managerId is the serviceId
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;

    // Immediately mark as deleting in UI
    setOrchestrators(prev => prev.map(o =>
      o.managerId === managerId ? { ...o, status: 'DELETING' } : o
    ));

    try {
      await manager.service.remove_orchestrator();

      // Immediately refresh worker info and reset the timer
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
    // Prevent trainer deletion during training
    if (isTraining) {
      setErrorPopupMessage('Cannot Delete Trainer');
      setErrorPopupDetails('You cannot delete a trainer while training is in progress. Please stop the training first.');
      setShowErrorPopup(true);
      return;
    }

    const trainerId = `${managerId}::${appId}`;
    
    // Unregister if selected
    if (selectedTrainers.has(trainerId)) {
      await unregisterTrainer(trainerId);
      setSelectedTrainers(prev => {
        const newSet = new Set(prev);
        newSet.delete(trainerId);
        return newSet;
      });
    }

    // managerId is the serviceId
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;

    // Immediately mark as deleting in UI
    setTrainers(prev => prev.map(t =>
      t.managerId === managerId && t.appId === appId ? { ...t, status: 'DELETING' } : t
    ));

    try {
      await manager.service.remove_trainer(appId);

      // Immediately refresh worker info and reset the timer
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
    // Extract serviceId from the id
    // For manager: format is "workspace::serviceId"
    // For orchestrator: format is "managerId::appId" where managerId is the serviceId
    // For trainer: format is "workspace::appId" - this needs to be fixed too!
    
    let manager: ManagerConnection | undefined;
    
    if (type === 'manager') {
      // id format: "workspace::serviceId"
      const serviceId = id.split('::')[1];
      manager = managers.find(m => m.serviceId === serviceId);
    } else if (type === 'orchestrator') {
      // id format: "managerId::appId" where managerId is the serviceId
      const managerId = id.split('::')[0];
      manager = managers.find(m => m.serviceId === managerId);
    } else if (type === 'trainer') {
      // id format should be "managerId::appId" not "workspace::appId"
      // But let's handle both cases for backward compatibility
      const parts = id.split('::');
      if (parts.length === 2) {
        // Try to find by serviceId first (correct format)
        manager = managers.find(m => m.serviceId === parts[0]);
        // If not found, try by workspace (old format)
        if (!manager) {
          manager = managers.find(m => m.workspace === parts[0]);
        }
      }
    }
    
    if (!manager) return;

    // Show modal immediately with loading state
    setInfoModalType(type);
    setInfoModalData(null);
    setIsInfoModalLoading(true);
    setShowInfoModal(true);

    try {
      // Use cached worker info if available, otherwise fetch fresh
      let workerInfo = manager.workerInfo;
      
      if (!workerInfo) {
        // If no cached info, try to fetch with timeout
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        );
        workerInfo = await Promise.race([manager.service.get_worker_info(), timeoutPromise]);
      }

      if (!workerInfo) {
        throw new Error('Could not retrieve worker information');
      }

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

      setIsInfoModalLoading(false);
    } catch (error) {
      console.error('Failed to get info:', error);
      setIsInfoModalLoading(false);
      setErrorPopupMessage('Failed to Get Information');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while retrieving information');
      setShowErrorPopup(true);
      setShowInfoModal(false);
    }
  };

  // Register a trainer with the orchestrator
  const registerTrainer = async (trainerId: string) => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
    if (!trainer || trainer.status !== 'RUNNING') return;

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const trainerServiceId = trainer.serviceIds[0].websocket_service_id;
      await orchestratorService.add_trainer(trainerServiceId);
    } catch (error) {
      console.error('Failed to register trainer:', error);
      setErrorPopupMessage('Failed to Register Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while registering the trainer');
      setShowErrorPopup(true);
    }
  };

  // Unregister a trainer from the orchestrator
  const unregisterTrainer = async (trainerId: string) => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
    if (!trainer || trainer.status !== 'RUNNING') return;

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const trainerServiceId = trainer.serviceIds[0].websocket_service_id;
      await orchestratorService.remove_trainer(trainerServiceId);
    } catch (error) {
      console.error('Failed to unregister trainer:', error);
      // Don't show error popup for unregister as it might happen during cleanup
      console.warn('Continuing despite unregister error');
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

  // Register selected trainers when orchestrator is first selected
  useEffect(() => {
    const registerExistingTrainers = async () => {
      if (!selectedOrchestrator || selectedTrainers.size === 0) return;

      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') return;

      // Register all currently selected trainers
      for (const trainerId of Array.from(selectedTrainers)) {
        const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
        if (trainer && trainer.status === 'RUNNING') {
          await registerTrainer(trainerId);
        }
      }
    };

    registerExistingTrainers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrchestrator]); // Only run when orchestrator changes

  // Fetch training history when orchestrator is selected or on stage changes
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
        
        // Set history regardless of whether it has data (allows showing empty charts)
        if (history) {
          setTrainingHistory(history);
        }
      } catch (error) {
        // Silently handle - orchestrator might not have history yet
        console.debug('No training history available yet:', error);
      }
    };

    fetchTrainingHistory();
  }, [selectedOrchestrator, orchestrators, server]);

  // Fetch training history regularly while training is active or on stage changes
  useEffect(() => {
    if (!selectedOrchestrator || !isTraining) return;

    let previousStage: string | null = trainingStatus?.stage ?? null;

    const fetchHistoryPeriodically = async () => {
      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') return;

      try {
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        
        // Fetch history
        const history = await orchestratorService.get_training_history();
        if (history) {
          setTrainingHistory(history);
        }

        // Check for stage changes
        const status = await orchestratorService.get_training_status();
        if (status) {
          setTrainingStatus(status);
          
          // If stage changed, fetch history immediately
          if (previousStage !== status.stage) {
            previousStage = status.stage;
          }
        }
      } catch (error) {
        console.debug('Failed to fetch training history during training:', error);
      }
    };

    // Poll for history every 2 seconds while training
    const historyInterval = setInterval(fetchHistoryPeriodically, 2000);
    
    return () => clearInterval(historyInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTraining, selectedOrchestrator]);

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
      
      if (currentTrainers.length === 0) {
        throw new Error('No trainers available for training. Please select at least one trainer.');
      }

      setIsPreparingTraining(false);
      setIsTraining(true);

      // Prepare training parameters
      const trainingParams: any = { 
        num_rounds: numRounds, 
        timeout: 600,
        _rkwargs: true 
      };
      
      // Add optional parameters if set
      if (limitTrainBatches !== null) {
        trainingParams.limit_train_batches = limitTrainBatches;
      }
      if (limitEvalBatches !== null) {
        trainingParams.limit_eval_batches = limitEvalBatches;
      }

      console.log(`✓ Starting federated training with ${currentTrainers.length} trainer(s) for ${numRounds} rounds`);

      // Start training in background
      orchestratorService.start_training(trainingParams).catch((error: Error) => {
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

            console.log(`✓ Federated training completed (${status.current_training_round}/${status.target_round} rounds)`);

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
      console.log('✓ Training stopped successfully');
    } catch (error) {
      console.error('Failed to stop training:', error);
      setErrorPopupMessage('Failed to Stop Training');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while stopping the training');
      setShowErrorPopup(true);
    }
  };

  // Reset training state
  const resetTrainingState = async () => {
    if (!selectedOrchestrator) return;

    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;

    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.reset_training_state();
      setTrainingHistory(null);
      setTrainingStatus(null);
    } catch (error) {
      console.error('Failed to reset training state:', error);
      setErrorPopupMessage('Failed to Reset Training State');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error occurred while resetting the training state');
      setShowErrorPopup(true);
    }
  };

  // Handle orchestrator selection change with confirmation
  const handleOrchestratorSelectionChange = (newOrchestratorId: string) => {
    // Prevent orchestrator changes during training
    if (isTraining) {
      setErrorPopupMessage('Cannot Change Orchestrator');
      setErrorPopupDetails('You cannot change the orchestrator while training is in progress. Please stop the training first.');
      setShowErrorPopup(true);
      return;
    }

    // Check if currently selected orchestrator has training history
    if (selectedOrchestrator && selectedOrchestrator !== newOrchestratorId && 
        trainingHistory && 
        ((trainingHistory.training_losses && trainingHistory.training_losses.length > 0) || 
         (trainingHistory.validation_losses && trainingHistory.validation_losses.length > 0))) {
      // Show confirmation modal
      setConfirmModalTitle('Switch Orchestrator');
      setConfirmModalMessage(
        'The currently selected orchestrator has training history. ' +
        'Switching will clear the displayed history. Do you want to continue?'
      );
      setConfirmModalAction(() => () => {
        setSelectedOrchestrator(newOrchestratorId);
      });
      setShowConfirmModal(true);
      return;
    }

    // No history or same orchestrator, proceed directly
    setSelectedOrchestrator(newOrchestratorId);
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
  const getStatusBadge = (status?: string) => {
    const displayStatus = status || 'NOT_STARTED';
    const statusConfig: Record<string, { color: string; icon: any }> = {
      'NOT_STARTED': { color: 'bg-gray-100 text-gray-800', icon: FaClock },
      'DEPLOYING': { color: 'bg-blue-100 text-blue-800', icon: BiLoaderAlt },
      'DEPLOY_FAILED': { color: 'bg-red-100 text-red-800', icon: FaTimesCircle },
      'RUNNING': { color: 'bg-green-100 text-green-800', icon: FaCheckCircle },
      'UNHEALTHY': { color: 'bg-yellow-100 text-yellow-800', icon: FaTimesCircle },
      'DELETING': { color: 'bg-orange-100 text-orange-800', icon: BiLoaderAlt }
    };

    const config = statusConfig[displayStatus] || statusConfig['NOT_STARTED'];
    const Icon = config.icon;

    return (
      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
        <Icon className={`mr-1 ${displayStatus === 'DEPLOYING' || displayStatus === 'DELETING' ? 'animate-spin' : ''}`} />
        {displayStatus}
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
          Connect to BioEngine Workers
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
          {managers.map((manager) => {
            const workerId = `${manager.workspace}::${manager.serviceId}`;
            return (
              <div key={workerId} className={`flex items-center justify-between p-4 rounded-lg ${manager.isConnected ? 'bg-gray-50' : 'bg-red-50 border border-red-200'}`}>
                <div className="flex items-center">
                  {manager.isConnected ? (
                    <FaCheckCircle className="text-green-500 mr-3" />
                  ) : (
                    <FaTimesCircle className="text-red-500 mr-3" />
                  )}
                    <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{manager.workspace}</p>
                      {!manager.isConnected && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                          Disconnected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 break-all">Manager ID: {manager.serviceId}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => showInfo('manager', `${manager.workspace}::${manager.serviceId}`)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded"
                    title="Show info"
                  >
                    <FaInfo />
                  </button>
                  <button
                    onClick={() => removeManager(manager.serviceId)}
                    className="p-2 text-orange-600 hover:bg-orange-50 rounded"
                    title="Disconnect from worker"
                  >
                    <FaUnlink />
                  </button>
                </div>
              </div>
            );
          })}
          {managers.length === 0 && (
            <p className="text-gray-500 text-center py-4">No managers connected yet</p>
          )}
        </div>
      </div>

      {/* Step 2: Create Orchestrators and Trainers */}
      {managers.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Start Orchestrators and Trainers
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {managers.map((manager) => {
              const workerId = `${manager.workspace}::${manager.serviceId}`;
              const managerId = manager.serviceId;
              const isDisconnected = !manager.isConnected;
              
              return (
                <div 
                  key={workerId} 
                  className={`border rounded-lg p-4 ${isDisconnected ? 'border-red-300 bg-red-50 opacity-75' : 'border-gray-200'}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-medium text-gray-900">{manager.workspace}</h3>
                      <p className="text-xs text-gray-500 break-all">Manager: {manager.serviceId}</p>
                    </div>
                    {isDisconnected && (
                      <span className="text-xs px-2 py-1 bg-red-200 text-red-800 rounded font-medium">
                        DISCONNECTED
                      </span>
                    )}
                  </div>

                  {/* Orchestrator section */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">Orchestrator</span>
                      {!orchestrators.find(o => o.managerId === managerId) && (
                        <button
                          onClick={() => {
                            setCreatingFor(managerId);
                            setShowCreateOrchestrator(true);
                          }}
                          disabled={isDisconnected}
                          className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                          title={isDisconnected ? "Cannot create while disconnected" : "Create orchestrator"}
                        >
                          Create
                        </button>
                      )}
                    </div>

                    {orchestrators.filter(o => o.managerId === managerId).map((orch) => (
                      <div key={orch.appId} className="bg-gray-50 p-3 rounded flex items-center justify-between">
                        <div className="flex-1">
                          <p className="text-sm font-medium">{orch.appId}</p>
                          <p className="text-xs text-gray-500">{orch.artifactId}</p>
                          <div className="mt-1">{getStatusBadge(orch.status)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => showInfo('orchestrator', `${managerId}::${orch.appId}`)}
                            className="p-2 text-blue-600 hover:bg-blue-100 rounded"
                          >
                            <FaInfo />
                          </button>
                          <button
                            onClick={() => removeOrchestrator(managerId)}
                            disabled={isDisconnected}
                            className="p-2 text-red-600 hover:bg-red-50 rounded disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                            title={isDisconnected ? "Cannot remove while disconnected" : "Remove orchestrator"}
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
                          setCreatingFor(managerId);
                          setShowCreateTrainer(true);
                        }}
                        disabled={isDisconnected}
                        className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                        title={isDisconnected ? "Cannot create while disconnected" : "Create trainer"}
                      >
                        Create
                      </button>
                    </div>

                    <div className="space-y-2">
                      {trainers.filter(t => t.managerId === managerId).map((trainer) => (
                        <div key={trainer.appId} className="bg-gray-50 p-3 rounded">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex-1">
                              <p className="text-sm font-medium">{trainer.appId}</p>
                              <p className="text-xs text-gray-500">{Object.keys(trainer.datasets).join(', ')}</p>
                              <div className="mt-1">{getStatusBadge(trainer.status)}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => showInfo('trainer', `${managerId}::${trainer.appId}`)}
                                className="p-2 text-blue-600 hover:bg-blue-100 rounded"
                              >
                                <FaInfo />
                              </button>
                              <button
                                onClick={() => removeTrainer(managerId, trainer.appId)}
                                disabled={isDisconnected}
                                className="p-2 text-red-600 hover:bg-red-50 rounded disabled:text-gray-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                                title={isDisconnected ? "Cannot remove while disconnected" : "Remove trainer"}
                              >
                                <FaTrash />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                      {trainers.filter(t => t.managerId === managerId).length === 0 && (
                        <p className="text-xs text-gray-500 text-center py-2">No trainers</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selection section */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h3 className="font-medium text-gray-900 mb-3">Select Applications for Training</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Select orchestrator */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Orchestrator (select one)
                  {isTraining && <span className="text-xs text-orange-600 ml-2">(Cannot change during training)</span>}
                </label>
                <div className="space-y-2">
                  {orchestrators.filter(o => o.status === 'RUNNING').map((orch) => (
                    <label 
                      key={`${orch.managerId}::${orch.appId}`} 
                      className={`flex items-center p-3 bg-gray-50 rounded ${isTraining ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-gray-100'}`}
                    >
                      <input
                        type="radio"
                        name="orchestrator"
                        checked={selectedOrchestrator === `${orch.managerId}::${orch.appId}`}
                        onChange={() => handleOrchestratorSelectionChange(`${orch.managerId}::${orch.appId}`)}
                        disabled={isTraining}
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
                  {isTraining && <span className="text-xs text-blue-600 ml-2">(Deselecting removes from next round)</span>}
                </label>
                <div className="space-y-2">
                  {trainers.filter(t => t.status === 'RUNNING').map((trainer) => (
                    <label key={`${trainer.managerId}::${trainer.appId}`} className="flex items-center p-3 bg-gray-50 rounded cursor-pointer hover:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={selectedTrainers.has(`${trainer.managerId}::${trainer.appId}`)}
                        onChange={async (e) => {
                          const id = `${trainer.managerId}::${trainer.appId}`;
                          const isChecked = e.target.checked;
                          
                          // Update state
                          setSelectedTrainers(prev => {
                            const newSet = new Set(prev);
                            if (isChecked) {
                              newSet.add(id);
                            } else {
                              newSet.delete(id);
                            }
                            return newSet;
                          });

                          // Immediately register or unregister
                          if (isChecked) {
                            await registerTrainer(id);
                          } else {
                            await unregisterTrainer(id);
                          }
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
      {selectedOrchestrator && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Start Federated Training
          </h2>

          {/* Training controls */}
          <div className="mb-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Number of Rounds
                </label>
                <input
                  type="number"
                  value={numRounds}
                  onChange={(e) => setNumRounds(parseInt(e.target.value) || 1)}
                  min="1"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  disabled={isTraining}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Limit Train Batches (optional)
                </label>
                <input
                  type="number"
                  value={limitTrainBatches === null ? '' : limitTrainBatches}
                  onChange={(e) => setLimitTrainBatches(e.target.value === '' ? null : parseInt(e.target.value))}
                  min="1"
                  placeholder="All batches"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  disabled={isTraining}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Limit Eval Batches (optional)
                </label>
                <input
                  type="number"
                  value={limitEvalBatches === null ? '' : limitEvalBatches}
                  onChange={(e) => setLimitEvalBatches(e.target.value === '' ? null : parseInt(e.target.value))}
                  min="1"
                  placeholder="All batches"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  disabled={isTraining}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              {!isTraining ? (
                <button
                  onClick={startTraining}
                  disabled={isPreparingTraining || selectedTrainers.size === 0}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center font-medium"
                  title={selectedTrainers.size === 0 ? "Please select at least one trainer to start training" : ""}
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

              <button
                onClick={resetTrainingState}
                disabled={isTraining}
                className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center font-medium"
                title="Reset training state (clears history and parameters)"
              >
                <FaTrash className="mr-2" />
                Reset State
              </button>
            </div>
          </div>

          {/* Training status - only show when actively training */}
          {isTraining && trainingStatus && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-blue-900">
                  Training Round {trainingStatus.current_training_round} / {trainingStatus.target_round}
                </h3>
                <span className="text-sm font-medium text-blue-700 uppercase">
                  {trainingStatus.stage || 'Idle'}
                </span>
              </div>

              <div className="space-y-2">
                {Object.entries(trainingStatus.trainers_progress).map(([trainerId, progress]) => {
                  const hasError = !!progress.error;
                  const stageColor = trainingStatus.stage === 'fit' ? 'bg-blue-600' : 'bg-green-600';
                  
                  return (
                    <div key={trainerId}>
                      <div className="flex justify-between text-sm mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-700">Trainer {getTrainerAppId(trainerId)}</span>
                          {hasError && (
                            <button
                              onClick={() => {
                                setErrorDetailTrainerId(getTrainerAppId(trainerId));
                                setErrorDetailMessage(progress.error || 'Unknown error');
                                setShowErrorDetailModal(true);
                              }}
                              className="text-red-600 hover:text-red-800"
                              title="View error details"
                            >
                              <FaTimesCircle />
                            </button>
                          )}
                        </div>
                        <span className="text-gray-600">
                          {progress.current_batch} / {progress.total_batches} batches
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                        <div
                          className={`${hasError ? 'bg-red-600' : stageColor} h-2 rounded-full transition-all duration-300 relative`}
                          style={{ width: `${progress.progress * 100}%` }}
                        >
                          {/* Animated shimmer effect */}
                          {!hasError && (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"></div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Training history */}
          {trainingHistory && ((trainingHistory.training_losses && trainingHistory.training_losses.length > 0) || 
                                (trainingHistory.validation_losses && trainingHistory.validation_losses.length > 0)) && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <h3 className="font-medium text-gray-900 mb-4">Training History</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Training Loss chart */}
                {trainingHistory.training_losses && trainingHistory.training_losses.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Training Loss</h4>
                    <div className="relative h-64 bg-white border border-gray-200 rounded p-4">
                      <svg className="w-full h-full" viewBox="0 0 450 200">
                        {(() => {
                          // Extract values from [[round, loss], [round, loss], ...]
                          const lossData = trainingHistory.training_losses.map((item: [number, number]) => ({
                            round: item[0],
                            value: item[1]
                          }));
                          
                          const lossValues = lossData.map((d: {round: number, value: number}) => d.value);
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
                                    {value.toFixed(3)}
                                  </text>
                                </g>
                              );
                            })}
                            
                            {/* X-axis labels - show round numbers */}
                            {lossData.map((d: {round: number, value: number}, i: number) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              return (
                                <text key={i} x={x} y="180" textAnchor="middle" fontSize="10" fill="#6b7280">
                                  {d.round}
                                </text>
                              );
                            })}
                            
                            {/* X-axis label */}
                            <text x="235" y="195" textAnchor="middle" fontSize="11" fill="#374151" fontWeight="500">
                              Round
                            </text>
                            
                            {/* Plot line */}
                            <polyline
                              points={lossData.map((d: {round: number, value: number}, i: number) => {
                                const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                                const y = 20 + ((maxLoss - d.value) / range) * 140;
                                return `${x},${y}`;
                              }).join(' ')}
                              fill="none"
                              stroke="#2563eb"
                              strokeWidth="2"
                            />
                            
                            {/* Plot points */}
                            {lossData.map((d: {round: number, value: number}, i: number) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              const y = 20 + ((maxLoss - d.value) / range) * 140;
                              return (
                                <g key={i}>
                                  <circle cx={x} cy={y} r="4" fill="#2563eb" />
                                  <title>{`Round ${d.round}: ${d.value.toFixed(4)}`}</title>
                                </g>
                              );
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                </div>
                )}

                {/* Validation Loss chart */}
                {trainingHistory.validation_losses && trainingHistory.validation_losses.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Validation Loss</h4>
                    <div className="relative h-64 bg-white border border-gray-200 rounded p-4">
                      <svg className="w-full h-full" viewBox="0 0 450 200">
                        {(() => {
                          // Extract values from [[round, loss], [round, loss], ...]
                          const lossData = trainingHistory.validation_losses.map((item: [number, number]) => ({
                            round: item[0],
                            value: item[1]
                          }));
                          
                          const lossValues = lossData.map((d: {round: number, value: number}) => d.value);
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
                                    {value.toFixed(3)}
                                  </text>
                                </g>
                              );
                            })}
                            
                            {/* X-axis labels - show round numbers */}
                            {lossData.map((d: {round: number, value: number}, i: number) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              return (
                                <text key={i} x={x} y="180" textAnchor="middle" fontSize="10" fill="#6b7280">
                                  {d.round}
                                </text>
                              );
                            })}
                            
                            {/* X-axis label */}
                            <text x="235" y="195" textAnchor="middle" fontSize="11" fill="#374151" fontWeight="500">
                              Round
                            </text>
                            
                            {/* Plot line */}
                            <polyline
                              points={lossData.map((d: {round: number, value: number}, i: number) => {
                                const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                                const y = 20 + ((maxLoss - d.value) / range) * 140;
                                return `${x},${y}`;
                              }).join(' ')}
                              fill="none"
                              stroke="#10b981"
                              strokeWidth="2"
                            />
                            
                            {/* Plot points */}
                            {lossData.map((d: {round: number, value: number}, i: number) => {
                              const x = 50 + (i / Math.max(lossData.length - 1, 1)) * 370;
                              const y = 20 + ((maxLoss - d.value) / range) * 140;
                              return (
                                <g key={i}>
                                  <circle cx={x} cy={y} r="4" fill="#10b981" />
                                  <title>{`Round ${d.round}: ${d.value.toFixed(4)}`}</title>
                                </g>
                              );
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                </div>
                )}
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
                {creatingFor && managers.find(m => m.serviceId === creatingFor)?.workerInfo?.datasets &&
                  Object.entries(managers.find(m => m.serviceId === creatingFor)!.workerInfo!.datasets!).map(([datasetId, manifest]: [string, any]) => {
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
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">
                {infoModalType === 'manager' && 'Worker Information'}
                {infoModalType === 'orchestrator' && 'Orchestrator Information'}
                {infoModalType === 'trainer' && 'Trainer Information'}
              </h3>
              <button
                onClick={() => setShowInfoModal(false)}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >
                ✕
              </button>
            </div>

            {isInfoModalLoading ? (
              <div className="flex items-center justify-center py-12">
                <FaSpinner className="animate-spin text-blue-600 text-4xl" />
              </div>
            ) : (
              <>
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
              </>
            )}
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

      {/* Trainer Error Detail Modal */}
      {showErrorDetailModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <FaTimesCircle className="text-red-600 text-3xl" />
              </div>
              <div className="ml-4 flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  Error in Trainer {errorDetailTrainerId}
                </h3>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto mb-4 px-1 bg-gray-50 rounded p-4 border border-gray-200">
              <pre className="text-sm text-gray-700 whitespace-pre-wrap break-words font-mono">
                {errorDetailMessage}
              </pre>
            </div>
            <button
              onClick={() => {
                setShowErrorDetailModal(false);
                setErrorDetailTrainerId('');
                setErrorDetailMessage('');
              }}
              className="w-full px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="w-8 h-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="ml-4 flex-1">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {confirmModalTitle}
                </h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {confirmModalMessage}
                </p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmModalAction(null);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (confirmModalAction) {
                    confirmModalAction();
                  }
                  setShowConfirmModal(false);
                  setConfirmModalAction(null);
                }}
                className="flex-1 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 font-medium"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Service Selection Modal */}
      {showServiceSelectionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Multiple Manager Services Found
              </h3>
              <p className="text-sm text-gray-600 mb-4">
                Multiple chiron-manager services were found in workspace <strong>{pendingWorkspace}</strong>. 
                Please select which services you want to connect to:
              </p>
            </div>
            
            <div className="flex-1 overflow-y-auto mb-4 space-y-2">
              {availableServices.map((serviceId) => (
                <label 
                  key={serviceId}
                  className="flex items-center p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100"
                >
                  <input
                    type="checkbox"
                    checked={selectedServices.has(serviceId)}
                    onChange={(e) => {
                      const newSelected = new Set(selectedServices);
                      if (e.target.checked) {
                        newSelected.add(serviceId);
                      } else {
                        newSelected.delete(serviceId);
                      }
                      setSelectedServices(newSelected);
                    }}
                    className="mr-3"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900 break-all">{serviceId}</p>
                  </div>
                </label>
              ))}
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowServiceSelectionModal(false);
                  setPendingWorkspace('');
                  setAvailableServices([]);
                  setSelectedServices(new Set());
                  setConnectingWorkspace(null);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleServiceSelectionConfirm}
                disabled={selectedServices.size === 0}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium"
              >
                Connect ({selectedServices.size} selected)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Training;
