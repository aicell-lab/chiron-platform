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
  registeredOrchestratorId?: string;
}

type TrainingStage = 'fit' | 'evaluate' | 'aggregation' | 'distribution' | null;

interface TrainingStatus {
  is_running: boolean;
  current_training_round: number;
  target_round: number;
  stage: TrainingStage;
  trainers_progress: Record<string, { status?: string; current_batch: number; total_batches: number; progress: number; error?: string; }>;
  pending_removal?: string[];
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

const extractRemoteError = (msg: string): string => {
  if (!msg.includes('Traceback')) return msg;
  const lines = msg.split('\n');
  let last = '';
  for (const line of lines) {
    const t = line.trim();
    if (/^[A-Za-z]+(?:Error|Exception): /.test(t) && !t.startsWith('Exception: Traceback')) {
      last = t;
    }
  }
  return last || msg;
};

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
  const [errorPopupDashboardUrl, setErrorPopupDashboardUrl] = useState<string | null>(null);

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
  const [localModelWeights, setLocalModelWeights] = useState<Array<{path: string; client_name: string; saved_at: string | null; description: string | null; datasets: Record<string, any>; train_samples: number; num_rounds: number; total_samples_seen: number}> | null>(null);
  const [selectedWeightsPath, setSelectedWeightsPath] = useState<string | null>(null);
  const [isLoadingLocalWeights, setIsLoadingLocalWeights] = useState(false);
  const [isWeightsDropdownOpen, setIsWeightsDropdownOpen] = useState(false);

  const [workerTimers, setWorkerTimers] = useState<Record<string, NodeJS.Timeout>>({});
  const [datasetTimers, setDatasetTimers] = useState<Record<string, NodeJS.Timeout>>({});

  const [isTraining, setIsTraining] = useState(false);
  // True when the current training run was detected (externally started), not launched by this UI session.
  const [trainingResumed, setTrainingResumed] = useState(false);
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
  // Trainer service IDs that have participated in at least one round of the current run.
  // Used to distinguish "pending add" (registered but not yet active) from active trainers.
  const [participatedTrainerIds, setParticipatedTrainerIds] = useState<Set<string>>(new Set());

  // Cache of display metadata for each trainer websocket service ID.
  // Populated whenever a trainer is visible; survives trainer going offline so Save Weights
  // can still show name/geo/datasets for disconnected participants.
  const [trainerMetaCache, setTrainerMetaCache] = useState<Record<string, {
    workerName: string;
    geoDisplay: string;
    datasets: string[];
    managerId: string;
  }>>({});

  // Save model weights
  // Save Weights state — keyed by 'global', 'publish-{svcId}', 'local-{svcId}'
  const [saveDescriptions, setSaveDescriptions] = useState<Record<string, string>>({});
  const [saveStatuses, setSaveStatuses] = useState<Record<string, 'idle'|'saving'|'success'|'duplicate'>>({});
  const [savedItems, setSavedItems] = useState<Record<string, {artifactId?: string; path?: string; description: string; round?: number}>>({});

  // Checkpoint selectors — fetched when Save Weights panel becomes visible
  type CheckpointEntry = { round: number; path: string; saved_at: string };
  const [globalCheckpoints, setGlobalCheckpoints] = useState<CheckpointEntry[]>([]);
  const [selectedGlobalRound, setSelectedGlobalRound] = useState<number | null>(null);
  const [trainerCheckpoints, setTrainerCheckpoints] = useState<Record<string, CheckpointEntry[]>>({});
  const [selectedTrainerRounds, setSelectedTrainerRounds] = useState<Record<string, number | null>>({});

  const [trainerParams, setTrainerParams] = useState<any>(null);
  const [trainerParamsLoading, setTrainerParamsLoading] = useState(false);
  const [trainerParamsError, setTrainerParamsError] = useState<string | null>(null);

  const [showErrorDetailModal, setShowErrorDetailModal] = useState(false);
  const [errorDetailTrainerId, setErrorDetailTrainerId] = useState<string>('');
  const [errorDetailMessage, setErrorDetailMessage] = useState<string>('');

