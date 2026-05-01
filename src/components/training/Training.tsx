import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useHyphaStore } from '../../store/hyphaStore';
import { FaPlay, FaStop, FaPlus, FaTrash, FaInfo, FaCheckCircle, FaTimesCircle, FaSpinner, FaClock, FaUnlink } from 'react-icons/fa';
import { BiLoaderAlt } from 'react-icons/bi';
import TrainingConfigPanel from './TrainingConfigPanel';
import FederatedWorldMap, { MapWorker, MapConnection, MapLegend, MapLegendMode } from './FederatedWorldMap';
import LossChart from './LossChart';

const CountryFlag: React.FC<{ countryName?: string; countryCode?: string; className?: string }> = ({ countryName, countryCode, className }) => {
  const flagUrl = countryCode
    ? `https://flagcdn.com/w40/${countryCode.toLowerCase()}.png`
    : null;

  if (!flagUrl) return null;
  return <img src={flagUrl} alt={`${countryName ?? countryCode} flag`} className={className || 'w-5 h-auto inline-block'} />;
};

interface GeoLocation {
  region: string;
  country_name: string;
  country_code: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

interface WorkerStatus {
  service_start_time: number;
  service_uptime: number;
  worker_mode: string;
  workspace: string;
  client_id: string;
  admin_users: string[];
  geo_location: GeoLocation;
  is_ready: boolean;
}

interface ApplicationInfo {
  display_name?: string;
  description?: string;
  artifact_id?: string;
  version?: string;
  status?: string;
  message?: string;
  deployments?: any[];
  application_kwargs?: any;
  application_env_vars?: any;
  gpu_enabled?: boolean;
  application_resources?: any;
  authorized_users?: string[];
  available_methods?: string[];
  max_ongoing_requests?: number;
  service_ids?: any[];
  start_time?: number;
  last_updated_by?: string;
  last_updated_at?: number;
  auto_redeploy?: boolean;
}

interface OrchestratorStatus extends ApplicationInfo { application_id?: string; }
interface TrainerStatus extends ApplicationInfo { datasets?: Record<string, any>; }

interface WorkerInfo {
  worker_info?: WorkerStatus;
  cluster_status?: ClusterStatus;
  datasets?: Record<string, any>;
  orchestrators_status?: Record<string, OrchestratorStatus>;
  trainers_status?: Record<string, TrainerStatus>;
}

interface ManagerConnection {
  workspace: string;
  serviceId: string;
  service: any;
  isConnected: boolean;
  workerInfo?: WorkerInfo;
  datasetsInfo?: Record<string, any>;
}

interface OrchestratorApp {
  managerId: string;
  appId: string;
  status: string;
  serviceIds: any[];
  artifactId: string;
  displayName?: string;
  applicationId?: string;
  isBusy?: boolean;
}

interface TrainerApp {
  managerId: string;
  appId: string;
  status: string;
  serviceIds: any[];
  datasets: Record<string, any>;
  artifactId: string;
  displayName?: string;
  applicationId?: string;
  isBusy?: boolean;
}

type TrainingStage = 'fit' | 'evaluate' | 'aggregation' | 'distribution' | null;

interface TrainingStatus {
  is_running: boolean;
  current_training_round: number;
  target_round: number;
  stage: TrainingStage;
  trainers_progress: Record<string, { current_batch: number; total_batches: number; progress: number; error?: string; }>;
}

const STAGE_LABELS: Record<NonNullable<TrainingStage>, string> = {
  fit:          'Fit',
  evaluate:     'Evaluate',
  aggregation:  'Aggregation',
  distribution: 'Distribution',
};

interface TrainingHistory {
  training_losses: [number, number][];
  validation_losses: [number, number][];
  client_training_losses?: Record<string, [number, number][]>;
  client_validation_losses?: Record<string, [number, number][]>;
}

interface ClusterStatus {
  total_cpu: number;
  used_cpu: number;
  total_gpu: number;
  used_gpu: number;
}

interface ManagerInfoModalData {
  workspace: string;
  clusterStatus: ClusterStatus | null;
  datasets: Record<string, any>;
  location?: { region: string; country_name: string; country_code: string; latitude: number; longitude: number; };
}
interface OrchestratorInfoModalData { status?: string; artifactId?: string; }
interface TrainerInfoModalData { appId: string; status?: string; datasets: Record<string, any>; artifactId?: string; }
type InfoModalData = ManagerInfoModalData | OrchestratorInfoModalData | TrainerInfoModalData;

const Training: React.FC = () => {
  const { server, isLoggedIn, user, artifactManager } = useHyphaStore();

  const [managers, setManagers] = useState<ManagerConnection[]>([]);
  const [connectingWorkspace, setConnectingWorkspace] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const STORAGE_KEY_WS = 'chiron-training-observed-workspaces';
  const DEFAULT_PUBLIC_WORKSPACE = 'chiron-platform';
  type DiscoveredWorker = { serviceId: string; name: string; description: string; hasChironManager: boolean; geo_location?: GeoLocation; datasetCount?: number };
  type WsDiscoveryStatus = 'loading' | 'loaded' | 'error';
  const [customWorkspaces, setCustomWorkspaces] = useState<string[]>(() => {
    try { const s = localStorage.getItem(STORAGE_KEY_WS); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [discoveredWorkers, setDiscoveredWorkers] = useState<Record<string, DiscoveredWorker[]>>({});
  const [wsDiscoveryStatus, setWsDiscoveryStatus] = useState<Record<string, WsDiscoveryStatus>>({});
  const [connectingServiceId, setConnectingServiceId] = useState<string | null>(null);

  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const [errorPopupMessage, setErrorPopupMessage] = useState('');
  const [errorPopupDetails, setErrorPopupDetails] = useState('');

  const [orchestrators, setOrchestrators] = useState<OrchestratorApp[]>([]);
  const [trainers, setTrainers] = useState<TrainerApp[]>([]);
  const [selectedOrchestrator, setSelectedOrchestrator] = useState<string | null>(null);

  const [showCreateOrchestrator, setShowCreateOrchestrator] = useState(false);
  const [showCreateTrainer, setShowCreateTrainer] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [isCreatingOrchestrator, setIsCreatingOrchestrator] = useState(false);
  const [isCreatingTrainer, setIsCreatingTrainer] = useState(false);
  const [newOrchestratorArtifactId, setNewOrchestratorArtifactId] = useState('chiron-platform/chiron-orchestrator');
  const [newTrainerDatasets, setNewTrainerDatasets] = useState<string[]>([]);
  const [newTrainerArtifactId, setNewTrainerArtifactId] = useState('chiron-platform/tabula-trainer');

  const [workerTimers, setWorkerTimers] = useState<Record<string, NodeJS.Timeout>>({});
  const [datasetTimers, setDatasetTimers] = useState<Record<string, NodeJS.Timeout>>({});

  const [isTraining, setIsTraining] = useState(false);
  const [trainingOrchestratorId, setTrainingOrchestratorId] = useState<string | null>(null);
  const [trainingConfigCollapsed, setTrainingConfigCollapsed] = useState(false);
  const [trainingConfigSummary, setTrainingConfigSummary] = useState({ numRounds: 5, perRoundTimeoutMinutes: 20 });
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [trainingHistory, setTrainingHistory] = useState<TrainingHistory | null>(null);
  const [registeredTrainers, setRegisteredTrainers] = useState<string[]>([]);
  const [isLoadingRegisteredTrainers, setIsLoadingRegisteredTrainers] = useState(false);
  const [isPreparingTraining, setIsPreparingTraining] = useState(false);
  const [isStoppingTraining, setIsStoppingTraining] = useState(false);
  const [resetStateSuccess, setResetStateSuccess] = useState(false);

  // Save model weights
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);
  const [saveModelDescription, setSaveModelDescription] = useState('');
  const [savedModelArtifactIds, setSavedModelArtifactIds] = useState<Record<string, string> | null>(null);
  const [savedGlobalArtifactId, setSavedGlobalArtifactId] = useState<string | null>(null);

  const [trainerParams, setTrainerParams] = useState<any>(null);
  const [trainerParamsLoading, setTrainerParamsLoading] = useState(false);
  const [trainerParamsError, setTrainerParamsError] = useState<string | null>(null);

  const [showErrorDetailModal, setShowErrorDetailModal] = useState(false);
  const [errorDetailTrainerId, setErrorDetailTrainerId] = useState<string>('');
  const [errorDetailMessage, setErrorDetailMessage] = useState<string>('');

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalTitle, setConfirmModalTitle] = useState<string>('');
  const [confirmModalMessage, setConfirmModalMessage] = useState<string>('');
  const [confirmModalAction, setConfirmModalAction] = useState<(() => void) | null>(null);
  const [confirmModalDanger, setConfirmModalDanger] = useState(false);
  const [confirmModalConfirmLabel, setConfirmModalConfirmLabel] = useState<string>('Continue');

  const [showInfoModal, setShowInfoModal] = useState(false);
  const [infoModalData, setInfoModalData] = useState<InfoModalData | null>(null);
  const [infoModalType, setInfoModalType] = useState<'manager' | 'orchestrator' | 'trainer'>('manager');
  const [isInfoModalLoading, setIsInfoModalLoading] = useState(false);

  const [showServiceSelectionModal, setShowServiceSelectionModal] = useState(false);
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [pendingWorkspace, setPendingWorkspace] = useState<string>('');

  // Step navigation
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  // Launch app dialog
  const [showLaunchDialog, setShowLaunchDialog] = useState(false);
  const [launchDialogManagerId, setLaunchDialogManagerId] = useState<string | null>(null);
  const [launchDialogTab, setLaunchDialogTab] = useState<'orchestrator' | 'trainer'>('orchestrator');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_WS, JSON.stringify(customWorkspaces));
  }, [customWorkspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const userWorkspace = server?.config?.workspace as string | undefined;

  const defaultWorkspaces = useMemo(() => {
    const ws = [DEFAULT_PUBLIC_WORKSPACE];
    if (isLoggedIn && userWorkspace && userWorkspace !== DEFAULT_PUBLIC_WORKSPACE) ws.push(userWorkspace);
    return ws;
  }, [isLoggedIn, userWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

  const observedWorkspaces = useMemo(() => {
    const all = [...defaultWorkspaces];
    for (const ws of customWorkspaces) { if (!all.includes(ws)) all.push(ws); }
    return all;
  }, [defaultWorkspaces, customWorkspaces]);

  const parseMultipleServicesFromError = (errStr: string): string[] => {
    const regex = /services:public\|bioengine-worker:([^@']+)@\*/g;
    const ids: string[] = [];
    let match;
    while ((match = regex.exec(errStr)) !== null) {
      if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
  };

  const discoverWorkspace = useCallback(async (workspace: string) => {
    if (!server) return;
    setWsDiscoveryStatus(prev => ({ ...prev, [workspace]: 'loading' }));
    try {
      let serviceIds: string[] = [];
      if (isLoggedIn && workspace === userWorkspace) {
        const list = await server.listServices({ type: 'bioengine-worker' });
        serviceIds = list.map((s: any) => s.id);
      } else {
        try {
          const svc = await server.getService(`${workspace}/bioengine-worker`);
          serviceIds = [svc.id];
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes('Multiple services found')) {
            serviceIds = parseMultipleServicesFromError(errStr);
          }
        }
      }

      const workers: DiscoveredWorker[] = [];
      await Promise.allSettled(serviceIds.map(async (svcId) => {
        try {
          const worker = await server.getService(svcId, { mode: 'random' });
          const name = worker.name || svcId;
          const description = worker.description || '';
          let hasChironManager = false;
          let geo_location: GeoLocation | undefined;
          let datasetCount: number | undefined;
          try {
            const appStatus = await worker.get_app_status({ _rkwargs: true });
            const managerKey = appStatus && typeof appStatus === 'object'
              ? Object.keys(appStatus).find(k => k.includes('chiron-manager') || (appStatus[k]?.artifact_id || '').includes('chiron-manager'))
              : undefined;
            if (managerKey) {
              hasChironManager = true;
              try {
                const managerServiceId = appStatus[managerKey]?.service_ids?.[0]?.websocket_service_id;
                if (managerServiceId) {
                  const managerSvc = await server.getService(managerServiceId);
                  const workerInfo = await managerSvc.get_worker_info();
                  geo_location = workerInfo?.worker_info?.geo_location;
                  datasetCount = workerInfo?.datasets ? Object.keys(workerInfo.datasets).length : 0;
                }
              } catch { /* enrichment optional */ }
            }
          } catch { /* no app status */ }
          if (hasChironManager) {
            workers.push({ serviceId: svcId, name, description, hasChironManager: true, geo_location, datasetCount });
          }
        } catch { /* unreachable */ }
      }));

      setDiscoveredWorkers(prev => ({ ...prev, [workspace]: workers }));
      setWsDiscoveryStatus(prev => ({ ...prev, [workspace]: 'loaded' }));
    } catch (err) {
      setWsDiscoveryStatus(prev => ({ ...prev, [workspace]: 'error' }));
    }
  }, [server, isLoggedIn, userWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (server) observedWorkspaces.forEach(ws => discoverWorkspace(ws));
  }, [server, observedWorkspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!server) return;
    const interval = setInterval(() => observedWorkspaces.forEach(ws => discoverWorkspace(ws)), 15000);
    return () => clearInterval(interval);
  }, [server, observedWorkspaces, discoverWorkspace]);

  const addObservedWorkspace = () => {
    const trimmed = workspaceInput.trim();
    if (!trimmed || observedWorkspaces.includes(trimmed)) return;
    setCustomWorkspaces(prev => [...prev, trimmed]);
    setWorkspaceInput('');
  };

  const removeObservedWorkspace = (ws: string) => {
    setCustomWorkspaces(prev => prev.filter(w => w !== ws));
    setDiscoveredWorkers(prev => { const n = { ...prev }; delete n[ws]; return n; });
    setWsDiscoveryStatus(prev => { const n = { ...prev }; delete n[ws]; return n; });
  };

  const connectWorker = async (serviceId: string, workspace: string) => {
    if (managers.find(m => m.serviceId === serviceId)) return;
    setConnectingServiceId(serviceId);
    setConnectError(null);
    try {
      await connectToManagerService(workspace, [serviceId]);
    } catch { /* handled */ }
    setConnectingServiceId(null);
  };

  const addManager = async (workspaceArg: string) => {
    if (!workspaceArg.trim()) return;
    setConnectingWorkspace(workspaceArg);
    setConnectError(null);
    try {
      const url = `https://hypha.aicell.io/${workspaceArg}/services/chiron-manager`;
      let response;
      let data;
      try {
        response = await fetch(url);
        data = await response.json();
      } catch (fetchError) {
        throw new Error(`Failed to fetch manager service information. Error: ${fetchError instanceof Error ? fetchError.message : 'Network error'}`);
      }
      if (data.id) { await connectToManagerService(workspaceArg, [data.id]); return; }
      if (!data.success && data.detail) {
        const detail = data.detail;
        if (detail.includes('Multiple services found')) {
          const servicePattern = /b'services:[^:]+:([^@]+):chiron-manager@\*'/g;
          const matches = [...detail.matchAll(servicePattern)];
          const serviceIds = matches.map((match: RegExpMatchArray) => `${match[1]}:chiron-manager`);
          if (serviceIds.length > 0) {
            const uniqueServiceIds = Array.from(new Set(serviceIds)) as string[];
            setAvailableServices(uniqueServiceIds);
            setSelectedServices(new Set(uniqueServiceIds));
            setPendingWorkspace(workspaceArg);
            setShowServiceSelectionModal(true);
            setConnectingWorkspace(null);
            return;
          }
        }
        if (detail.includes('Service not found')) {
          throw new Error('Manager service not found in workspace. Please ensure the chiron-manager service is running.');
        }
        throw new Error(`Failed to fetch manager service: ${detail}`);
      }
      throw new Error('Unexpected response format from service endpoint.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to manager';
      setErrorPopupMessage('Failed to Add Worker');
      setErrorPopupDetails(errorMessage);
      setShowErrorPopup(true);
      setConnectError(errorMessage);
      setConnectingWorkspace(null);
    }
  };

  const connectToManagerService = async (workspace: string, serviceIds: string[]) => {
    try {
      for (const serviceId of serviceIds) {
        if (managers.find(m => m.serviceId === serviceId)) {
          throw new Error(`This worker (${serviceId}) is already connected.`);
        }
      }
      const newManagers: ManagerConnection[] = [];
      const newOrchestrators: OrchestratorApp[] = [];
      const newTrainers: TrainerApp[] = [];

      for (const serviceId of serviceIds) {
        // If serviceId is a BioEngine worker (not a chiron-manager), resolve to the manager service ID
        let managerServiceId = serviceId;
        if (!serviceId.includes(':chiron-manager')) {
          try {
            const workerSvc = await server.getService(serviceId, { mode: 'random' });
            const appStatus = await workerSvc.get_app_status({ _rkwargs: true });
            const managerKey = appStatus && typeof appStatus === 'object'
              ? Object.keys(appStatus).find((k: string) => k.includes('chiron-manager') || (appStatus[k]?.artifact_id || '').includes('chiron-manager'))
              : undefined;
            if (managerKey) {
              const foundId = appStatus[managerKey]?.service_ids?.[0]?.websocket_service_id;
              if (foundId) managerServiceId = foundId;
            }
          } catch { /* keep original serviceId if resolution fails */ }
        }

        let managerService;
        try { managerService = await server.getService(managerServiceId); } catch (serviceError) {
          throw new Error(`Failed to connect to manager service (${serviceId}). Error: ${serviceError instanceof Error ? serviceError.message : 'Connection error'}`);
        }
        let workerInfo;
        let retryCount = 0;
        const maxRetries = 12;
        const retryDelay = 2500;
        while (retryCount < maxRetries) {
          try { workerInfo = await managerService.get_worker_info(); break; } catch (workerInfoError) {
            const errorMessage = workerInfoError instanceof Error ? workerInfoError.message : '';
            if (errorMessage.includes("'NoneType' object has no attribute 'get_status'")) {
              retryCount++;
              if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
              } else { throw new Error(`Failed after ${maxRetries} retries: ${errorMessage}`); }
            } else { throw new Error(`Failed to retrieve worker information: ${errorMessage}`); }
          }
        }
        newManagers.push({ workspace, serviceId, service: managerService, isConnected: true, workerInfo });
        const managerId = serviceId;
        if (workerInfo!.orchestrators_status) {
          for (const [appId, orchStatus] of Object.entries(workerInfo!.orchestrators_status)) {
            newOrchestrators.push({ managerId, appId, status: (orchStatus as any).status, serviceIds: (orchStatus as any).service_ids || [], artifactId: (orchStatus as any).artifact_id || 'chiron-platform/chiron-orchestrator', displayName: (orchStatus as any).display_name, applicationId: appId });
          }
        }
        if (workerInfo!.trainers_status) {
          for (const [appId, trainerStatus] of Object.entries(workerInfo!.trainers_status)) {
            newTrainers.push({ managerId, appId, status: (trainerStatus as any).status, serviceIds: (trainerStatus as any).service_ids || [], datasets: (trainerStatus as any).datasets || {}, artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer', displayName: (trainerStatus as any).display_name, applicationId: appId });
          }
        }
        scheduleWorkerRefresh(serviceId);
        refreshDatasetInfo(serviceId).catch(() => {});
        scheduleDatasetRefresh(serviceId);
      }
      setManagers(prev => [...prev, ...newManagers]);
      setOrchestrators(prev => [...prev, ...newOrchestrators]);
      setTrainers(prev => [...prev, ...newTrainers]);
      setConnectingWorkspace(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to manager';
      setErrorPopupMessage('Failed to Add Worker');
      setErrorPopupDetails(errorMessage);
      setShowErrorPopup(true);
      setConnectError(errorMessage);
      setConnectingWorkspace(null);
      throw error;
    }
  };

  const handleServiceSelectionConfirm = async () => {
    if (selectedServices.size === 0) {
      setErrorPopupMessage('No Services Selected');
      setErrorPopupDetails('Please select at least one manager service to connect.');
      setShowErrorPopup(true);
      return;
    }
    setShowServiceSelectionModal(false);
    setConnectingWorkspace(pendingWorkspace);
    try { await connectToManagerService(pendingWorkspace, Array.from(selectedServices)); } catch { /* handled */ } finally {
      setPendingWorkspace(''); setAvailableServices([]); setSelectedServices(new Set());
    }
  };

  const removeManager = (serviceId: string) => {
    const managerId = serviceId;
    const manager = managers.find(m => m.serviceId === serviceId);
    const workspace = manager?.workspace || 'Unknown';
    const hasSelectedOrchestrator = selectedOrchestrator && orchestrators.some(o => o.managerId === managerId && `${o.managerId}::${o.appId}` === selectedOrchestrator);
    const managersTrainers = trainers.filter(t => t.managerId === managerId);
    const hasRegisteredTrainers = managersTrainers.some(t => { const tid = t.serviceIds[0]?.websocket_service_id; return registeredTrainers.includes(tid); });
    let warningMessage = `Disconnecting from "${workspace}" will:\n\n• Remove this worker connection\n• Keep apps running on the worker\n`;
    if (hasSelectedOrchestrator) warningMessage += '• Deselect the current orchestrator\n';
    if (hasRegisteredTrainers) warningMessage += '• Deselect trainers from this worker\n';
    warningMessage += '\nAre you sure?';
    setConfirmModalTitle('Disconnect Worker');
    setConfirmModalMessage(warningMessage);
    setConfirmModalAction(() => () => { performRemoveManager(serviceId); });
    setShowConfirmModal(true);
  };

  const performRemoveManager = async (serviceId: string) => {
    const managerId = serviceId;
    const managersTrainers = trainers.filter(t => t.managerId === managerId);
    for (const trainer of managersTrainers) {
      const trainerId = `${trainer.managerId}::${trainer.appId}`;
      const trainerServiceId = trainer.serviceIds[0]?.websocket_service_id;
      if (registeredTrainers.includes(trainerServiceId)) { await unregisterTrainer(trainerId); }
    }
    if (selectedOrchestrator && orchestrators.some(o => o.managerId === managerId && `${o.managerId}::${o.appId}` === selectedOrchestrator)) {
      setSelectedOrchestrator(null); setTrainingHistory(null);
    }
    setManagers(prev => prev.filter(m => m.serviceId !== serviceId));
    setWorkerTimers(prev => {
      const timer = prev[managerId];
      if (timer) { clearTimeout(timer); const n = { ...prev }; delete n[managerId]; return n; }
      return prev;
    });
    setDatasetTimers(prev => {
      const timer = prev[managerId];
      if (timer) { clearTimeout(timer); const n = { ...prev }; delete n[managerId]; return n; }
      return prev;
    });
    setOrchestrators(prev => prev.filter(o => o.managerId !== managerId));
    setTrainers(prev => prev.filter(t => t.managerId !== managerId));
  };

  const refreshWorkerInfo = useCallback(async (serviceId: string) => {
    const managerId = serviceId;
    const manager = managers.find(m => m.serviceId === serviceId);
    if (!manager) return;
    try {
      let workerInfo;
      let retryOnce = true;
      try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
        workerInfo = await Promise.race([manager.service.get_worker_info(), timeoutPromise]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('timeout')) throw new Error('Worker is not responding (timeout)');
        if (retryOnce && msg.includes("'NoneType' object has no attribute 'get_status'")) {
          retryOnce = false;
          await new Promise(resolve => setTimeout(resolve, 2000));
          const t2 = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
          workerInfo = await Promise.race([manager.service.get_worker_info(), t2]);
        } else { throw error; }
      }
      setManagers(prev => prev.map(m => m.serviceId === serviceId ? { ...m, isConnected: true, workerInfo } : m));
      setOrchestrators(prev => {
        const filtered = prev.filter(o => o.managerId !== managerId);
        const newO: OrchestratorApp[] = [];
        if (workerInfo.orchestrators_status) {
          for (const [appId, orchStatus] of Object.entries(workerInfo.orchestrators_status)) {
            newO.push({ managerId, appId, status: (orchStatus as any).status, serviceIds: (orchStatus as any).service_ids || [], artifactId: (orchStatus as any).artifact_id || 'chiron-platform/chiron-orchestrator', displayName: (orchStatus as any).display_name, applicationId: appId, isBusy: (orchStatus as any).is_busy ?? false });
          }
        }
        return [...filtered, ...newO];
      });
      setTrainers(prev => {
        const filtered = prev.filter(t => t.managerId !== managerId);
        const newT: TrainerApp[] = [];
        if (workerInfo.trainers_status) {
          for (const [appId, trainerStatus] of Object.entries(workerInfo.trainers_status)) {
            newT.push({ managerId, appId, status: (trainerStatus as any).status, serviceIds: (trainerStatus as any).service_ids || [], datasets: (trainerStatus as any).datasets || {}, artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer', displayName: (trainerStatus as any).display_name, applicationId: appId, isBusy: (trainerStatus as any).is_busy ?? false });
          }
        }
        return [...filtered, ...newT];
      });
    } catch (error) {
      setManagers(prev => prev.map(m => m.serviceId === serviceId ? { ...m, isConnected: false } : m));
      // Clear stale app data for this manager when it becomes unreachable
      setOrchestrators(prev => prev.filter(o => o.managerId !== managerId));
      setTrainers(prev => prev.filter(t => t.managerId !== managerId));
    }
  }, [managers]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleWorkerRefresh = useCallback((serviceId: string) => {
    const managerId = serviceId;
    const timer = setTimeout(async () => {
      try { await refreshWorkerInfo(serviceId); } finally { scheduleWorkerRefresh(serviceId); }
    }, 10000);
    setWorkerTimers(prev => {
      if (prev[managerId]) clearTimeout(prev[managerId]);
      return { ...prev, [managerId]: timer };
    });
  }, [refreshWorkerInfo]);

  const refreshDatasetInfo = useCallback(async (serviceId: string) => {
    const manager = managers.find(m => m.serviceId === serviceId);
    if (!manager || !manager.isConnected) return;
    try {
      const datasetsInfo = await manager.service.get_datasets_info();
      setManagers(prev => prev.map(m => m.serviceId === serviceId ? { ...m, datasetsInfo } : m));
    } catch { /* get_datasets_info may not be available on older managers */ }
  }, [managers]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleDatasetRefresh = useCallback((serviceId: string) => {
    const timer = setTimeout(async () => {
      try { await refreshDatasetInfo(serviceId); } finally { scheduleDatasetRefresh(serviceId); }
    }, 60000);
    setDatasetTimers(prev => {
      if (prev[serviceId]) clearTimeout(prev[serviceId]);
      return { ...prev, [serviceId]: timer };
    });
  }, [refreshDatasetInfo]);

  const workerTimersRef = React.useRef(workerTimers);
  workerTimersRef.current = workerTimers;
  const datasetTimersRef = React.useRef(datasetTimers);
  datasetTimersRef.current = datasetTimers;
  useEffect(() => {
    return () => {
      Object.values(workerTimersRef.current).forEach(timer => clearTimeout(timer));
      Object.values(datasetTimersRef.current).forEach(timer => clearTimeout(timer));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createOrchestrator = async (managerId: string) => {
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;
    setIsCreatingOrchestrator(true);
    try {
      const applicationToken = await server.generateToken({ workspace: server.config.workspace, permission: 'read_write', expires_in: 3600 * 24 * 30 });
      const ownerId = user?.id as string | undefined;
      await manager.service.create_orchestrator({ token: applicationToken, owner_id: ownerId, _rkwargs: true });
      setShowCreateOrchestrator(false); setShowLaunchDialog(false); setCreatingFor(null); setIsCreatingOrchestrator(false);
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    } catch (error) {
      setErrorPopupMessage('Failed to Create Orchestrator');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
      setIsCreatingOrchestrator(false);
    }
  };

  const createTrainer = async (managerId: string) => {
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager || newTrainerDatasets.length === 0) return;
    setIsCreatingTrainer(true);
    try {
      const applicationToken = await server.generateToken({ workspace: server.config.workspace, permission: 'read_write', expires_in: 3600 * 24 * 30 });
      const ownerId = user?.id as string | undefined;
      await manager.service.create_trainer({ token: applicationToken, datasets: newTrainerDatasets, trainer_artifact_id: newTrainerArtifactId, owner_id: ownerId, _rkwargs: true });
      setShowCreateTrainer(false); setShowLaunchDialog(false); setCreatingFor(null); setNewTrainerDatasets([]); setIsCreatingTrainer(false);
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    } catch (error) {
      setErrorPopupMessage('Failed to Create Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
      setIsCreatingTrainer(false);
    }
  };

  const showConfirmDialog = (title: string, message: string, action: () => void, danger = false, confirmLabel?: string) => {
    setConfirmModalTitle(title);
    setConfirmModalMessage(message);
    setConfirmModalAction(() => action);
    setConfirmModalDanger(danger);
    setConfirmModalConfirmLabel(confirmLabel ?? (danger ? 'Delete' : 'Continue'));
    setShowConfirmModal(true);
  };

  const removeOrchestrator = async (managerId: string) => {
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;
    const orchestrator = orchestrators.find(o => o.managerId === managerId);
    if (!orchestrator) return;

    if (orchestrator.isBusy) {
      showConfirmDialog(
        'Delete Busy Orchestrator',
        'This orchestrator is currently running a training session.\n\nDeleting it will abort the session and may leave trainers in an inconsistent state. Are you sure?',
        async () => { await performRemoveOrchestrator(managerId, true); },
        true,
        'Delete'
      );
      return;
    }

    const orchestratorId = `${managerId}::${orchestrator.appId}`;
    const isSelected = orchestratorId === selectedOrchestrator;
    if (isSelected && trainingHistory && ((trainingHistory.training_losses?.length > 0) || (trainingHistory.validation_losses?.length > 0))) {
      showConfirmDialog(
        'Delete Orchestrator with History',
        'This orchestrator has training history that will be permanently lost. Continue?',
        async () => { await performRemoveOrchestrator(managerId, false); }
      );
      return;
    }
    if (orchestrator.status === 'RUNNING') {
      showConfirmDialog(
        'Delete Orchestrator',
        'Are you sure you want to delete this orchestrator? Training history will be lost.',
        async () => { await performRemoveOrchestrator(managerId, false); }
      );
      return;
    }
    await performRemoveOrchestrator(managerId, false);
  };

  const performRemoveOrchestrator = async (managerId: string, force: boolean) => {
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;
    const orchestrator = orchestrators.find(o => o.managerId === managerId);
    if (!orchestrator) return;
    setOrchestrators(prev => prev.map(o => o.managerId === managerId ? { ...o, status: 'DELETING' } : o));
    try {
      const callerId = user?.id as string | undefined;
      await manager.service.remove_orchestrator({ application_id: orchestrator.appId, force, caller_id: callerId, _rkwargs: true });
      await refreshWorkerInfo(managerId); scheduleWorkerRefresh(managerId);
    } catch (error) {
      setErrorPopupMessage('Failed to Remove Orchestrator');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
      await refreshWorkerInfo(managerId); scheduleWorkerRefresh(managerId);
    }
  };

  const performRemoveTrainer = async (managerId: string, appId: string, force: boolean) => {
    const trainerId = `${managerId}::${appId}`;
    const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
    if (trainer) {
      const trainerServiceId = trainer.serviceIds[0]?.websocket_service_id;
      if (registeredTrainers.includes(trainerServiceId)) { await unregisterTrainer(trainerId); }
    }
    const manager = managers.find(m => m.serviceId === managerId);
    if (!manager) return;
    setTrainers(prev => prev.map(t => t.managerId === managerId && t.appId === appId ? { ...t, status: 'DELETING' } : t));
    try {
      const callerId = user?.id as string | undefined;
      await manager.service.remove_trainer({ application_id: appId, force, caller_id: callerId, _rkwargs: true });
      await refreshWorkerInfo(managerId); scheduleWorkerRefresh(managerId);
    } catch (error) {
      setErrorPopupMessage('Failed to Remove Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
      await refreshWorkerInfo(managerId); scheduleWorkerRefresh(managerId);
    }
  };

  const removeTrainer = (managerId: string, appId: string) => {
    if (isTraining) {
      setErrorPopupMessage('Cannot Delete Trainer'); setErrorPopupDetails('Stop training first.'); setShowErrorPopup(true); return;
    }
    const trainer = trainers.find(t => t.managerId === managerId && t.appId === appId);
    if (trainer?.isBusy) {
      showConfirmDialog(
        'Delete Busy Trainer',
        'This trainer is currently in an active training session.\n\nDeleting it will interrupt the session. Are you sure?',
        async () => { await performRemoveTrainer(managerId, appId, true); },
        true,
        'Delete'
      );
      return;
    }
    showConfirmDialog(
      'Delete Trainer',
      'Are you sure you want to delete this trainer?',
      async () => { await performRemoveTrainer(managerId, appId, false); }
    );
  };

  const showInfo = async (type: 'manager' | 'orchestrator' | 'trainer', id: string) => {
    let manager: ManagerConnection | undefined;
    if (type === 'manager') { const serviceId = id.split('::')[1]; manager = managers.find(m => m.serviceId === serviceId); }
    else if (type === 'orchestrator') { const managerId = id.split('::')[0]; manager = managers.find(m => m.serviceId === managerId); }
    else if (type === 'trainer') {
      const parts = id.split('::');
      if (parts.length === 2) { manager = managers.find(m => m.serviceId === parts[0]); if (!manager) manager = managers.find(m => m.workspace === parts[0]); }
    }
    if (!manager) return;
    setInfoModalType(type); setInfoModalData(null); setIsInfoModalLoading(true); setShowInfoModal(true);
    try {
      let workerInfo = manager.workerInfo;
      if (!workerInfo) {
        const t = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000));
        workerInfo = await Promise.race([manager.service.get_worker_info(), t]);
      }
      if (!workerInfo) throw new Error('Could not retrieve worker information');
      if (type === 'manager') {
        const datasetsToShow = manager.datasetsInfo || workerInfo.datasets || {};
        setInfoModalData({ workspace: manager.workspace, clusterStatus: workerInfo.cluster_status || null, datasets: datasetsToShow, location: workerInfo.worker_info?.geo_location ? { region: workerInfo.worker_info.geo_location.region, country_name: workerInfo.worker_info.geo_location.country_name, country_code: workerInfo.worker_info.geo_location.country_code, latitude: workerInfo.worker_info.geo_location.latitude, longitude: workerInfo.worker_info.geo_location.longitude } : undefined });
      } else if (type === 'orchestrator') {
        const orchAppId = id.split('::')[1];
        const orchStatus = workerInfo.orchestrators_status?.[orchAppId];
        setInfoModalData({ status: orchStatus?.status, artifactId: (orchStatus as any)?.artifact_id });
      } else if (type === 'trainer') {
        const appId = id.split('::')[1];
        const trainerStatus = workerInfo.trainers_status?.[appId];
        setInfoModalData({ appId, status: trainerStatus?.status, datasets: trainerStatus?.datasets || {}, artifactId: trainerStatus?.artifact_id });
      }
      setIsInfoModalLoading(false);
    } catch (error) {
      setIsInfoModalLoading(false);
      setErrorPopupMessage('Failed to Get Information');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
      setShowInfoModal(false);
    }
  };

  const registerTrainer = async (trainerId: string) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
    if (!trainer || trainer.status !== 'RUNNING') return;
    try {
      setIsLoadingRegisteredTrainers(true);
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.add_trainer(trainer.serviceIds[0].websocket_service_id);
      const registeredServiceIds = await orchestratorService.list_trainers();
      setRegisteredTrainers(registeredServiceIds);
    } catch (error) {
      setErrorPopupMessage('Failed to Register Trainer');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
    } finally { setIsLoadingRegisteredTrainers(false); }
  };

  const unregisterTrainer = async (trainerId: string) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    const trainer = trainers.find(t => `${t.managerId}::${t.appId}` === trainerId);
    if (!trainer || trainer.status !== 'RUNNING') return;
    try {
      setIsLoadingRegisteredTrainers(true);
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.remove_trainer(trainer.serviceIds[0].websocket_service_id);
      const registeredServiceIds = await orchestratorService.list_trainers();
      setRegisteredTrainers(registeredServiceIds);
    } catch { /* silent */ } finally { setIsLoadingRegisteredTrainers(false); }
  };

  useEffect(() => {
    const fetchRegisteredTrainers = async () => {
      if (!selectedOrchestrator) { setRegisteredTrainers([]); return; }
      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') { setRegisteredTrainers([]); return; }
      try {
        setIsLoadingRegisteredTrainers(true);
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const registeredServiceIds = await orchestratorService.list_trainers();
        setRegisteredTrainers(registeredServiceIds);
      } catch { setRegisteredTrainers([]); } finally { setIsLoadingRegisteredTrainers(false); }
    };
    fetchRegisteredTrainers();
  }, [selectedOrchestrator, server]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fetchTrainerParams = async () => {
      if (!selectedOrchestrator) { setTrainerParams(null); setTrainerParamsLoading(false); setTrainerParamsError(null); return; }
      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') { setTrainerParams(null); setTrainerParamsError('Orchestrator not running'); return; }
      if (registeredTrainers.length === 0) { setTrainerParams(null); setTrainerParamsLoading(false); setTrainerParamsError(null); return; }
      try {
        setTrainerParamsLoading(true); setTrainerParamsError(null);
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const params = await orchestratorService.get_trainer_params();
        setTrainerParams(params);
      } catch (error) {
        setTrainerParamsError(error instanceof Error ? error.message : 'Failed to fetch parameters');
      } finally { setTrainerParamsLoading(false); }
    };
    fetchTrainerParams();
  }, [selectedOrchestrator, registeredTrainers, server]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fetchTrainingHistory = async () => {
      if (!selectedOrchestrator) { setTrainingHistory(null); return; }
      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
      if (!orchestrator || orchestrator.status !== 'RUNNING') return;
      try {
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const history = await orchestratorService.get_training_history();
        if (history) setTrainingHistory(history);
      } catch { /* no history yet */ }
    };
    fetchTrainingHistory();
  }, [selectedOrchestrator, server]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Poll the orchestrator that is actively training (not the currently viewed one)
    if (!trainingOrchestratorId || !isTraining) return;
    const fetchHistoryPeriodically = async () => {
      const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === trainingOrchestratorId);
      if (!orchestrator || orchestrator.status !== 'RUNNING') return;
      try {
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const history = await orchestratorService.get_training_history();
        if (history) setTrainingHistory(history);
        const status = await orchestratorService.get_training_status();
        if (status) setTrainingStatus(status);
      } catch { /* silent */ }
    };
    const historyInterval = setInterval(fetchHistoryPeriodically, 2000);
    return () => clearInterval(historyInterval);
  }, [isTraining, trainingOrchestratorId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startTraining = async (config: { num_rounds: number; fit_config: Record<string, any>; eval_config: Record<string, any>; per_round_timeout: number; initial_weights: { artifact_id: string; file_path: string } | null; }) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    setIsPreparingTraining(true);
    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const currentTrainers = await orchestratorService.list_trainers();
      if (currentTrainers.length === 0) throw new Error('No trainers available. Please select at least one trainer.');
      const launchedFrom = selectedOrchestrator!;
      setIsPreparingTraining(false); setIsTraining(true); setTrainingOrchestratorId(launchedFrom); setTrainingConfigCollapsed(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setSavedModelArtifactIds(null);
      setSavedGlobalArtifactId(null);
      const trainingParams: any = { num_rounds: config.num_rounds, fit_config: config.fit_config, eval_config: config.eval_config, per_round_timeout: config.per_round_timeout, _rkwargs: true };
      if (config.initial_weights) trainingParams.initial_weights = config.initial_weights;
      orchestratorService.start_training(trainingParams).catch((error: Error) => {
        setErrorPopupMessage('Training Failed'); setErrorPopupDetails(error.message); setShowErrorPopup(true);
        setIsTraining(false); setTrainingOrchestratorId(null);
      });
      const statusInterval = setInterval(async () => {
        try {
          const status = await orchestratorService.get_training_status();
          setTrainingStatus(status);
          if (!status.is_running) {
            setIsTraining(false); setTrainingOrchestratorId(null); clearInterval(statusInterval);
            const history = await orchestratorService.get_training_history();
            setTrainingHistory(history);
          }
        } catch { /* silent */ }
      }, 3000);
    } catch (error) {
      setErrorPopupMessage('Failed to Start Training');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true); setIsPreparingTraining(false); setIsTraining(false); setTrainingOrchestratorId(null);
    }
  };

  const stopTraining = async () => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    setIsStoppingTraining(true);
    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.stop_training();
      setIsTraining(false); setTrainingOrchestratorId(null); setTrainingStatus(null);
    } catch (error) {
      setErrorPopupMessage('Failed to Stop Training');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
    } finally { setIsStoppingTraining(false); }
  };

  const resetTrainingState = async () => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.reset_training_state();
      setTrainingHistory(null); setTrainingStatus(null);
      setResetStateSuccess(true);
      setTimeout(() => setResetStateSuccess(false), 2000);
    } catch (error) {
      setErrorPopupMessage('Failed to Reset Training State');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
    }
  };

  const saveModelWeights = async () => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    setIsSavingModel(true);
    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const artifactIds = await orchestratorService.save_model_weights({
        client_ids: 'all',
        description: saveModelDescription.trim() || undefined,
        _rkwargs: true,
      });
      setSavedModelArtifactIds(artifactIds);
    } catch (error) {
      setErrorPopupMessage('Failed to Save Model Weights');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
    } finally {
      setIsSavingModel(false);
    }
  };