  const [showAppLogsModal, setShowAppLogsModal] = useState(false);
  const [appLogsLabel, setAppLogsLabel] = useState<string>('');
  const [appLogsData, setAppLogsData] = useState<any>(null);
  const [appLogsLoading, setAppLogsLoading] = useState(false);
  const [appLogsManagerId, setAppLogsManagerId] = useState<string>('');
  const [appLogsAppId, setAppLogsAppId] = useState<string>('');

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
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [currentStep]);

  const [highlightedWorkerIds, setHighlightedWorkerIds] = useState<string[]>([]);
  useEffect(() => {
    if (highlightedWorkerIds.length === 0) return;
    const id = highlightedWorkerIds[0];
    const el = document.querySelector(`[data-workerid="${id}"]`) ?? document.querySelector(`[data-managerid="${id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [highlightedWorkerIds]);

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
        let datasetsInfo: Record<string, any> | undefined;
        try { datasetsInfo = await managerService.get_datasets_info(); } catch { /* not critical */ }
        newManagers.push({ workspace, serviceId, service: managerService, isConnected: true, workerInfo, datasetsInfo });
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
            newT.push({ managerId, appId, status: (trainerStatus as any).status, serviceIds: (trainerStatus as any).service_ids || [], datasets: (trainerStatus as any).datasets || {}, artifactId: (trainerStatus as any).artifact_id || 'chiron-platform/tabula-trainer', displayName: (trainerStatus as any).display_name, applicationId: appId, isBusy: (trainerStatus as any).is_busy ?? false, registeredOrchestratorId: (trainerStatus as any).registered_orchestrator_id ?? undefined });
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
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
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
      const trainerParams: Record<string, any> = { token: applicationToken, datasets: newTrainerDatasets, trainer_artifact_id: newTrainerArtifactId, owner_id: ownerId, _rkwargs: true };
      if (selectedWeightsPath) trainerParams.pretrained_weights_path = selectedWeightsPath;
      await manager.service.create_trainer(trainerParams);
      setShowCreateTrainer(false); setShowLaunchDialog(false); setCreatingFor(null); setNewTrainerDatasets([]); setLocalModelWeights(null); setSelectedWeightsPath(null); setIsWeightsDropdownOpen(false); setIsCreatingTrainer(false);
      await refreshWorkerInfo(managerId);
      scheduleWorkerRefresh(managerId);
    } catch (error) {
      setErrorPopupMessage('Failed to Create Trainer');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
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
      const msg = extractRemoteError(error instanceof Error ? error.message : 'Unknown error');
      setErrorPopupMessage('Failed to Remove Orchestrator');
      setErrorPopupDetails(msg);
      if (msg.includes('worker admin')) {
        setErrorPopupDashboardUrl(`${window.location.origin}/#/worker/dashboard?service_id=${managerId.split(':bioengine')[0]}:bioengine-worker`);
      }
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
      const msg = extractRemoteError(error instanceof Error ? error.message : 'Unknown error');
      setErrorPopupMessage('Failed to Remove Trainer');
      setErrorPopupDetails(msg);
      if (msg.includes('worker admin')) {
        setErrorPopupDashboardUrl(`${window.location.origin}/#/worker/dashboard?service_id=${managerId.split(':bioengine')[0]}:bioengine-worker`);
      }
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
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
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
      const orchestratorServiceId = orchestrator.serviceIds[0].websocket_service_id;
      const orchestratorService = await server.getService(orchestratorServiceId);
      await orchestratorService.add_trainer(trainer.serviceIds[0].websocket_service_id, orchestratorServiceId);
      const registeredServiceIds = await orchestratorService.list_trainers();
      setRegisteredTrainers(registeredServiceIds);
    } catch (error) {
      setErrorPopupMessage('Failed to Register Trainer');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
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

  const unregisterRemoteTrainer = async (trainerServiceId: string) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    try {
      setIsLoadingRegisteredTrainers(true);
      const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      await orchestratorService.remove_trainer(trainerServiceId);
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

  // Auto-detect already-running training when the selected orchestrator changes or
  // when the orchestrators list first loads.  Covers:
  //   • User navigates away and back (selectedOrchestrator unchanged, orchestrators reloaded)
  //   • Second device / second browser tab opening the page mid-run
  //   • UI launched fresh while a Python-initiated run is already in progress
  useEffect(() => {
    // Allow re-check if we're watching a *different* orchestrator than the one now selected.
    if (isTraining && selectedOrchestrator === trainingOrchestratorId) return;
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    let cancelled = false;
    const checkOngoingTraining = async () => {
      try {
        const orchestratorService = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
        const [status, history] = await Promise.all([
          orchestratorService.get_training_status(),
          orchestratorService.get_training_history().catch(() => null),
        ]);
        if (cancelled) return;
        if (history) setTrainingHistory(history);
        if (!status?.is_running) return; // training stopped or never started — just show history
        // Training is actively running — enter the monitoring state
        setIsTraining(true);
        setTrainingResumed(true);
        setTrainingOrchestratorId(selectedOrchestrator);
        setTrainingConfigCollapsed(true);
        setTrainingStatus(status);
        const ids = Object.keys(status.trainers_progress ?? {});
        if (ids.length > 0) setParticipatedTrainerIds(new Set(ids));
        // Poll until done
        const statusInterval = setInterval(async () => {
          try {
            const s = await orchestratorService.get_training_status();
            if (cancelled) { clearInterval(statusInterval); return; }
            setTrainingStatus(s);
            const newIds = Object.keys(s.trainers_progress ?? {});
            if (newIds.length > 0) {
              setParticipatedTrainerIds(prev => {
                const next = new Set(prev);
                newIds.forEach(id => next.add(id));
                return next;
              });
            }
            if (!s.is_running) {
              setIsTraining(false); setTrainingResumed(false); setTrainingOrchestratorId(null); clearInterval(statusInterval);
              const h = await orchestratorService.get_training_history();
              if (h) setTrainingHistory(h);
            }
          } catch { /* silent */ }
        }, 3000);
      } catch { /* orchestrator not yet reachable — will retry on next dep change */ }
    };
    checkOngoingTraining();
    return () => { cancelled = true; };
  }, [selectedOrchestrator, orchestrators]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setIsPreparingTraining(false); setIsTraining(true); setTrainingResumed(false); setTrainingOrchestratorId(launchedFrom); setTrainingConfigCollapsed(true);
      setParticipatedTrainerIds(new Set());
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setSavedItems({});
      setSaveStatuses({});
      const trainingParams: any = { num_rounds: config.num_rounds, fit_config: config.fit_config, eval_config: config.eval_config, per_round_timeout: config.per_round_timeout, _rkwargs: true };
      if (config.initial_weights) trainingParams.initial_weights = config.initial_weights;
      orchestratorService.start_training(trainingParams).catch((error: Error) => {
        setErrorPopupMessage('Training Failed'); setErrorPopupDetails(error.message); setShowErrorPopup(true);
        setIsTraining(false); setTrainingResumed(false); setTrainingOrchestratorId(null);
      });
      const statusInterval = setInterval(async () => {
        try {
          const status = await orchestratorService.get_training_status();
          setTrainingStatus(status);
          // Accumulate trainer IDs that have appeared in trainers_progress
          const newIds = Object.keys(status.trainers_progress);
          if (newIds.length > 0) {
            setParticipatedTrainerIds(prev => {
              const next = new Set(prev);
              newIds.forEach(id => next.add(id));
              return next;
            });
          }
          if (!status.is_running) {
            setIsTraining(false); setTrainingResumed(false); setTrainingOrchestratorId(null); clearInterval(statusInterval);
            const history = await orchestratorService.get_training_history();
            setTrainingHistory(history);
          }
        } catch { /* silent */ }
      }, 3000);
    } catch (error) {
      setErrorPopupMessage('Failed to Start Training');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
      setShowErrorPopup(true); setIsPreparingTraining(false); setIsTraining(false); setTrainingResumed(false); setTrainingOrchestratorId(null);
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
      setIsTraining(false); setTrainingResumed(false); setTrainingOrchestratorId(null); setTrainingStatus(null);
    } catch (error) {
      setErrorPopupMessage('Failed to Stop Training');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
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
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
      setShowErrorPopup(true);
    }
  };

  const setSaveStatus = (key: string, status: 'idle'|'saving'|'success'|'duplicate', timeoutMs?: number) => {
    setSaveStatuses(p => ({ ...p, [key]: status }));
    if (timeoutMs) setTimeout(() => setSaveStatuses(p => ({ ...p, [key]: 'idle' })), timeoutMs);
  };

  const saveGlobalWeights = async (autoDescription: string) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    const desc = saveDescriptions['global'] || autoDescription;
    const currentRound = trainingHistory?.training_losses?.length ?? 0;
    const prev = savedItems['global'];
    if (prev && prev.description === desc && prev.round === currentRound) {
      setSaveStatus('global', 'duplicate', 4000); return;
    }
    setSaveStatus('global', 'saving');
    try {
      const orchSvc = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const params: any = { description: desc, _rkwargs: true };
      if (selectedGlobalRound !== null) params.checkpoint_round = selectedGlobalRound;
      const artifactId = await orchSvc.save_global_weights(params);
      setSavedItems(p => ({ ...p, 'global': { artifactId, description: desc, round: currentRound } }));
      setSaveStatus('global', 'success');
    } catch (error) {
      setErrorPopupMessage('Failed to Save Global Weights');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
      setShowErrorPopup(true);
      setSaveStatus('global', 'idle');
    }
  };

  const saveTrainerPublish = async (svcId: string, autoDescription: string) => {
    if (!selectedOrchestrator) return;
    const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchestrator || orchestrator.status !== 'RUNNING') return;
    const key = `publish-${svcId}`;
    const desc = saveDescriptions[key] || autoDescription;
    const prev = savedItems[key];
    if (prev && prev.description === desc) { setSaveStatus(key, 'duplicate', 4000); return; }
    setSaveStatus(key, 'saving');
    try {
      const orchSvc = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
      const params: any = { client_ids: [svcId], description: desc, _rkwargs: true };
      const selRound = selectedTrainerRounds[svcId];
      if (selRound != null) params.checkpoint_round = selRound;
      const artifactIds = await orchSvc.save_model_weights(params);
      const artifactId = Object.values(artifactIds as Record<string, string>)[0] || '';
      setSavedItems(p => ({ ...p, [key]: { artifactId, description: desc } }));
      setSaveStatus(key, 'success');
    } catch (error) {
      setErrorPopupMessage('Failed to Publish Trainer Model');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
      setShowErrorPopup(true);
      setSaveStatus(key, 'idle');
    }
  };

  const saveTrainerLocal = async (svcId: string, autoDescription: string) => {
    const key = `local-${svcId}`;
    const desc = saveDescriptions[key] || autoDescription;
    const prev = savedItems[key];
    if (prev && prev.description === desc) { setSaveStatus(key, 'duplicate', 4000); return; }
    setSaveStatus(key, 'saving');
    try {
      const trainerSvc = await server.getService(svcId);
      const localParams: any = { description: desc, _rkwargs: true };
      const selRound = selectedTrainerRounds[svcId];
      if (selRound != null) localParams.checkpoint_round = selRound;
      const savedPath = await trainerSvc.save_local_model(localParams);
      setSavedItems(p => ({ ...p, [key]: { path: savedPath as string, description: desc } }));
      setSaveStatus(key, 'success');
    } catch (error) {
      setErrorPopupMessage('Failed to Save Model Locally');
      setErrorPopupDetails(extractRemoteError(error instanceof Error ? error.message : 'Unknown error'));
      setShowErrorPopup(true);
      setSaveStatus(key, 'idle');
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

  const getTrainerDisplayName = (serviceId: string): string =>
    trainerServiceToWorkerName[serviceId] || serviceId;

  const openAppLogsModal = async (managerId: string, appId: string, label: string) => {
    setAppLogsManagerId(managerId);
    setAppLogsAppId(appId);
    setAppLogsLabel(label);
    setAppLogsData(null);
    setAppLogsLoading(true);
    setShowAppLogsModal(true);
    try {
      const manager = managers.find(m => m.serviceId === managerId);
      if (!manager) throw new Error('Manager not connected');
      const data = await manager.service.get_app_logs({ application_id: appId, logs_tail: 200, _rkwargs: true });
      setAppLogsData(data);
    } catch (e) {
      setAppLogsData({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAppLogsLoading(false);
    }
  };

  const getStatusBadge = (status?: string, onClick?: () => void) => {
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
    const inner = (
      <>
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        {displayStatus}
      </>
    );
    if (onClick) {
      return (
        <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color} hover:brightness-95 cursor-pointer transition-all`} title="Click to view logs">
          {inner}
        </button>
      );
    }
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
        {inner}
      </span>
    );
  };

  const BusyBadge = () => (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 ml-1" title="Currently in an active training session">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      Busy
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
      // Train stage: only workers with selected orchestrator or registered trainers,
      // and their role reflects only the selected/registered apps (not all apps on the worker).
      const selectedOrchObj = selectedOrchestrator
        ? orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator)
        : null;
      const registeredTrainerManagerIds = new Set(
        trainers
          .filter(t => { const svcId = t.serviceIds?.[0]?.websocket_service_id; return svcId && registeredTrainers.includes(svcId); })
          .map(t => t.managerId)
      );
      const selectedManagerIds = new Set<string>();
      if (selectedOrchObj) selectedManagerIds.add(selectedOrchObj.managerId);
      registeredTrainerManagerIds.forEach(id => selectedManagerIds.add(id));

      const sessionRole = (managerId: string): MapWorker['role'] => {
        const isOrch = selectedOrchObj?.managerId === managerId;
        const isTrainer = registeredTrainerManagerIds.has(managerId);
        return isOrch && isTrainer ? 'both' : isOrch ? 'orchestrator' : isTrainer ? 'trainer' : 'connected';
      };

      return managers
        .filter(m => selectedManagerIds.has(m.serviceId))
        .flatMap(manager => {
          const geo = manager.workerInfo?.worker_info?.geo_location;
          if (!geo?.latitude || !geo?.longitude) return [];
          const datasetCount = manager.workerInfo?.datasets ? Object.keys(manager.workerInfo.datasets).length : 0;
          const datasetNames3 = manager.workerInfo?.datasets ? Object.values(manager.workerInfo.datasets as Record<string, any>).map((d: any) => d.name || '').filter(Boolean) : [];
          const datasetLabel3 = datasetCount > 0 ? `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}: ${datasetNames3.join(', ')}` : '0 datasets';
          return [{ id: manager.serviceId, name: manager.workerInfo?.worker_info ? `${geo.region}, ${geo.country_name}` : manager.workspace, lat: geo.latitude, lng: geo.longitude, role: sessionRole(manager.serviceId), label: datasetLabel3 }];
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
        const datasetNames2 = manager.workerInfo?.datasets ? Object.values(manager.workerInfo.datasets as Record<string, any>).map((d: any) => d.name || '').filter(Boolean) : [];
        const datasetLabel2 = datasetCount > 0 ? `${datasetCount} dataset${datasetCount !== 1 ? 's' : ''}: ${datasetNames2.join(', ')}` : '0 datasets';
        return [{ id: manager.serviceId, name: manager.workerInfo?.worker_info ? `${geo.region}, ${geo.country_name}` : manager.workspace, lat: geo.latitude, lng: geo.longitude, role: appRole(manager.serviceId), label: `${orchCount} orchestrator${orchCount !== 1 ? 's' : ''}, ${trainerCount} trainer${trainerCount !== 1 ? 's' : ''}<br/>${datasetLabel2}` }];
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
  // Map trainer service ID → managerId for pulse/animation lookups
  const serviceToManagerId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    trainers.forEach(t => {
      (t.serviceIds || []).forEach((svcObj: any) => {
        const sid = svcObj?.websocket_service_id;
        if (sid) map[sid] = t.managerId;
      });
    });
    return map;
  }, [trainers]);

  const mapWorkersWithActive = useMemo<MapWorker[]>(() => {
    if (!isTraining || !trainingStatus?.stage) return mapWorkers;
    const orchObj = selectedOrchestrator
      ? orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator)
      : null;
    const orchManagerId = orchObj?.managerId;
    const stage = trainingStatus.stage;
    const activeIds = new Set<string>();
    if (stage === 'aggregation' || stage === 'distribution') {
      // Only orchestrator pulses — it's doing the averaging / distributing weights
      if (orchManagerId) activeIds.add(orchManagerId);
    } else {
      // fit / evaluate: only trainers that are still RUNNING pulse
      Object.entries(trainingStatus.trainers_progress).forEach(([serviceId, prog]) => {
        const s = prog.status;
        if (s === 'RUNNING' || s === 'PENDING') {
          const managerId = serviceToManagerId[serviceId];
          if (managerId) activeIds.add(managerId);
        }
      });
    }
    return mapWorkers.map(w => activeIds.has(w.id) ? { ...w, active: true } : w);
  }, [mapWorkers, isTraining, trainingStatus, selectedOrchestrator, orchestrators, serviceToManagerId]);

  // Connection lines: selected orchestrator ↔ registered trainers that have already participated.
  // Pending-add trainers (registered but not yet active) are shown on the map without a connection.
  // animated encodes the current training stage so that polylines are refreshed on stage change.
  const mapConnections = useMemo<MapConnection[]>(() => {
    if (!selectedOrchestrator) return [];
    const orchObj = orchestrators.find(o => `${o.managerId}::${o.appId}` === selectedOrchestrator);
    if (!orchObj) return [];
    const orchManagerId = orchObj.managerId;
    const stage = trainingStatus?.stage;
    // fit / evaluate: Trainer → Orchestrator (trainers send weights/results)
    // aggregation / distribution: Orchestrator → Trainers (orch sends averaged weights)
    const animated: MapConnection['animated'] =
      isTraining && stage === 'fit'          ? 'fit' :
      isTraining && stage === 'evaluate'     ? 'evaluate' :
      isTraining && (stage === 'aggregation' || stage === 'distribution') ? 'distribution' :
      undefined;
    return trainers
      .filter(t => {
        const svcId = t.serviceIds?.[0]?.websocket_service_id;
        if (!svcId || !registeredTrainers.includes(svcId)) return false;
        // Exclude pending-add trainers (not yet participated in any round)
        if (isTraining && participatedTrainerIds.size > 0 && !participatedTrainerIds.has(svcId)) return false;
        return true;
      })
      .filter(t => t.managerId !== orchManagerId)
      .map(t => ({ from: orchManagerId, to: t.managerId, animated }));
  }, [selectedOrchestrator, orchestrators, trainers, registeredTrainers, isTraining, trainingStatus?.stage, participatedTrainerIds]);

  // All discovered workers (flat list with workspace context)
  const allDiscoveredWorkers = useMemo(() => {
    return observedWorkspaces
      .flatMap(ws => (discoveredWorkers[ws] || []).map(w => ({ ...w, workspace: ws })))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [observedWorkspaces, discoveredWorkers]);

  const trainerServiceToWorkerName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const trainer of trainers) {
      const wsId = trainer.serviceIds?.[0]?.websocket_service_id;
      if (wsId) {
        const worker = allDiscoveredWorkers.find(w => w.serviceId === trainer.managerId);
        map[wsId] = worker?.name || trainer.managerId;
      }
    }
    return map;
  }, [trainers, allDiscoveredWorkers]);

  // Keep trainer metadata cache fresh whenever trainers or managers update.
  // This lets Save Weights show name/geo/datasets even after a trainer goes offline.
  useEffect(() => {
    setTrainerMetaCache(prev => {
      const next = { ...prev };
      for (const trainer of trainers) {
        const wsId = trainer.serviceIds?.[0]?.websocket_service_id;
        if (!wsId) continue;
        const mgr = managers.find(m => m.serviceId === trainer.managerId);
        const geo = mgr?.workerInfo?.worker_info?.geo_location;
        const geoDisplay = geo ? `${geo.region}, ${geo.country_name}` : '';
        const workerName = allDiscoveredWorkers.find(w => w.serviceId === trainer.managerId)?.name || trainer.managerId;
        const datasets = Object.values(trainer.datasets as Record<string, any>).map((d: any) => d.name || '').filter(Boolean);
        next[wsId] = { workerName, geoDisplay, datasets, managerId: trainer.managerId };
      }
      return next;
    });
  }, [trainers, managers, allDiscoveredWorkers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch checkpoint lists when the Save Weights panel should be visible
  // (training done and there is history). Re-runs when selectedOrchestrator changes.
  useEffect(() => {
    const orchId = trainingOrchestratorId || selectedOrchestrator;
    if (!orchId) return;
    const orchObj = orchestrators.find(o => `${o.managerId}::${o.appId}` === orchId);
    if (!orchObj || orchObj.status !== 'RUNNING') return;
    let cancelled = false;
    (async () => {
      try {
        const orchSvc = await server.getService(orchObj.serviceIds[0].websocket_service_id);
        const ckpts: CheckpointEntry[] = await orchSvc.list_global_checkpoints();
        if (cancelled) return;
        setGlobalCheckpoints(ckpts || []);
        if (ckpts && ckpts.length > 0) setSelectedGlobalRound(prev => prev ?? ckpts[0].round);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [selectedOrchestrator, trainingOrchestratorId, isTraining]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch per-trainer checkpoints for all history participants
  useEffect(() => {
    if (!trainingHistory) return;
    const ids = [
      ...Object.keys(trainingHistory.client_training_losses ?? {}),
      ...Object.keys(trainingHistory.client_validation_losses ?? {}),
    ];
    ids.forEach(async (svcId) => {
      const liveTrainer = trainers.find(t => t.serviceIds?.[0]?.websocket_service_id === svcId);
      if (!liveTrainer || liveTrainer.status !== 'RUNNING') return;
      try {
        const svc = await server.getService(svcId);
        const ckpts: CheckpointEntry[] = await svc.list_weight_checkpoints();
        setTrainerCheckpoints(prev => ({ ...prev, [svcId]: ckpts || [] }));
        setSelectedTrainerRounds(prev => {
          if (prev[svcId] != null) return prev;
          const latest = ckpts?.[0]?.round ?? null;
          return { ...prev, [svcId]: latest };
        });
      } catch { /* silent */ }
    });
  }, [trainingHistory, isTraining]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepEnabled = (step: number) => {
    if (step === 1) return true;
    if (step === 2) return managers.length > 0;
    if (step === 3) return !!selectedOrchestrator;
    return false;
  };

  // True only when training is running for the currently viewed orchestrator
  const isActivelyTraining = isTraining && selectedOrchestrator === trainingOrchestratorId;

  return (
    <div className="px-6 py-6">
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
        <div className="w-72 xl:w-[360px] flex-shrink-0 space-y-4 sticky top-6">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 pt-4 pb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">Federation Map</span>
              <span className="ml-auto text-xs text-gray-400">{mapWorkers.length} worker{mapWorkers.length !== 1 ? 's' : ''}</span>
            </div>
            <FederatedWorldMap workers={mapWorkersWithActive} connections={mapConnections} style={{ height: 260, width: '100%' }} onSelect={setHighlightedWorkerIds} />
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
                  <div className="flex items-center gap-2">
                    {Object.values(wsDiscoveryStatus).some(s => s === 'loading') && (
                      <BiLoaderAlt className="animate-spin text-blue-500" size={18} />
                    )}
                    <button
                      onClick={() => observedWorkspaces.forEach(ws => discoverWorkspace(ws))}
                      disabled={Object.values(wsDiscoveryStatus).some(s => s === 'loading')}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Refresh worker list"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      Refresh
                    </button>
                  </div>
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
                          <th className="text-center px-6 py-3">Worker</th>
                          <th className="text-center px-4 py-3">Location</th>
                          <th className="text-center px-4 py-3">Datasets</th>
                          <th className="text-center px-4 py-3 w-40">Orchestrators</th>
                          <th className="text-center px-4 py-3 w-40">Trainers</th>
                          <th className="text-center px-6 py-3">Actions</th>
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

                          const isHighlighted = highlightedWorkerIds.includes(worker.serviceId);
                          return (
                            <tr key={worker.serviceId} data-workerid={worker.serviceId} className={`hover:bg-gray-50/50 transition-colors ${isConnected ? '' : 'opacity-80'} ${isHighlighted ? 'ring-2 ring-inset ring-violet-400 bg-violet-50/60' : ''}`}>
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
                                        <div key={o.appId} className="flex items-center gap-1 justify-center">
                                          {getStatusBadge(o.status, () => openAppLogsModal(worker.serviceId, o.appId, `Orchestrator · ${o.appId}`))}
                                          {o.isBusy && <BusyBadge />}
                                          <button onClick={() => removeOrchestrator(worker.serviceId)} className="text-red-400 hover:text-red-600 ml-0.5 flex-shrink-0" title="Remove"><FaTrash size={10} /></button>
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
                                        <div key={t.appId} className="flex items-center gap-1 justify-center">
                                          {getStatusBadge(t.status, () => openAppLogsModal(worker.serviceId, t.appId, `Trainer · ${t.appId}`))}
                                          {t.isBusy && <BusyBadge />}
                                          <button onClick={() => removeTrainer(worker.serviceId, t.appId)} className="text-red-400 hover:text-red-600 ml-0.5 flex-shrink-0" title="Remove"><FaTrash size={10} /></button>
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
                        const isHighlighted = highlightedWorkerIds.includes(orch.managerId);
                        const orchBorder = isSelected ? 'border-blue-500' : isBusyElsewhere ? 'border-amber-200' : isHighlighted ? 'border-violet-400' : 'border-transparent hover:border-gray-200';
                        const orchBg = isSelected ? (isHighlighted ? 'bg-violet-50' : 'bg-blue-50/60') : isBusyElsewhere ? 'bg-amber-50/40' : isHighlighted ? 'bg-violet-50' : 'bg-gray-50';
                        return (
                          <label key={orchestratorId} data-managerid={orch.managerId} className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-all ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${orchBorder} ${orchBg}`}>
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
                    {(() => {
                      const connectedRunningTrainers = trainers.filter(t => t.status === 'RUNNING');
                      const connectedSvcIds = new Set(connectedRunningTrainers.map(t => t.serviceIds[0]?.websocket_service_id).filter(Boolean));
                      const remoteRegisteredSvcIds = selectedOrchestrator
                        ? registeredTrainers.filter(svcId => !connectedSvcIds.has(svcId))
                        : [];
                      return (
                        <>
                          {selectedOrchestrator && connectedRunningTrainers.length === 0 && remoteRegisteredSvcIds.length === 0 && (
                            <div className="text-center py-8 text-gray-400">
                              <FaClock className="mx-auto mb-2 opacity-40" size={24} />
                              <p className="text-sm">No running trainers</p>
                              <p className="text-xs mt-1">Launch trainers from the Setup step</p>
                            </div>
                          )}
                          {selectedOrchestrator && connectedRunningTrainers.map(trainer => {
                            const trainerId = `${trainer.managerId}::${trainer.appId}`;
                            const trainerServiceId = trainer.serviceIds[0]?.websocket_service_id;
                            const isRegistered = registeredTrainers.includes(trainerServiceId);
                            const isBusyElsewhere = trainer.isBusy && !isRegistered;
                            const isDisabled = !selectedOrchestrator || isLoadingRegisteredTrainers || isBusyElsewhere;
                            const isPendingAdd = isTraining && isRegistered && !!trainerServiceId
                              && participatedTrainerIds.size > 0
                              && !participatedTrainerIds.has(trainerServiceId);
                            const isPendingRemove = isTraining && isRegistered && !!trainerServiceId
                              && (trainingStatus?.pending_removal ?? []).includes(trainerServiceId);
                            const manager = managers.find(m => m.serviceId === trainer.managerId);
                            const geo = manager?.workerInfo?.worker_info?.geo_location;
                            const datasetNames = Object.values(trainer.datasets).map((d: any) => d.name || Object.keys(trainer.datasets).find(k => trainer.datasets[k] === d)).filter(Boolean);
                            const isTrainerHighlighted = highlightedWorkerIds.includes(trainer.managerId);
                            const trainerBorder = isPendingRemove ? 'border-orange-400' : isPendingAdd ? 'border-amber-300' : isRegistered ? 'border-emerald-400' : isBusyElsewhere ? 'border-amber-200' : isTrainerHighlighted ? 'border-violet-400' : 'border-transparent hover:border-gray-200';
                            const trainerBg = isPendingRemove ? 'bg-orange-50/60' : isPendingAdd ? 'bg-amber-50/40' : isRegistered ? (isTrainerHighlighted ? 'bg-violet-50' : 'bg-emerald-50/60') : isBusyElsewhere ? 'bg-amber-50/40' : isTrainerHighlighted ? 'bg-violet-50' : 'bg-gray-50';
                            const regOrch = isBusyElsewhere && trainer.registeredOrchestratorId
                              ? orchestrators.find(o => o.serviceIds[0]?.websocket_service_id === trainer.registeredOrchestratorId)
                              : undefined;
                            const regOrchManager = regOrch ? managers.find(m => m.serviceId === regOrch.managerId) : undefined;
                            const regOrchWorkerName = regOrchManager?.workerInfo?.worker_info?.name || regOrch?.managerId?.split('/')[1]?.split(':')[0];
                            const regOrchGeo = regOrchManager?.workerInfo?.worker_info?.geo_location;
                            return (
                              <label key={trainerId} data-managerid={trainer.managerId} className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-all ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${trainerBorder} ${trainerBg}`}>
                                <input type="checkbox" checked={isRegistered} disabled={isDisabled} onChange={async e => { e.target.checked ? await registerTrainer(trainerId) : await unregisterTrainer(trainerId); }} className="mt-0.5 accent-emerald-600" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <p className="font-medium text-gray-900 text-sm leading-tight">{trainer.displayName || 'Tabula Trainer'}</p>
                                    {isPendingRemove && (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                                        <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />Leaving after this round
                                      </span>
                                    )}
                                    {isPendingAdd && (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Joins next round
                                      </span>
                                    )}
                                    {trainer.isBusy && !isPendingAdd && !isPendingRemove && (
                                      isBusyElsewhere && trainer.registeredOrchestratorId ? (
                                        <span className="relative group/busytip">
                                          <BusyBadge />
                                          <div className="absolute left-0 top-full mt-1.5 z-50 hidden group-hover/busytip:block w-64 bg-gray-900 text-white text-xs rounded-xl shadow-xl p-3 pointer-events-none">
                                            <p className="font-semibold mb-1.5 text-amber-300">Registered to orchestrator</p>
                                            {regOrchWorkerName && <p className="mb-0.5"><span className="text-gray-400">Worker:</span> {regOrchWorkerName}</p>}
                                            {regOrchGeo && <p className="mb-0.5"><span className="text-gray-400">Location:</span> {regOrchGeo.region}, {regOrchGeo.country_name}</p>}
                                            <p className="text-gray-400 break-all mt-1 leading-snug">{trainer.registeredOrchestratorId}</p>
                                          </div>
                                        </span>
                                      ) : <BusyBadge />
                                    )}
                                  </div>
                                  {geo && <p className="text-xs text-gray-500 mt-0.5">{geo.region}, {geo.country_name}</p>}
                                  {datasetNames.length > 0 && <p className="text-xs text-gray-400 mt-0.5 truncate">{datasetNames.join(', ')}</p>}
                                  {isBusyElsewhere && <p className="text-xs text-amber-600 mt-0.5">In an active training session</p>}
                                </div>
                                {isRegistered && !isPendingAdd && !isPendingRemove && <FaCheckCircle className="text-emerald-500 flex-shrink-0 mt-0.5" size={14} />}
                                {isPendingAdd && <span className="text-amber-400 flex-shrink-0 mt-0.5 text-xs font-bold">+</span>}
                                {isPendingRemove && <span className="text-orange-500 flex-shrink-0 mt-0.5 text-xs font-bold">−</span>}
                              </label>
                            );
                          })}
                          {selectedOrchestrator && remoteRegisteredSvcIds.length > 0 && (
                            <>
                              {connectedRunningTrainers.length > 0 && (
                                <div className="flex items-center gap-2 pt-1">
                                  <div className="flex-1 border-t border-gray-100" />
                                  <span className="text-xs text-gray-400 flex-shrink-0">worker not connected</span>
                                  <div className="flex-1 border-t border-gray-100" />
                                </div>
                              )}
                              {remoteRegisteredSvcIds.map(svcId => {
                                const shortId = svcId.split('/').slice(1).join('/').split('@')[0];
                                return (
                                  <label key={svcId} className={`flex items-start gap-3 p-3.5 rounded-xl border-2 border-emerald-300 bg-emerald-50/40 ${isLoadingRegisteredTrainers ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                                    <input type="checkbox" checked={true} disabled={isLoadingRegisteredTrainers} onChange={async () => { await unregisterRemoteTrainer(svcId); }} className="mt-0.5 accent-emerald-600" />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <p className="font-medium text-gray-700 text-sm leading-tight">Tabula Trainer</p>
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">
                                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                                          Worker disconnected
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{shortId}</p>
                                    </div>
                                    <FaCheckCircle className="text-emerald-400 flex-shrink-0 mt-0.5" size={14} />
                                  </label>
                                );
                              })}
                            </>
                          )}
                        </>
                      );
                    })()}
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
                      {trainingResumed && (
                        <span className="text-xs font-medium text-violet-700 bg-violet-100 px-2 py-0.5 rounded-full" title="Training was started outside this browser session and is being monitored">Resumed</span>
                      )}
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
                              <span className="text-gray-600 font-medium">{getTrainerDisplayName(trainerId)}</span>
                              {hasError && <button onClick={() => { setErrorDetailTrainerId(getTrainerDisplayName(trainerId)); setErrorDetailMessage(progress.error || ''); setShowErrorDetailModal(true); }} className="text-red-500 hover:text-red-700"><FaTimesCircle size={12} /></button>}
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
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-gray-900 text-sm">Training History</h3>
                    <button
                      onClick={async () => {
                        const orchestrator = orchestrators.find(o => `${o.managerId}::${o.appId}` === (trainingOrchestratorId || selectedOrchestrator));
                        if (!orchestrator || orchestrator.status !== 'RUNNING') return;
                        try {
                          const svc = await server.getService(orchestrator.serviceIds[0].websocket_service_id);
                          const history = await svc.get_training_history();
                          if (history) setTrainingHistory(history);
                        } catch { /* silent */ }
                      }}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 transition-colors"
                      title="Refresh training history"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Refresh
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {trainingHistory.training_losses?.length > 0 && (
                      <LossChart
                        title="Training Loss"
                        data={trainingHistory.training_losses}
                        color="#2563eb"
                        fill="#dbeafe"
                        clientData={trainingHistory.client_training_losses}
                        clientLabels={trainerServiceToWorkerName}
                      />
                    )}
                    {trainingHistory.validation_losses?.length > 0 && (
                      <LossChart
                        title="Validation Loss"
                        data={trainingHistory.validation_losses}
                        color="#10b981"
                        fill="#d1fae5"
                        clientData={trainingHistory.client_validation_losses}
                        clientLabels={trainerServiceToWorkerName}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Save Weights — shown when there is training history and not actively training */}
              {!isActivelyTraining && trainingHistory && ((trainingHistory.training_losses?.length ?? 0) > 0 || (trainingHistory.validation_losses?.length ?? 0) > 0) && (() => {
                const rounds = trainingHistory.training_losses?.length ?? 0;
                const registeredTrainerApps = trainers.filter(t =>
                  t.serviceIds?.[0]?.websocket_service_id && registeredTrainers.includes(t.serviceIds[0].websocket_service_id)
                );
                const allDatasets = [...new Set(registeredTrainerApps.flatMap(t =>
                  Object.values(t.datasets as Record<string, any>).map((d: any) => d.name || '').filter(Boolean)
                ))];
                const globalAutoDesc = `Tabula transformer · ${rounds} federated round${rounds !== 1 ? 's' : ''} · ${registeredTrainerApps.length} site${registeredTrainerApps.length !== 1 ? 's' : ''}: ${allDatasets.join(', ')}`;

                const SaveCard = ({ itemKey, title, subtitle, autoDesc, actions }: {
                  itemKey: string; title: string; subtitle: string; autoDesc: string;
                  actions: React.ReactNode;
                }) => {
                  const status = saveStatuses[itemKey] || 'idle';
                  const saved = savedItems[itemKey];
                  const borderCls = status === 'success' ? 'border-emerald-300 bg-emerald-50/30' : status === 'duplicate' ? 'border-amber-300 bg-amber-50/30' : 'border-gray-200';
                  return (
                    <div className={`rounded-xl border p-3 space-y-2 transition-colors ${borderCls}`}>
                      <div>
                        <p className="text-sm font-semibold text-gray-800">{title}</p>
                        <p className="text-xs text-gray-400">{subtitle}</p>
                      </div>
                      <input type="text"
                        value={saveDescriptions[itemKey] ?? autoDesc}
                        onChange={e => setSaveDescriptions(p => ({ ...p, [itemKey]: e.target.value }))}
                        onBlur={e => { if (!e.target.value.trim()) setSaveDescriptions(p => { const n = { ...p }; delete n[itemKey]; return n; }); }}
                        className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        {actions}
                        {status === 'success' && saved?.artifactId && (
                          <span className="text-xs text-emerald-700 font-mono bg-emerald-100 px-2 py-1 rounded-lg border border-emerald-200 truncate max-w-[200px]" title={saved.artifactId}>✓ {saved.artifactId.split('/').pop()}</span>
                        )}
                        {status === 'success' && saved?.path && (
                          <span className="text-xs text-emerald-700 font-mono bg-emerald-100 px-2 py-1 rounded-lg border border-emerald-200 truncate max-w-[200px]" title={saved.path}>✓ {saved.path.split('/').slice(-2).join('/')}</span>
                        )}
                        {status === 'duplicate' && (
                          <span className="text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded-lg border border-amber-200">Already saved</span>
                        )}
                      </div>
                    </div>
                  );
                };

                const globalStatus = saveStatuses['global'] || 'idle';
                const publishSvg = <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>;
                const localSvg = <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>;
                const spinner = <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />;

                return (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="w-7 h-7 bg-violet-500 rounded-lg flex items-center justify-center flex-shrink-0">
                        {publishSvg && <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>}
                      </div>
                      <div>
                        <p className="font-semibold text-sm text-gray-900">Save Weights</p>
                        <p className="text-xs text-gray-400 mt-0.5">Edit each description, then publish to the hub or save to the worker.</p>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {/* Global checkpoint picker */}
                      {globalCheckpoints.length > 1 && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 flex-shrink-0">Checkpoint:</span>
                          <div className="flex gap-1 flex-wrap">
                            {globalCheckpoints.map(ck => (
                              <button key={ck.round}
                                onClick={() => setSelectedGlobalRound(ck.round)}
                                className={`px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors ${selectedGlobalRound === ck.round ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                                Round {ck.round}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <SaveCard
                        itemKey="global"
                        title="Global averaged transformer"
                        subtitle={`FedAvg result · ${registeredTrainerApps.length} site${registeredTrainerApps.length !== 1 ? 's' : ''} · round ${selectedGlobalRound ?? rounds}`}
                        autoDesc={globalAutoDesc}
                        actions={
                          <button onClick={() => saveGlobalWeights(globalAutoDesc)} disabled={globalStatus === 'saving'}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-semibold rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                            {globalStatus === 'saving' ? <>{spinner} Saving…</> : <>{publishSvg} Publish</>}
                          </button>
                        }
                      />
                      {(() => {
                        // All service IDs that contributed to this training run (from history + registered).
                        const historyIds = new Set([
                          ...Object.keys(trainingHistory.client_training_losses ?? {}),
                          ...Object.keys(trainingHistory.client_validation_losses ?? {}),
                        ]);
                        registeredTrainerApps.forEach(t => historyIds.add(t.serviceIds[0].websocket_service_id));
                        return Array.from(historyIds).map(svcId => {
                          // Connectivity: is the trainer app currently running?
                          const liveTrainer = trainers.find(t => t.serviceIds?.[0]?.websocket_service_id === svcId);
                          const isConnected = !!liveTrainer && liveTrainer.status === 'RUNNING';
                          // Display metadata — prefer live data, fall back to cache
                          const meta = trainerMetaCache[svcId];
                          const workerName = meta?.workerName || svcId;
                          const geoDisplay = meta?.geoDisplay || '';
                          const datasetNames = liveTrainer
                            ? Object.values(liveTrainer.datasets as Record<string, any>).map((d: any) => d.name || '').filter(Boolean)
                            : (meta?.datasets ?? []);
                          // Resolve manager for this trainer (needed for connectivity check)
                          const managerId = liveTrainer?.managerId ?? meta?.managerId;
                          // isMgrConnected: the worker's manager service is reachable
                          const isMgrConnected = !!managers.find(m => m.serviceId === managerId && m.isConnected);
                          // "Offline"      (red)  — manager is connected but the trainer app no longer exists on the worker
                          // "Disconnected" (grey) — manager is not reachable; we have no information about trainer state
                          const offlineBadge = !isConnected
                            ? (isMgrConnected ? 'Offline' : 'Disconnected')
                            : null;
                          const clientRounds = trainingHistory.client_training_losses?.[svcId]?.length || rounds;
                          const autoDesc = `Tabula model (embedder + transformer + heads) · ${clientRounds} federated round${clientRounds !== 1 ? 's' : ''} · ${datasetNames.join(', ')}`;
                          const pubKey = `publish-${svcId}`;
                          const locKey = `local-${svcId}`;
                          const pubStatus = saveStatuses[pubKey] || 'idle';
                          const locStatus = saveStatuses[locKey] || 'idle';
                          const pubSaved = savedItems[pubKey];
                          const locSaved = savedItems[locKey];
                          const borderCls = (st: string) => st === 'success' ? 'border-emerald-300 bg-emerald-50/30' : st === 'duplicate' ? 'border-amber-300 bg-amber-50/30' : !isConnected ? 'border-gray-200 bg-gray-50/50' : 'border-gray-200';
                          const descKey = `trainer-${svcId}`;
                          const savingDisabled = !isConnected || pubStatus === 'saving' || locStatus === 'saving';
                          const ckpts = trainerCheckpoints[svcId] || [];
                          return (
                            <div key={svcId} className={`rounded-xl border p-3 space-y-2 transition-colors ${borderCls(pubStatus === 'idle' ? locStatus : pubStatus)}`}>
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className={`text-sm font-semibold ${!isConnected ? 'text-gray-500' : 'text-gray-800'}`}>{workerName}</p>
                                  <p className="text-xs text-gray-400">
                                    {geoDisplay && <>{geoDisplay}<span className="text-gray-300 mx-1">·</span></>}
                                    {datasetNames.join(', ') || 'No datasets'}<span className="text-gray-300 ml-1">· full model</span>
                                  </p>
                                </div>
                                {offlineBadge && (
                                  <span className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${offlineBadge === 'Offline' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'}`}>{offlineBadge}</span>
                                )}
                              </div>
                              {/* Checkpoint picker — shown only when multiple checkpoints exist */}
                              {ckpts.length > 1 && isConnected && (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-gray-500 flex-shrink-0">Checkpoint:</span>
                                  <div className="flex gap-1 flex-wrap">
                                    {ckpts.map(ck => (
                                      <button key={ck.round}
                                        onClick={() => setSelectedTrainerRounds(p => ({ ...p, [svcId]: ck.round }))}
                                        className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${selectedTrainerRounds[svcId] === ck.round ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                                        Round {ck.round}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <input type="text"
                                value={saveDescriptions[descKey] ?? autoDesc}
                                onChange={e => setSaveDescriptions(p => ({ ...p, [descKey]: e.target.value }))}
                                onBlur={e => { if (!e.target.value.trim()) setSaveDescriptions(p => { const n = { ...p }; delete n[descKey]; return n; }); }}
                                disabled={!isConnected}
                                className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white disabled:bg-gray-50 disabled:text-gray-400"
                              />
                              <div className={`flex flex-wrap items-center gap-2 rounded-lg p-1.5 -m-1.5 transition-colors`}>
                                <button onClick={() => saveTrainerPublish(svcId, saveDescriptions[descKey] || autoDesc)} disabled={savingDisabled}
                                  title={isConnected ? "Publish full model to chiron-models artifact hub" : offlineBadge === 'Offline' ? "Trainer app no longer exists on this worker — cannot save" : "Worker manager is not reachable — cannot save"}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-semibold rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                                  {pubStatus === 'saving' ? <>{spinner} Saving…</> : <>{publishSvg} Publish</>}
                                </button>
                                <button onClick={() => saveTrainerLocal(svcId, saveDescriptions[descKey] || autoDesc)} disabled={savingDisabled}
                                  title={isConnected ? "Save to worker at ~/.bioengine/models/" : offlineBadge === 'Offline' ? "Trainer app no longer exists on this worker — cannot save" : "Worker manager is not reachable — cannot save"}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all border border-gray-200">
                                  {locStatus === 'saving' ? <><div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500" /> Saving…</> : <>{localSvg} Save to worker</>}
                                </button>
                                {pubStatus === 'success' && pubSaved?.artifactId && <span className="text-xs text-emerald-700 font-mono bg-emerald-100 px-2 py-1 rounded border border-emerald-200 truncate max-w-[180px]" title={pubSaved.artifactId}>✓ {pubSaved.artifactId.split('/').pop()}</span>}
                                {locStatus === 'success' && locSaved?.path && <span className="text-xs text-emerald-700 font-mono bg-emerald-100 px-2 py-1 rounded border border-emerald-200 truncate max-w-[180px]" title={locSaved.path}>✓ {locSaved.path.split('/').slice(-2).join('/')}</span>}
                                {(pubStatus === 'duplicate' || locStatus === 'duplicate') && <span className="text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded border border-amber-200">Already saved</span>}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                );
              })()}

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
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">Launch Application</h3>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{launchDialogManagerId.split('/')[1]?.split(':')[0] || launchDialogManagerId}</p>
              </div>
              <button onClick={() => { setShowLaunchDialog(false); setLaunchDialogManagerId(null); setNewTrainerDatasets([]); setLocalModelWeights(null); setSelectedWeightsPath(null); setIsWeightsDropdownOpen(false); }} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Tabs */}
            <div className="flex border-b border-gray-100">
              {(['orchestrator', 'trainer'] as const).map(tab => (
                <button key={tab} onClick={async () => {
                  setLaunchDialogTab(tab);
                  if (tab === 'trainer' && localModelWeights === null && launchDialogManagerId) {
                    const mgr = managers.find(m => m.serviceId === launchDialogManagerId);
                    if (mgr?.service) {
                      setIsLoadingLocalWeights(true);
                      try { setLocalModelWeights(await mgr.service.list_local_model_weights()); } catch { setLocalModelWeights([]); }
                      setIsLoadingLocalWeights(false);
                    }
                  }
                }} className={`flex-1 py-3 text-sm font-medium transition-colors capitalize ${launchDialogTab === tab ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>
                  {tab === 'orchestrator' ? '🎭 Orchestrator' : '🏋 Trainer'}
                </button>
              ))}
            </div>
            <div className="p-6 overflow-y-auto flex-1">
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
                  {/* Pretrained weights selection */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">Pretrained weights <span className="text-gray-400 font-normal">(optional)</span></label>
                    {isLoadingLocalWeights ? (
                      <div className="flex items-center gap-2 text-xs text-gray-400 py-2"><BiLoaderAlt className="animate-spin" size={12} /> Loading saved weights…</div>
                    ) : localModelWeights === null ? (
                      <p className="text-xs text-gray-400">Switch to Trainer tab to load available weights.</p>
                    ) : (() => {
                      const selected = localModelWeights.find(w => w.path === selectedWeightsPath);
                      const selectedDatasets = selected ? Object.values(selected.datasets).map((d: any) => d.name || '').filter(Boolean) : [];
                      const selectedDate = selected?.saved_at ? new Date(selected.saved_at).toLocaleDateString() : null;
                      return (
                        <div>
                          <button
                            type="button"
                            onClick={() => setIsWeightsDropdownOpen(o => !o)}
                            className="w-full text-left px-3 py-2 border border-gray-200 rounded-lg bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors relative"
                          >
                            {selected ? (
                              <div className="pr-5">
                                <p className="text-sm text-gray-800">{selectedDate && <span className="mr-1.5">{selectedDate}</span>}{selectedDatasets.join(', ')}{(selected.num_rounds > 0 || selected.total_samples_seen > 0) && <span className="text-gray-500"> · {selected.num_rounds} round{selected.num_rounds !== 1 ? 's' : ''}, {selected.total_samples_seen.toLocaleString()} samples seen</span>}</p>
                                <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{selected.client_name}</p>
                              </div>
                            ) : (
                              <span className="text-sm text-gray-500 pr-5">Start fresh (no pretrained weights)</span>
                            )}
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">{isWeightsDropdownOpen ? '▴' : '▾'}</span>
                          </button>
                          {isWeightsDropdownOpen && (
                            <div className="mt-1 border border-gray-200 rounded-lg overflow-hidden">
                              <div className="max-h-48 overflow-y-auto divide-y divide-gray-50" onWheel={e => e.stopPropagation()}>
                                <button type="button" onClick={() => { setSelectedWeightsPath(null); setIsWeightsDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedWeightsPath === null ? 'bg-emerald-50' : ''}`}>
                                  <span className="text-sm text-gray-700">Start fresh</span>
                                </button>
                                {localModelWeights.length === 0 && (
                                  <p className="text-xs text-gray-400 text-center py-3 px-3">No saved weights on this worker yet.</p>
                                )}
                                {localModelWeights.map(w => {
                                  const names = Object.values(w.datasets).map((d: any) => d.name || '').filter(Boolean);
                                  const date = w.saved_at ? new Date(w.saved_at).toLocaleDateString() : null;
                                  return (
                                    <button key={w.path} type="button"
                                      onClick={() => { setSelectedWeightsPath(w.path); setIsWeightsDropdownOpen(false); }}
                                      className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedWeightsPath === w.path ? 'bg-emerald-50' : ''}`}>
                                      <p className="text-sm text-gray-800">{date && <span className="mr-1.5">{date}</span>}{names.join(', ')}</p>
                                      <p className="text-xs text-gray-500 mt-0.5">{w.num_rounds > 0 || w.total_samples_seen > 0 ? `${w.num_rounds} round${w.num_rounds !== 1 ? 's' : ''} · ${w.total_samples_seen.toLocaleString()} samples seen` : 'No training history'}</p>
                                      <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{w.client_name}</p>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
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
            <div className="px-6 pb-5 flex-shrink-0 flex flex-col gap-2">
              {errorPopupDashboardUrl && (
                <a href={errorPopupDashboardUrl} target="_blank" rel="noopener noreferrer"
                  className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 transition-colors text-center block">
                  Open BioEngine Dashboard
                </a>
              )}
              <button onClick={() => { setShowErrorPopup(false); setErrorPopupMessage(''); setErrorPopupDetails(''); setErrorPopupDashboardUrl(null); }} className="w-full py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-700 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== APP LOGS MODAL ====== */}
      {showAppLogsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={e => { if (e.target === e.currentTarget) setShowAppLogsModal(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <div>
                <p className="font-semibold text-gray-900 text-sm">{appLogsLabel}</p>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{appLogsAppId}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openAppLogsModal(appLogsManagerId, appLogsAppId, appLogsLabel)}
                  disabled={appLogsLoading}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 transition-colors disabled:opacity-40"
                  title="Refresh logs">
                  <svg xmlns="http://www.w3.org/2000/svg" className={`w-3.5 h-3.5 ${appLogsLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh
                </button>
                <button onClick={() => setShowAppLogsModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors" title="Close">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {appLogsLoading && <div className="flex items-center justify-center py-12 text-gray-400 text-sm gap-2"><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Loading logs…</div>}
              {!appLogsLoading && appLogsData?.error && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-700 font-mono">{appLogsData.error}</div>
              )}
              {!appLogsLoading && appLogsData && !appLogsData.error && (() => {
                const appStatus = appLogsData.status;
                const appMessage = appLogsData.message;
                const deployments: Record<string, any> = appLogsData.deployments || {};
                return (
                  <>
                    {/* Application-level status + message */}
                    <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Application</span>
                        {appStatus && <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${appStatus === 'RUNNING' ? 'bg-emerald-100 text-emerald-700' : appStatus === 'DEPLOY_FAILED' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{appStatus}</span>}
                      </div>
                      {appMessage ? <p className="text-xs font-mono text-gray-700 whitespace-pre-wrap">{appMessage}</p> : <p className="text-xs text-gray-400 italic">No application message</p>}
                    </div>
                    {/* Per-deployment sections */}
                    {Object.entries(deployments).map(([deployName, dep]: [string, any]) => {
                      const logs: Record<string, string[]> = dep.logs || {};
                      const allLines = Object.values(logs).flat();
                      return (
                        <div key={deployName} className="border border-gray-100 rounded-xl overflow-hidden">
                          <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                            <span className="text-xs font-semibold text-gray-700">{deployName}</span>
                            {dep.status && <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${dep.status === 'HEALTHY' ? 'bg-emerald-100 text-emerald-700' : dep.status === 'UNHEALTHY' || dep.status === 'DEPLOY_FAILED' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{dep.status}</span>}
                          </div>
                          {dep.message && <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs font-mono text-amber-800 whitespace-pre-wrap">{dep.message}</div>}
                          <pre className="text-xs font-mono text-gray-700 bg-gray-950 text-green-300 p-4 overflow-x-auto max-h-64 overflow-y-auto leading-relaxed">{allLines.length > 0 ? allLines.join('\n') : '(no log output)'}</pre>
                        </div>
                      );
                    })}
                    {Object.keys(deployments).length === 0 && <p className="text-sm text-gray-400 text-center py-6">No deployment information available</p>}
                  </>
                );
              })()}
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