  const saveGlobalWeights = async () => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    setIsSavingGlobal(true);
    try {
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const artifactId = await orchestratorService.save_global_weights({
        description: saveModelDescription.trim() || undefined,
        _rkwargs: true,
      });
      setSavedGlobalArtifactId(artifactId);
    } catch (error) {
      setErrorPopupMessage('Failed to Save Global Weights');
      setErrorPopupDetails(error instanceof Error ? error.message : 'Unknown error');
      setShowErrorPopup(true);
    } finally {
      setIsSavingGlobal(false);
    }
  };

  const handleOrchestratorSelectionChange = (newOrchestratorId: string) => {
    setSelectedOrchestrator(newOrchestratorId);
  };

  const handleOrchestratorDeselect = () => {
    // Purely local UI change — does not unregister trainers or stop any running training
    setSelectedOrchestrator(null);
  };

  const hasDatasetAccess = (dataset: any) => {
    if (!dataset.authorized_users) return true;
    if (dataset.authorized_users.includes('*')) return true;
    const userId = server?.config?.user?.id;
    const userEmail = server?.config?.user?.email;
    return dataset.authorized_users.includes(userId) || dataset.authorized_users.includes(userEmail);
  };

  const getTrainerAppId = (serviceId: string): string => {
    const trainer = trainers.find(t => t.serviceIds && t.serviceIds[0] && t.serviceIds[0].websocket_service_id === serviceId);
    return trainer ? trainer.appId : serviceId;
  };

  const getStatusBadge = (status?: string) => {
    const displayStatus = status || 'NOT_STARTED';
    const statusConfig: Record<string, { color: string; dot: string }> = {
      'NOT_STARTED': { color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
      'DEPLOYING': { color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500 animate-pulse' },
      'DEPLOY_FAILED': { color: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
      'RUNNING': { color: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
      'UNHEALTHY': { color: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
      'DELETING': { color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500 animate-pulse' },
    };
    const cfg = statusConfig[displayStatus] || statusConfig['NOT_STARTED'];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        {displayStatus}
      </span>
    );
  };

  const BusyBadge = () => (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 ml-1" title="Currently in an active training session">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      In Training
    </span>
  );

  // Compute map workers from discovered + connected state
  const mapWorkers = useMemo<MapWorker[]>(() => {
    const appRole = (managerId: string): MapWorker['role'] => {
      const hasOrch = orchestrators.some(o => o.managerId === managerId);
      const hasTrainer = trainers.some(t => t.managerId === managerId);
      return hasOrch && hasTrainer ? 'both' : hasOrch ? 'orchestrator' : hasTrainer ? 'trainer' : 'connected';
    };

    if (currentStep === 3) {
      // Train stage: only workers involved in the selected session
      const selectedOrchObj = selectedOrchestrator
        ? orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator)
        : null;
      const selectedManagerIds = new Set<string>();
      if (selectedOrchObj) selectedManagerIds.add(selectedOrchObj.managerId);
      trainers.forEach(t => {
        const svcId = t.serviceIds?.[0]?.websocket_service_id;
        if (svcId && registeredTrainers.includes(svcId)) selectedManagerIds.add(t.managerId);
      });
      return managers
        .filter(m => selectedManagerIds.has(m.serviceId))
        .flatMap(manager => {
          const geo = manager.workerInfo?.worker_info?.geo_location;
          if (!geo?.latitude || !geo?.longitude) return [];
          const orchCount = orchestrators.filter(o => o.managerId === manager.serviceId).length;
          const trainerCount = trainers.filter(t => t.managerId === manager.serviceId).length;
          const datasetCount = manager.workerInfo?.datasets ? Object.keys(manager.workerInfo.datasets).length : 0;
          return [{ id: manager.serviceId, name: manager.workerInfo?.worker_info ? `${geo.region}, ${geo.country_name}` : manager.workspace, lat: geo.latitude, lng: geo.longitude, role: appRole(manager.serviceId), label: `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}, ${orchCount} orchestrator${orchCount !== 1 ? 's' : ''}, ${trainerCount} trainer${trainerCount !== 1 ? 's' : ''}` }];
        });
    }

    if (currentStep === 2) {
      // Select Apps stage: all connected workers, colored by available apps
      return managers.flatMap(manager => {
        const geo = manager.workerInfo?.worker_info?.geo_location;
        if (!geo?.latitude || !geo?.longitude) return [];
        const orchCount = orchestrators.filter(o => o.managerId === manager.serviceId).length;
        const trainerCount = trainers.filter(t => t.managerId === manager.serviceId).length;
        const datasetCount = manager.workerInfo?.datasets ? Object.keys(manager.workerInfo.datasets).length : 0;
        return [{ id: manager.serviceId, name: manager.workerInfo?.worker_info ? `${geo.region}, ${geo.country_name}` : manager.workspace, lat: geo.latitude, lng: geo.longitude, role: appRole(manager.serviceId), label: `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}, ${orchCount} orchestrator${orchCount !== 1 ? 's' : ''}, ${trainerCount} trainer${trainerCount !== 1 ? 's' : ''}` }];
      });
    }

    // Setup stage (step 1): connected + available discovered workers
    const result: MapWorker[] = [];
    managers.forEach(manager => {
      const geo = manager.workerInfo?.worker_info?.geo_location;
      if (!geo?.latitude || !geo?.longitude) return;
      const orchCount = orchestrators.filter(o => o.managerId === manager.serviceId).length;
      const trainerCount = trainers.filter(t => t.managerId === manager.serviceId).length;
      const datasetCount = manager.workerInfo?.datasets ? Object.keys(manager.workerInfo.datasets).length : 0;
      result.push({ id: manager.serviceId, name: manager.workerInfo?.worker_info ? `${geo.region}, ${geo.country_name}` : manager.workspace, lat: geo.latitude, lng: geo.longitude, role: 'connected', label: `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}, ${orchCount} orchestrator${orchCount !== 1 ? 's' : ''}, ${trainerCount} trainer${trainerCount !== 1 ? 's' : ''}` });
    });
    observedWorkspaces.forEach(ws => {
      (discoveredWorkers[ws] || []).forEach(worker => {
        if (managers.find(m => m.serviceId === worker.serviceId)) return;
        if (!worker.geo_location?.latitude || !worker.geo_location?.longitude) return;
        result.push({ id: worker.serviceId, name: worker.name, lat: worker.geo_location.latitude, lng: worker.geo_location.longitude, role: 'available', label: '' });
      });
    });
    return result;
  }, [currentStep, managers, orchestrators, trainers, registeredTrainers, selectedOrchestrator, discoveredWorkers, observedWorkspaces]);

  // Annotate mapWorkers with active flag (depends on trainingStatus, kept separate)
  const mapWorkersWithActive = useMemo<MapWorker[]>(() => {
    if (!isTraining || !trainingStatus?.stage) return mapWorkers;
    const orchObj = selectedOrchestrator
      ? orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator)
      : null;
    const orchManagerId = orchObj?.managerId;
    const stage = trainingStatus.stage;
    const activeIds = new Set<string>();
    if (stage === 'aggregation' || stage === 'distribution') {
      if (orchManagerId) activeIds.add(orchManagerId);
    } else {
      if (orchManagerId) activeIds.add(orchManagerId);
      trainers
        .filter(t => { const s = t.serviceIds?.[0]?.websocket_service_id; return s && registeredTrainers.includes(s); })
        .forEach(t => activeIds.add(t.managerId));
    }
    return mapWorkers.map(w => activeIds.has(w.id) ? { ...w, active: true } : w);
  }, [mapWorkers, isTraining, trainingStatus, selectedOrchestrator, orchestrators, trainers, registeredTrainers]);

  // Connection lines: orchestrator ↔ each registered trainer (step 3 only)
  const mapConnections = useMemo<MapConnection[]>(() => {
    if (currentStep !== 3 || !selectedOrchestrator) return [];
    const orchObj = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchObj) return [];
    const orchManagerId = orchObj.managerId;
    return trainers
      .filter(t => {
        const svcId = t.serviceIds?.[0]?.websocket_service_id;
        return svcId && registeredTrainers.includes(svcId);
      })
      .filter(t => t.managerId !== orchManagerId) // skip same-worker deployments
      .map(t => ({ from: orchManagerId, to: t.managerId }));
  }, [currentStep, selectedOrchestrator, orchestrators, trainers, registeredTrainers]);

  // All discovered workers (flat list with workspace context)
  const allDiscoveredWorkers = useMemo(() => {
    return observedWorkspaces
      .flatMap(ws => (discoveredWorkers[ws] || []).map(w => ({ ...w, workspace: ws })))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [observedWorkspaces, discoveredWorkers]);

  const stepEnabled = (step: number) => {
    if (step === 1) return true;
    if (step === 2) return managers.length > 0;
    if (step === 3) return !!selectedOrchestrator;
    return false;
  };

  // True only when training is running for the currently viewed orchestrator
  const isActivelyTraining = isTraining && selectedOrchestrator === trainingOrchestratorId;

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-1">Federated Training</h1>
        <p className="text-gray-500 text-sm">Coordinate privacy-preserving training across distributed BioEngine workers</p>
      </div>

      {/* Step Navigator */}
      <div className="flex items-center mb-8">
        {[
          { num: 1, label: 'Setup Workers', desc: 'Connect workers & launch apps' },
          { num: 2, label: 'Select Apps', desc: 'Choose orchestrator & trainers' },
          { num: 3, label: 'Train', desc: 'Configure & run training' },
        ].map((step, idx) => {
          const enabled = stepEnabled(step.num);
          const active = currentStep === step.num;
          const done = currentStep > step.num;
          return (
            <React.Fragment key={step.num}>
              <button
                onClick={() => enabled && setCurrentStep(step.num as 1 | 2 | 3)}
                disabled={!enabled}
                className={`flex items-center gap-3 group transition-all duration-200 ${!enabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-200 flex-shrink-0 ${
                  active ? 'bg-blue-600 text-white shadow-md shadow-blue-200 ring-4 ring-blue-100'
                  : done ? 'bg-emerald-500 text-white'
                  : 'bg-gray-100 text-gray-500 group-hover:bg-gray-200'
                }`}>
                  {done ? <FaCheckCircle size={14} /> : step.num}
                </div>
                <div className="text-left hidden sm:block">
                  <p className={`text-sm font-semibold leading-tight ${active ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-gray-600'}`}>{step.label}</p>
                  <p className="text-xs text-gray-400 leading-tight">{step.desc}</p>
                </div>
              </button>
              {idx < 2 && (
                <div className={`flex-1 h-0.5 mx-4 transition-all duration-300 ${done ? 'bg-emerald-400' : 'bg-gray-200'}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Main content: map left + step content right */}
      <div className="flex gap-6 items-start">
        {/* Left: World Map */}
        <div className="w-72 xl:w-[346px] flex-shrink-0 space-y-4 sticky top-6">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 pt-4 pb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">Federation Map</span>
              <span className="ml-auto text-xs text-gray-400">{mapWorkers.length} worker{mapWorkers.length !== 1 ? 's' : ''}</span>
            </div>
            <FederatedWorldMap workers={mapWorkersWithActive} connections={mapConnections} style={{ height: 260, width: '100%' }} />
            <div className="px-4 py-3 border-t border-gray-50">
              <MapLegend mode={currentStep >= 2 ? 'select' : 'setup'} />
            </div>
          </div>

          {/* Workspace input (all steps) */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Observed Workspaces</h3>
            <form onSubmit={e => { e.preventDefault(); addObservedWorkspace(); }} className="flex gap-2 mb-3">
              <input type="text" value={workspaceInput} onChange={e => setWorkspaceInput(e.target.value)} placeholder="Add workspace..." className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0" />
              <button type="submit" disabled={!workspaceInput.trim() || observedWorkspaces.includes(workspaceInput.trim())} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0">Add</button>
            </form>
            <div className="flex flex-col gap-1.5">
              {observedWorkspaces.map(ws => {
                const isDefault = defaultWorkspaces.includes(ws);
                const status = wsDiscoveryStatus[ws];
                const count = (discoveredWorkers[ws] || []).length;
                return (
                  <div key={ws} className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50 rounded-lg text-xs">
                    {status === 'loading' && <div className="w-2 h-2 border border-gray-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
                    {status === 'loaded' && <div className={`w-2 h-2 rounded-full flex-shrink-0 ${count > 0 ? 'bg-emerald-500' : 'bg-gray-300'}`} />}
                    {status === 'error' && <div className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />}
                    {!status && <div className="w-2 h-2 rounded-full bg-gray-300 flex-shrink-0" />}
                    <span className="font-mono text-gray-700 flex-1 truncate">{ws}</span>
                    {status === 'loaded' && <span className="text-gray-400">{count}w</span>}
                    {!isDefault && (
                      <button onClick={() => removeObservedWorkspace(ws)} className="text-gray-300 hover:text-red-400 flex-shrink-0">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={() => observedWorkspaces.forEach(ws => discoverWorkspace(ws))} className="mt-3 w-full text-xs text-blue-600 hover:text-blue-800 py-1 flex items-center justify-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Right: Step content */}
        <div className="flex-1 min-w-0">

          {/* ====== STEP 1: SETUP WORKERS ====== */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">BioEngine Workers</h2>
                    <p className="text-xs text-gray-500 mt-0.5">Workers with Chiron Manager across observed workspaces</p>
                  </div>
                  {Object.values(wsDiscoveryStatus).some(s => s === 'loading') && (
                    <BiLoaderAlt className="animate-spin text-blue-500" size={18} />
                  )}
                </div>

                {!server ? (
                  <div className="flex justify-center items-center h-40">
                    <div className="text-center">
                      <div className="w-16 h-16 bg-gradient-to-r from-blue-100 to-purple-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </div>
                      <p className="text-gray-600 font-medium mb-1">Not connected</p>
                      <p className="text-gray-500 text-sm">Please log in to view BioEngine instances</p>
                    </div>
                  </div>
                ) : allDiscoveredWorkers.length === 0 && !Object.values(wsDiscoveryStatus).some(s => s === 'loading') ? (
                  <div className="text-center py-12 text-gray-400">
                    <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                    <p className="text-sm">No workers with Chiron Manager found</p>
                    <p className="text-xs mt-1">Add workspaces on the left to discover workers</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50/70 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          <th className="text-left px-6 py-3">Worker</th>
                          <th className="text-left px-4 py-3">Location</th>
                          <th className="text-left px-4 py-3">Datasets</th>
                          <th className="text-center px-4 py-3">Orchestrator</th>
                          <th className="text-center px-4 py-3">Trainers</th>
                          <th className="text-right px-6 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {allDiscoveredWorkers.map(worker => {
                          const isConnected = managers.some(m => m.serviceId === worker.serviceId);
                          const manager = managers.find(m => m.serviceId === worker.serviceId);
                          const isConnecting = connectingServiceId === worker.serviceId;
                          const orchCount = orchestrators.filter(o => o.managerId === worker.serviceId).length;
                          const trainerCount = trainers.filter(t => t.managerId === worker.serviceId).length;
                          const geo = isConnected ? manager?.workerInfo?.worker_info?.geo_location : worker.geo_location;
                          const datasetCount = isConnected ? (manager?.workerInfo?.datasets ? Object.keys(manager.workerInfo.datasets).length : 0) : worker.datasetCount;
                          const datasetEntries = isConnected && manager?.workerInfo?.datasets ? Object.entries(manager.workerInfo.datasets) : [];

                          return (
                            <tr key={worker.serviceId} className={`hover:bg-gray-50/50 transition-colors ${isConnected ? '' : 'opacity-80'}`}>
                              <td className="px-6 py-3.5">
                                <div className="flex items-center gap-2.5">
                                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isConnected ? (manager?.isConnected ? 'bg-emerald-500' : 'bg-red-400') : 'bg-gray-300'}`} />
                                  <div>
                                    <p className="font-medium text-gray-900 leading-tight">{worker.name}</p>
                                    <p className="text-xs text-gray-400 font-mono">{worker.workspace}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3.5">
                                {geo ? (
                                  <div className="flex items-center gap-1.5">
                                    <CountryFlag countryName={geo.country_name} countryCode={geo.country_code} className="w-4 h-3 object-cover rounded-sm flex-shrink-0" />
                                    <span className="text-gray-600 text-xs">{geo.region}, {geo.country_name}</span>
                                  </div>
                                ) : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              <td className="px-4 py-3.5">
                                {isConnected ? (
                                  datasetEntries.length > 0 ? (
                                    <div className="flex flex-col gap-0.5">
                                      {datasetEntries.map(([dsId, ds]: [string, any]) => (
                                        <span key={dsId} className="text-xs text-gray-600 leading-tight">{ds.name || dsId}</span>
                                      ))}
                                    </div>
                                  ) : <span className="text-gray-300 text-xs">None</span>
                                ) : datasetCount !== undefined ? (
                                  <span className="text-xs text-gray-400">{datasetCount} dataset{datasetCount !== 1 ? 's' : ''}</span>
                                ) : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              <td className="px-4 py-3.5 text-center">
                                {isConnected ? (
                                  orchCount > 0 ? (
                                    <div className="flex flex-col gap-1 items-center">
                                      {orchestrators.filter(o => o.managerId === worker.serviceId).map(o => (
                                        <div key={o.appId} className="flex items-center gap-1 flex-wrap justify-center">
                                          {getStatusBadge(o.status)}
                                          {o.isBusy && <BusyBadge />}
                                          <button onClick={() => removeOrchestrator(worker.serviceId)} className="text-red-400 hover:text-red-600 ml-0.5" title="Remove"><FaTrash size={10} /></button>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <span className="text-gray-300 text-xs">None</span>
                                ) : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              <td className="px-4 py-3.5 text-center">
                                {isConnected ? (
                                  trainerCount > 0 ? (
                                    <div className="flex flex-col gap-1 items-center">
                                      {trainers.filter(t => t.managerId === worker.serviceId).map(t => (
                                        <div key={t.appId} className="flex items-center gap-1 flex-wrap justify-center">
                                          {getStatusBadge(t.status)}
                                          {t.isBusy && <BusyBadge />}
                                          <button onClick={() => removeTrainer(worker.serviceId, t.appId)} className="text-red-400 hover:text-red-600 ml-0.5" title="Remove"><FaTrash size={10} /></button>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <span className="text-gray-300 text-xs">None</span>
                                ) : <span className="text-gray-300 text-xs">—</span>}
                              </td>
                              <td className="px-6 py-3.5 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {isConnected ? (
                                    <>
                                      <button
                                        onClick={() => { setLaunchDialogManagerId(worker.serviceId); setLaunchDialogTab('orchestrator'); setNewTrainerDatasets([]); setShowLaunchDialog(true); }}
                                        disabled={!manager?.isConnected}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        title="Launch app on this worker"
                                      >
                                        <FaPlus size={9} /> Launch
                                      </button>
                                      <button onClick={() => showInfo('manager', `${manager?.workspace}::${worker.serviceId}`)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Info"><FaInfo size={12} /></button>
                                      <button onClick={() => removeManager(worker.serviceId)} className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors" title="Disconnect"><FaUnlink size={12} /></button>
                                    </>
                                  ) : (
                                    <button
                                      onClick={() => connectWorker(worker.serviceId, worker.workspace)}
                                      disabled={isConnecting}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-xs font-medium rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    >
                                      {isConnecting ? <><BiLoaderAlt className="animate-spin" size={12} /> Connecting...</> : <><FaPlus size={9} /> Connect</>}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {managers.length > 0 && (
                <div className="flex justify-end">
                  <button onClick={() => setCurrentStep(2)} className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 shadow-sm shadow-blue-200 transition-all">
                    Next: Select Applications
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ====== STEP 2: SELECT APPS ====== */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Orchestrator selection */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-50">
                    <h2 className="text-base font-semibold text-gray-900">Orchestrator</h2>
                    <p className="text-xs text-gray-500 mt-0.5">Select one orchestrator to coordinate training</p>
                  </div>
                  <div className="p-4 space-y-2">
                    {orchestrators.filter(o => o.status === 'RUNNING').length === 0 ? (
                      <div className="text-center py-8 text-gray-400">
                        <FaClock className="mx-auto mb-2 opacity-40" size={24} />
                        <p className="text-sm">No running orchestrators</p>
                        <p className="text-xs mt-1">Launch one from the Setup step</p>
                      </div>
                    ) : (
                      orchestrators.filter(o => o.status === 'RUNNING').map(orch => {
                        const orchestratorId = `${orch.managerId}::${orch.appId}`;
                        const isSelected = selectedOrchestrator === orchestratorId;
                        const isBusyElsewhere = orch.isBusy && !isSelected;
                        // Only block selection while async prepare is in flight; never block on isTraining
                        const isDisabled = isPreparingTraining || isBusyElsewhere;
                        const manager = managers.find(m => m.serviceId === orch.managerId);
                        const geo = manager?.workerInfo?.worker_info?.geo_location;
                        const isRunningHere = isTraining && trainingOrchestratorId === orchestratorId;
                        return (
                          <label key={orchestratorId} className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-all ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${isSelected ? 'border-blue-500 bg-blue-50/60' : isBusyElsewhere ? 'border-amber-200 bg-amber-50/40' : 'border-transparent bg-gray-50 hover:border-gray-200'}`}>
                            <input
                              type="radio" name="orchestrator" checked={isSelected}
                              onChange={() => handleOrchestratorSelectionChange(orchestratorId)}
                              onClick={() => { if (isSelected && !isDisabled) handleOrchestratorDeselect(); }}
                              disabled={isDisabled} className="mt-0.5 accent-blue-600"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p className="font-medium text-gray-900 text-sm leading-tight">{orch.displayName || 'Chiron Orchestrator'}</p>
                                {orch.isBusy && <BusyBadge />}
                              </div>
                              {geo && <p className="text-xs text-gray-500 mt-0.5">{geo.region}, {geo.country_name}</p>}
                              <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{orch.managerId.split('/')[1]?.split(':')[0] || orch.managerId}</p>
                              {isBusyElsewhere && <p className="text-xs text-amber-600 mt-0.5">Currently running a training session</p>}
                              {isRunningHere && <p className="text-xs text-blue-600 mt-0.5">Training in progress</p>}
                            </div>
                            {isSelected ? (
                              <button
                                type="button"
                                onClick={e => { e.preventDefault(); if (!isDisabled) handleOrchestratorDeselect(); }}
                                className="text-blue-400 hover:text-blue-600 flex-shrink-0 mt-0.5 p-0.5"
                                title="Deselect orchestrator"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            ) : null}
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Trainer selection */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-gray-900">Trainers</h2>
                      <p className="text-xs text-gray-500 mt-0.5">Select one or more trainers</p>
                    </div>
                    {isLoadingRegisteredTrainers && <BiLoaderAlt className="animate-spin text-blue-500" size={16} />}
                  </div>
                  <div className="p-4 space-y-2">
                    {!selectedOrchestrator && (
                      <div className="text-center py-8 text-amber-500">
                        <svg className="w-8 h-8 mx-auto mb-2 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <p className="text-sm font-medium">Select an orchestrator first</p>
                      </div>
                    )}
                    {selectedOrchestrator && trainers.filter(t => t.status === 'RUNNING').length === 0 && (
                      <div className="text-center py-8 text-gray-400">
                        <FaClock className="mx-auto mb-2 opacity-40" size={24} />
                        <p className="text-sm">No running trainers</p>
                        <p className="text-xs mt-1">Launch trainers from the Setup step</p>
                      </div>
                    )}
                    {selectedOrchestrator && trainers.filter(t => t.status === 'RUNNING').map(trainer => {
                      const trainerId = `${trainer.managerId}::${trainer.appId}`;
                      const trainerServiceId = trainer.serviceIds[0]?.websocket_service_id;
                      const isRegistered = registeredTrainers.includes(trainerServiceId);
                      // Busy in another session = busy but not already registered here
                      const isBusyElsewhere = trainer.isBusy && !isRegistered;
                      const isDisabled = !selectedOrchestrator || isLoadingRegisteredTrainers || isBusyElsewhere;
                      const manager = managers.find(m => m.serviceId === trainer.managerId);
                      const geo = manager?.workerInfo?.worker_info?.geo_location;
                      const datasetNames = Object.values(trainer.datasets).map((d: any) => d.name || Object.keys(trainer.datasets).find(k => trainer.datasets[k] === d)).filter(Boolean);
                      return (
                        <label key={trainerId} className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-all ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${isRegistered ? 'border-emerald-400 bg-emerald-50/60' : isBusyElsewhere ? 'border-amber-200 bg-amber-50/40' : 'border-transparent bg-gray-50 hover:border-gray-200'}`}>
                          <input type="checkbox" checked={isRegistered} disabled={isDisabled} onChange={async e => { e.target.checked ? await registerTrainer(trainerId) : await unregisterTrainer(trainerId); }} className="mt-0.5 accent-emerald-600" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="font-medium text-gray-900 text-sm leading-tight">{trainer.displayName || 'Tabula Trainer'}</p>
                              {trainer.isBusy && <BusyBadge />}
                            </div>
                            {geo && <p className="text-xs text-gray-500 mt-0.5">{geo.region}, {geo.country_name}</p>}
                            {datasetNames.length > 0 && <p className="text-xs text-gray-400 mt-0.5 truncate">{datasetNames.join(', ')}</p>}
                            {isBusyElsewhere && <p className="text-xs text-amber-600 mt-0.5">In an active training session</p>}
                          </div>
                          {isRegistered && <FaCheckCircle className="text-emerald-500 flex-shrink-0 mt-0.5" size={14} />}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Summary */}
              {selectedOrchestrator && registeredTrainers.length > 0 && (
                <div className="bg-blue-50 border border-blue-100 rounded-2xl px-5 py-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FaCheckCircle className="text-blue-500" size={16} />
                    <span className="text-sm text-blue-800 font-medium">
                      {registeredTrainers.length} trainer{registeredTrainers.length !== 1 ? 's' : ''} registered to orchestrator
                    </span>
                  </div>
                  <button onClick={() => setCurrentStep(3)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-all">
                    Next: Train
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </button>
                </div>
              )}

              <div className="flex justify-between">
                <button onClick={() => setCurrentStep(1)} className="flex items-center gap-2 px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  Back to Setup
                </button>
              </div>
            </div>
          )}

          {/* ====== STEP 3: TRAIN ====== */}
          {currentStep === 3 && (
            <div className="space-y-4">
              {/* Config + Controls */}
              <div className={`rounded-2xl border shadow-sm transition-colors ${isActivelyTraining ? 'bg-blue-50 border-blue-200' : 'bg-white border-emerald-200'}`}>
                {/* Header — always visible, acts as the primary CTA */}
                <button
                  onClick={() => setTrainingConfigCollapsed(c => !c)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left group"
                >
                  <div className="flex items-center gap-3">
                    {isActivelyTraining ? (
                      <div className="w-7 h-7 bg-blue-500 rounded-lg flex items-center justify-center flex-shrink-0">
                        <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                      </div>
                    ) : (
                      <div className="w-7 h-7 bg-emerald-500 rounded-lg flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                      </div>
                    )}
                    <div>
                      <p className={`font-semibold text-sm leading-tight ${isActivelyTraining ? 'text-blue-900' : 'text-gray-900'}`}>
                        {isActivelyTraining ? 'Training Running' : 'Start Training'}
                      </p>
                      <p className="text-xs text-gray-400 leading-tight mt-0.5">
                        {trainingConfigSummary.numRounds} round{trainingConfigSummary.numRounds !== 1 ? 's' : ''} · {trainingConfigSummary.perRoundTimeoutMinutes} min timeout
                      </p>
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-gray-400 transition-transform duration-200 flex-shrink-0 ${trainingConfigCollapsed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded body */}
                {!trainingConfigCollapsed && (
                  <div className="px-5 pb-5 border-t border-gray-100">
                    <div className="pt-4">
                      <TrainingConfigPanel
                        params={trainerParams}
                        loading={trainerParamsLoading}
                        error={trainerParamsError}
                        artifactManager={artifactManager}
                        onStart={startTraining}
                        isPreparingTraining={isPreparingTraining}
                        isTraining={isActivelyTraining}
                        onConfigChange={(numRounds, perRoundTimeoutMinutes) => setTrainingConfigSummary({ numRounds, perRoundTimeoutMinutes })}
                      />
                    </div>
                  </div>
                )}

                {/* Always-visible action strip */}
                <div className={`px-5 py-3 flex items-center gap-3 ${trainingConfigCollapsed ? '' : 'border-t border-gray-100'}`}>
                  {isActivelyTraining && (
                    <button onClick={stopTraining} disabled={isStoppingTraining} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                      {isStoppingTraining ? <><BiLoaderAlt className="animate-spin" size={14} /> Stopping...</> : <><FaStop size={12} /> Stop Training</>}
                    </button>
                  )}
                  <button
                    onClick={() => showConfirmDialog(
                      'Clear Training History',
                      'This will permanently delete all training history (losses, round data) stored in the orchestrator. You will need to start a new training run from scratch.\n\nAre you sure?',
                      resetTrainingState,
                      true
                    )}
                    disabled={isActivelyTraining || !(trainingHistory && ((trainingHistory.training_losses?.length ?? 0) > 0 || (trainingHistory.validation_losses?.length ?? 0) > 0))}
                    title="Clear the training history stored in the orchestrator so you can start a fresh training run"
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border rounded-xl transition-all ${resetStateSuccess ? 'text-emerald-700 border-emerald-300 bg-emerald-50' : 'text-gray-600 border-gray-200 hover:bg-gray-50'} disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    {resetStateSuccess ? <><FaCheckCircle size={12} /> History Cleared</> : <><FaTrash size={12} /> Clear Training History</>}
                  </button>
                </div>
              </div>

              {/* Training Status */}
              {isActivelyTraining && trainingStatus && (
                <div className="bg-white rounded-2xl border border-blue-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-pulse" />
                      <h3 className="font-semibold text-gray-900 text-sm">Training in Progress</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-blue-700 uppercase tracking-wide bg-blue-100 px-2 py-0.5 rounded-full">{trainingStatus.stage ? STAGE_LABELS[trainingStatus.stage] : 'Idle'}</span>
                      {(() => {
                        const r = trainingStatus.current_training_round;
                        const total = trainingStatus.target_round;
                        // completed = rounds where both fit and evaluate are done
                        // fit started → r-1 completed; evaluate started → r-1 completed; between rounds (stage null, still running) → r completed
                        const completed = trainingStatus.stage === null && trainingStatus.is_running
                          ? r
                          : Math.max(0, r - 1);
                        return <span className="text-xs text-gray-500">Round {completed} / {total}</span>;
                      })()}
                    </div>
                  </div>
                  {/* Overall round progress */}
                  <div className="mb-4">
                    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                      {(() => {
                        const r = trainingStatus.current_training_round;
                        const total = Math.max(trainingStatus.target_round, 1);
                        // Each round contributes 0.5 per phase (fit=0.5, evaluate=0.5)
                        const phaseOffset = trainingStatus.stage === 'fit' ? 0 : trainingStatus.stage === 'evaluate' ? 0.5 : 1;
                        const pct = ((r - 1 + phaseOffset) / total) * 100;
                        return <div className="bg-blue-500 h-2 rounded-full transition-all duration-500" style={{ width: `${Math.max(0, pct)}%` }} />;
                      })()}
                    </div>
                  </div>
                  <div className="space-y-3">
                    {Object.entries(trainingStatus.trainers_progress).map(([trainerId, progress]) => {
                      const hasError = !!progress.error;
                      return (
                        <div key={trainerId}>
                          <div className="flex justify-between text-xs mb-1">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-600 font-medium">{getTrainerAppId(trainerId)}</span>
                              {hasError && <button onClick={() => { setErrorDetailTrainerId(getTrainerAppId(trainerId)); setErrorDetailMessage(progress.error || ''); setShowErrorDetailModal(true); }} className="text-red-500 hover:text-red-700"><FaTimesCircle size={12} /></button>}
                            </div>
                            <span className="text-gray-400">{progress.current_batch}/{progress.total_batches} batches</span>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                            <div className={`h-1.5 rounded-full transition-all duration-300 ${hasError ? 'bg-red-500' : trainingStatus.stage === 'fit' ? 'bg-blue-500' : trainingStatus.stage === 'aggregation' || trainingStatus.stage === 'distribution' ? 'bg-violet-400' : 'bg-emerald-500'}`} style={{ width: `${progress.progress * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Loss Charts */}
              {trainingHistory && ((trainingHistory.training_losses?.length > 0) || (trainingHistory.validation_losses?.length > 0)) && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="font-semibold text-gray-900 mb-4 text-sm">Training History</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {trainingHistory.training_losses?.length > 0 && (
                      <LossChart
                        title="Training Loss"
                        data={trainingHistory.training_losses}
                        color="#2563eb"
                        fill="#dbeafe"
                        clientData={trainingHistory.client_training_losses}
                      />
                    )}
                    {trainingHistory.validation_losses?.length > 0 && (
                      <LossChart
                        title="Validation Loss"
                        data={trainingHistory.validation_losses}
                        color="#10b981"
                        fill="#d1fae5"
                        clientData={trainingHistory.client_validation_losses}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Save Model Weights — shown when there is training history and not actively training on this orchestrator */}
              {!isActivelyTraining && trainingHistory && ((trainingHistory.training_losses?.length ?? 0) > 0 || (trainingHistory.validation_losses?.length ?? 0) > 0) && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-7 h-7 bg-violet-500 rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                    </div>
                    <div>
                      <p className="font-semibold text-sm text-gray-900">Save Model Weights</p>
                      <p className="text-xs text-gray-400 mt-0.5">Publish the trained weights from all clients to the artifact hub.</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Description <span className="text-gray-400 font-normal">(optional)</span></label>
                      <input
                        type="text"
                        value={saveModelDescription}
                        onChange={e => setSaveModelDescription(e.target.value)}
                        placeholder="e.g. Round 10 checkpoint — liver + kidney datasets"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={saveGlobalWeights}
                        disabled={isSavingGlobal || isSavingModel}
                        title="Save aggregated transformer weights from the orchestrator — portable across clients"
                        className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        {isSavingGlobal ? (
                          <><div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" /> Saving...</>
                        ) : (
                          <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg> Save Global Transformer</>
                        )}
                      </button>
                      <button
                        onClick={saveModelWeights}
                        disabled={isSavingModel || isSavingGlobal}
                        title="Save full model checkpoint (transformer + embedder) for each client — client-specific"
                        className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-xl hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all border border-gray-200"
                      >
                        {isSavingModel ? (
                          <><div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-gray-500" /> Saving...</>
                        ) : (
                          <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg> Save All Clients</>
                        )}
                      </button>
                    </div>
                    {savedGlobalArtifactId && (
                      <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                        <p className="text-xs font-semibold text-emerald-800 mb-0.5">Global transformer saved</p>
                        <p className="text-xs text-emerald-700 font-mono">{savedGlobalArtifactId}</p>
                      </div>
                    )}
                    {savedModelArtifactIds && (
                      <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 space-y-1">
                        <p className="text-xs font-semibold text-emerald-800 mb-1">Client checkpoints saved</p>
                        {Object.entries(savedModelArtifactIds).map(([cid, id]) => (
                          <p key={cid} className="text-xs text-emerald-700 font-mono">{cid}: {id}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-start">
                <button onClick={() => setCurrentStep(2)} className="flex items-center gap-2 px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  Back to Selection
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ====== LAUNCH APP DIALOG ====== */}
      {showLaunchDialog && launchDialogManagerId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">Launch Application</h3>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{launchDialogManagerId.split('/')[1]?.split(':')[0] || launchDialogManagerId}</p>
              </div>
              <button onClick={() => { setShowLaunchDialog(false); setLaunchDialogManagerId(null); setNewTrainerDatasets([]); }} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Tabs */}
            <div className="flex border-b border-gray-100">
              {(['orchestrator', 'trainer'] as const).map(tab => (
                <button key={tab} onClick={() => setLaunchDialogTab(tab)} className={`flex-1 py-3 text-sm font-medium transition-colors capitalize ${launchDialogTab === tab ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>
                  {tab === 'orchestrator' ? '🎭 Orchestrator' : '🏋 Trainer'}
                </button>
              ))}
            </div>
            <div className="p-6">
              {launchDialogTab === 'orchestrator' && (
                <div className="space-y-4">
                  <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
                    Deploys a <strong>Chiron Orchestrator</strong> on this worker. The orchestrator coordinates FedAvg aggregation across registered trainers without accessing raw data.
                  </div>
                  <button onClick={() => { setCreatingFor(launchDialogManagerId); createOrchestrator(launchDialogManagerId!); }} disabled={isCreatingOrchestrator} className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                    {isCreatingOrchestrator ? <><BiLoaderAlt className="animate-spin" size={14} /> Deploying...</> : <><FaPlay size={12} /> Start Orchestrator</>}
                  </button>
                </div>
              )}
              {launchDialogTab === 'trainer' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">Datasets <span className="text-red-500">*</span></label>
                    <div className="max-h-44 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-50">
                      {(() => {
                        const manager = managers.find(m => m.serviceId === launchDialogManagerId);
                        const datasets = manager?.workerInfo?.datasets || {};
                        const entries = Object.entries(datasets);
                        if (entries.length === 0) return <p className="text-sm text-gray-400 text-center py-4">No datasets available on this worker</p>;
                        return entries.map(([datasetId, manifest]: [string, any]) => {
                          const hasAccess = hasDatasetAccess(manifest);
                          return (
                            <label key={datasetId} className={`flex items-center gap-2.5 px-3 py-2.5 ${hasAccess ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-50 cursor-not-allowed bg-red-50'}`}>
                              <input type="checkbox" checked={newTrainerDatasets.includes(datasetId)} onChange={e => { e.target.checked ? setNewTrainerDatasets(p => [...p, datasetId]) : setNewTrainerDatasets(p => p.filter(d => d !== datasetId)); }} disabled={!hasAccess} className="accent-emerald-600 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm text-gray-800">{manifest.name || datasetId}</span>
                                {!hasAccess && <span className="ml-2 text-xs text-red-500">(No access)</span>}
                              </div>
                            </label>
                          );
                        });
                      })()}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">Artifact ID</label>
                    <input type="text" value={newTrainerArtifactId} onChange={e => setNewTrainerArtifactId(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="chiron-platform/tabula-trainer" />
                  </div>
                  <button onClick={() => { setCreatingFor(launchDialogManagerId); createTrainer(launchDialogManagerId); }} disabled={isCreatingTrainer || newTrainerDatasets.length === 0} className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                    {isCreatingTrainer ? <><BiLoaderAlt className="animate-spin" size={14} /> Deploying...</> : <><FaPlay size={12} /> Start Trainer ({newTrainerDatasets.length} dataset{newTrainerDatasets.length !== 1 ? 's' : ''})</>}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====== INFO MODAL ====== */}
      {showInfoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <h3 className="font-semibold text-gray-900">
                {infoModalType === 'manager' ? 'Worker Information' : infoModalType === 'orchestrator' ? 'Orchestrator Information' : 'Trainer Information'}
              </h3>
              <button onClick={() => setShowInfoModal(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {isInfoModalLoading ? (
                <div className="flex items-center justify-center py-12">
                  <FaSpinner className="animate-spin text-blue-500 text-3xl" />
                </div>
              ) : (
                <>
                  {infoModalType === 'manager' && infoModalData && 'workspace' in infoModalData && (
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-gray-700">Workspace: <span className="font-mono text-gray-900">{infoModalData.workspace}</span></div>
                      {infoModalData.clusterStatus && (
                        <div>
                          <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cluster Resources</h5>
                          <div className="grid grid-cols-2 gap-3">
                            {[
                              { label: 'CPU', val: `${infoModalData.clusterStatus.used_cpu?.toFixed(1)} / ${infoModalData.clusterStatus.total_cpu?.toFixed(1)} cores`, pct: (infoModalData.clusterStatus.used_cpu || 0) / (infoModalData.clusterStatus.total_cpu || 1), color: 'bg-blue-500' },
                              ...(infoModalData.clusterStatus.total_gpu > 0 ? [{ label: 'GPU', val: `${infoModalData.clusterStatus.used_gpu} / ${infoModalData.clusterStatus.total_gpu}`, pct: (infoModalData.clusterStatus.used_gpu || 0) / (infoModalData.clusterStatus.total_gpu || 1), color: 'bg-emerald-500' }] : []),
                            ].map(r => (
                              <div key={r.label} className="bg-gray-50 rounded-xl p-3">
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-xs font-medium text-gray-500">{r.label} used</p>
                                  <p className="text-xs font-semibold text-gray-700">{Math.round(r.pct * 100)}%</p>
                                </div>
                                <p className="text-sm text-gray-900 mb-2">{r.val}</p>
                                <div className="w-full bg-gray-200 rounded-full h-1.5"><div className={`${r.color} h-1.5 rounded-full`} style={{ width: `${r.pct * 100}%` }} /></div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Datasets ({Object.keys(infoModalData.datasets).length})</h5>
                        <div className="space-y-2">
                          {Object.entries(infoModalData.datasets).map(([datasetId, manifest]: [string, any]) => {
                            const hasAccess = hasDatasetAccess(manifest);
                            return (
                              <div key={datasetId} className={`p-3 rounded-xl ${hasAccess ? 'bg-gray-50' : 'bg-red-50 border border-red-100'}`}>
                                <div className="flex items-center justify-between mb-1">
                                  <p className="font-medium text-sm text-gray-900">{manifest.name || datasetId}</p>
                                  {!hasAccess && <span className="text-xs text-red-600 font-medium">No Access</span>}
                                </div>
                                {manifest.description && <p className="text-xs text-gray-500 mb-1.5">{manifest.description}</p>}
                                {manifest.zarr_files && manifest.zarr_files.length > 0 && (
                                  <table className="w-full text-xs mt-1.5">
                                    <thead>
                                      <tr className="text-gray-400">
                                        <th className="text-left font-medium pb-0.5">File</th>
                                        <th className="text-right font-medium pb-0.5">Cells</th>
                                        <th className="text-right font-medium pb-0.5">Genes</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {manifest.zarr_files.map((f: any) => (
                                        <tr key={f.name} className="border-t border-gray-200">
                                          <td className="py-0.5 font-mono text-gray-600 text-xs">{f.name}</td>
                                          <td className="py-0.5 text-right text-gray-600">{f.n_samples?.toLocaleString() ?? '—'}</td>
                                          <td className="py-0.5 text-right text-gray-600">{f.n_vars?.toLocaleString() ?? '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  {infoModalType === 'orchestrator' && infoModalData && 'status' in infoModalData && 'artifactId' in infoModalData && !('appId' in infoModalData) && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2"><span className="text-sm font-medium text-gray-600">Status:</span>{getStatusBadge(infoModalData.status)}</div>
                      <div><span className="text-sm font-medium text-gray-600">Artifact: </span><span className="text-sm text-gray-800 font-mono">{infoModalData.artifactId}</span></div>
                    </div>
                  )}
                  {infoModalType === 'trainer' && infoModalData && 'appId' in infoModalData && (
                    <div className="space-y-3">
                      <div><span className="text-sm font-medium text-gray-600">App ID: </span><span className="text-sm font-mono text-gray-800">{infoModalData.appId}</span></div>
                      <div className="flex items-center gap-2"><span className="text-sm font-medium text-gray-600">Status:</span>{getStatusBadge(infoModalData.status)}</div>
                      <div><span className="text-sm font-medium text-gray-600">Artifact: </span><span className="text-sm font-mono text-gray-800">{infoModalData.artifactId}</span></div>
                      <div>
                        <span className="text-sm font-medium text-gray-600">Datasets: </span>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {Object.keys(infoModalData.datasets).map(d => <span key={d} className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">{d}</span>)}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="px-6 pb-5 flex-shrink-0">
              <button onClick={() => setShowInfoModal(false)} className="w-full py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-200 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== ERROR POPUP ====== */}
      {showErrorPopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-red-50 flex items-center gap-3 flex-shrink-0">
              <FaTimesCircle className="text-red-500 flex-shrink-0" size={20} />
              <h3 className="font-semibold text-gray-900">{errorPopupMessage}</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{errorPopupDetails}</p>
            </div>
            <div className="px-6 pb-5 flex-shrink-0">
              <button onClick={() => { setShowErrorPopup(false); setErrorPopupMessage(''); setErrorPopupDetails(''); }} className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== TRAINER ERROR DETAIL ====== */}
      {showErrorDetailModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-red-50 flex items-center gap-3 flex-shrink-0">
              <FaTimesCircle className="text-red-500 flex-shrink-0" size={20} />
              <h3 className="font-semibold text-gray-900">Error in Trainer {errorDetailTrainerId}</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words font-mono bg-gray-50 rounded-xl p-4 border border-gray-100">{errorDetailMessage}</pre>
            </div>
            <div className="px-6 pb-5 flex-shrink-0">
              <button onClick={() => { setShowErrorDetailModal(false); setErrorDetailTrainerId(''); setErrorDetailMessage(''); }} className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== CONFIRM MODAL ====== */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${confirmModalDanger ? 'bg-red-100' : 'bg-amber-100'}`}>
                <svg className={`w-5 h-5 ${confirmModalDanger ? 'text-red-600' : 'text-amber-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">{confirmModalTitle}</h3>
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{confirmModalMessage}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowConfirmModal(false); setConfirmModalAction(null); setConfirmModalDanger(false); setConfirmModalConfirmLabel('Continue'); }} className="flex-1 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">Cancel</button>
              <button onClick={() => { const action = confirmModalAction; setShowConfirmModal(false); setConfirmModalAction(null); setConfirmModalDanger(false); setConfirmModalConfirmLabel('Continue'); action?.(); }} className={`flex-1 py-2.5 text-white text-sm font-medium rounded-xl transition-colors ${confirmModalDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}`}>{confirmModalConfirmLabel}</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== SERVICE SELECTION MODAL ====== */}
      {showServiceSelectionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h3 className="font-semibold text-gray-900">Multiple Workers Found</h3>
              <p className="text-sm text-gray-500 mt-1">Select which workers to connect in <strong>{pendingWorkspace}</strong>:</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {availableServices.map(serviceId => (
                <label key={serviceId} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                  <input type="checkbox" checked={selectedServices.has(serviceId)} onChange={e => { const n = new Set(selectedServices); e.target.checked ? n.add(serviceId) : n.delete(serviceId); setSelectedServices(n); }} className="accent-blue-600 flex-shrink-0" />
                  <p className="text-sm text-gray-800 font-mono break-all">{serviceId}</p>
                </label>
              ))}
            </div>
            <div className="px-6 pb-5 flex gap-3 flex-shrink-0">
              <button onClick={() => { setShowServiceSelectionModal(false); setPendingWorkspace(''); setAvailableServices([]); setSelectedServices(new Set()); setConnectingWorkspace(null); }} className="flex-1 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">Cancel</button>
              <button onClick={handleServiceSelectionConfirm} disabled={selectedServices.size === 0} className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Connect ({selectedServices.size} selected)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Training;
