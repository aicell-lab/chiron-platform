import React, { useState, useEffect, useCallback } from 'react';
import { FaChevronDown, FaChevronRight } from 'react-icons/fa';
import { DEFAULT_MODEL_FAMILY, getChironModel } from '../../config/chironModels';
import InfoPopover from '../BioEngine/InfoPopover';
import {
  WeightTransport,
  WEIGHT_TRANSPORT_LABELS,
  readWeightTransport,
  storeWeightTransport,
} from '../../config/federation';

interface ParamConfig {
  type: string;
  default: any;
  description: string;
}

interface ParamSection {
  standard: Record<string, ParamConfig>;
  advanced: Record<string, ParamConfig>;
}

interface TrainerParams {
  fit: ParamSection;
  evaluate: ParamSection;
  /**
   * Which model the parameters above belong to, reported by chiron-orchestrator
   * 0.3.17 from the registered trainer's own properties. Absent when an older
   * orchestrator answers, in which case the panel simply names no model rather
   * than assuming one.
   */
  model?: {
    family: string;
    display_name: string;
    /** Prose description of the federated subset of the state dict, e.g.
     *  "the shared transformer trunk". Written by the trainer, not by a table
     *  in the frontend. */
    shared_weight_scope: string;
  };
}

interface ArtifactEntry {
  id: string;
  alias: string;
  manifest: {
    name?: string;
    global_transformer?: boolean;
    tissue?: string;
    num_rounds?: number;
    datasets?: {name: string}[];
    /** Family the checkpoint belongs to. Written by the orchestrator since
     *  0.3.x. Checkpoints published before that are all Tabula. */
    model_family?: string;
  };
}

interface TrainingConfigPanelProps {
  params: TrainerParams | null;
  loading: boolean;
  error: string | null;
  artifactManager: any;
  onStart: (config: {
    num_rounds: number;
    fit_config: Record<string, any>;
    eval_config: Record<string, any>;
    per_round_timeout: number;
    initial_weights: { artifact_id: string; file_path: string } | null;
    /** Which transport carries the weight blobs for this run. Chosen per run,
     *  not per deployment: the same orchestrator and trainers serve both. */
    transport: WeightTransport;
  }) => void;
  isPreparingTraining: boolean;
  isTraining: boolean;
  /** True when the selected orchestrator already has training history.
   *  Pretrained-weights default flips OFF in that case (loading a new
   *  checkpoint would overwrite the in-memory FedAvg state). Enabling it
   *  anyway pops a confirmation dialog. */
  hasHistory?: boolean;
  onConfigChange?: (numRounds: number, perRoundTimeoutMinutes: number) => void;
}

const CHIRON_MODELS_COLLECTION = 'chiron-platform/chiron-models';

const TrainingConfigPanel: React.FC<TrainingConfigPanelProps> = ({
  params,
  loading,
  error,
  artifactManager,
  onStart,
  isPreparingTraining,
  isTraining,
  hasHistory,
  onConfigChange,
}) => {

  // The model these parameters belong to. Everything model-specific in this
  // panel (its title, the checkpoint list, the wording of what gets federated)
  // reads from here rather than naming a model in the markup.
  const model = params?.model;
  const modelFamily = model?.family;

  // Top-level parameters
  const [numRounds, setNumRounds] = useState(5);
  const [perRoundTimeoutMinutes, setPerRoundTimeoutMinutes] = useState(20);
  const [transport, setTransport] = useState<WeightTransport>(readWeightTransport);

  // Pretrained weights — defaults ON for a fresh orchestrator, OFF when
  // history already exists (loading new pretrained weights would clobber
  // the previously trained shared transformer). The user can still flip it
  // back on; that path pops a confirmation dialog.
  const [usePretrainedWeights, setUsePretrainedWeights] = useState(!hasHistory);
  // Initial flip when the parent first reports has-history (e.g. user just
  // selected an orchestrator that already has rounds).
  useEffect(() => {
    setUsePretrainedWeights(prev => (hasHistory ? false : prev));
  }, [hasHistory]);
  const [showOverwriteWarning, setShowOverwriteWarning] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>('');
  const [isCheckpointDropdownOpen, setIsCheckpointDropdownOpen] = useState(false);
  const [weightFiles, setWeightFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');

  // Parameter values
  const [fitValues, setFitValues] = useState<Record<string, any>>({});
  const [evalValues, setEvalValues] = useState<Record<string, any>>({});

  // Accordion state
  const [fitAdvancedExpanded, setFitAdvancedExpanded] = useState(false);
  const [evalAdvancedExpanded, setEvalAdvancedExpanded] = useState(false);

  // Notify parent of config changes for header display
  useEffect(() => {
    onConfigChange?.(numRounds, perRoundTimeoutMinutes);
  }, [numRounds, perRoundTimeoutMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch every chiron-models checkpoint — at training start, the orchestrator
  // broadcasts the selected weights as the initial shared state to every
  // trainer. Both full models (global_transformer=false) and shared-weights
  // FedAvg saves (global_transformer=true) are valid here, as long as they
  // belong to the model this federation is training.
  const fetchArtifacts = useCallback(async () => {
    if (!artifactManager) return;
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const result = await artifactManager.list({
        parent_id: CHIRON_MODELS_COLLECTION,
        limit: 100,
        _rkwargs: true,
      });
      // A checkpoint only loads into the model it was trained for, so the list
      // is restricted to this federation's family. Checkpoints published
      // before the orchestrator wrote model_family are all Tabula, and an
      // orchestrator too old to report a model is training Tabula too.
      const family = modelFamily || DEFAULT_MODEL_FAMILY;
      const familyOf = (a: ArtifactEntry) =>
        a.manifest?.model_family || DEFAULT_MODEL_FAMILY;
      // Surface the model's foundation checkpoint (its generalist multi-tissue
      // release) first so it's the default Start-from-Pretrained-Weights
      // selection. Tissue-specific full models and shared-weights-only saves
      // come after, each group sorted alphabetically by manifest name for
      // predictability.
      const foundationAlias = getChironModel(family)?.foundationAlias;
      const isFoundation = (a: ArtifactEntry) =>
        !!foundationAlias &&
        (a.alias || a.id.split('/').pop() || '').toLowerCase() === foundationAlias;
      const byName = (a: ArtifactEntry, b: ArtifactEntry) =>
        (a.manifest?.name || a.alias || a.id).localeCompare(b.manifest?.name || b.alias || b.id);
      const all = ((result || []) as ArtifactEntry[]).filter(a => familyOf(a) === family);
      const foundation = all.filter(isFoundation);
      const others = all.filter(a => !isFoundation(a)).sort(byName);
      const checkpoints = [...foundation, ...others];
      setArtifacts(checkpoints);
      // Clear the selection when the new list is empty, otherwise a checkpoint
      // picked for a different model would still be sent to start_training.
      setSelectedArtifactId(checkpoints.length > 0 ? checkpoints[0].id : '');
    } catch (e: any) {
      console.error('Failed to load pretrained checkpoints:', e);
      setArtifactsError('Failed to load pretrained checkpoints');
    } finally {
      setArtifactsLoading(false);
    }
  }, [artifactManager, modelFamily]);

  useEffect(() => {
    if (usePretrainedWeights) fetchArtifacts();
  }, [usePretrainedWeights, modelFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global transformer weight artifacts always use model.pth — no file picker needed.

  // Initialize values with defaults when params change
  useEffect(() => {
    if (!params) return;
    
    const initialFitValues: Record<string, any> = {};
    const initialEvalValues: Record<string, any> = {};
    
    // Set fit defaults
    if (params.fit?.standard) {
      Object.entries(params.fit.standard).forEach(([key, config]) => {
        initialFitValues[key] = config.default;
      });
    }
    if (params.fit?.advanced) {
      Object.entries(params.fit.advanced).forEach(([key, config]) => {
        initialFitValues[key] = config.default;
      });
    }
    
    // Set evaluate defaults
    if (params.evaluate?.standard) {
      Object.entries(params.evaluate.standard).forEach(([key, config]) => {
        initialEvalValues[key] = config.default;
      });
    }
    if (params.evaluate?.advanced) {
      Object.entries(params.evaluate.advanced).forEach(([key, config]) => {
        initialEvalValues[key] = config.default;
      });
    }
    
    setFitValues(initialFitValues);
    setEvalValues(initialEvalValues);
  }, [params]);

  // Render input field based on parameter type
  const renderInput = (
    key: string,
    config: ParamConfig,
    value: any,
    onChange: (key: string, value: any) => void
  ) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let newValue: any = e.target.value;
      
      // Type conversion based on parameter type
      if (config.type === 'integer') {
        newValue = newValue === '' ? null : parseInt(newValue, 10);
      } else if (config.type === 'number') {
        newValue = newValue === '' ? null : parseFloat(newValue);
      } else if (config.type === 'boolean') {
        newValue = e.target.checked;
      }
      // For 'str' or other types, keep as string (but allow null)
      else if (newValue === '') {
        newValue = null;
      }
      
      onChange(key, newValue);
    };

    const inputValue = value === null || value === undefined ? '' : value;

    return (
      <div key={key} className="mb-3">
        <label className="block text-xs font-semibold text-gray-700 mb-0.5">
          {key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
        </label>
        <p className="text-xs text-gray-400 mb-1.5">{config.description}</p>
        
        {config.type === 'boolean' ? (
          <input
            type="checkbox"
            checked={value ?? config.default ?? false}
            onChange={handleChange}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          />
        ) : config.type === 'integer' ? (
          <input
            type="number"
            step="1"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : config.type === 'number' ? (
          <input
            type="number"
            step="any"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <input
            type="text"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
      </div>
    );
  };

  // Render parameter section
  const renderSection = (
    title: string,
    section: ParamSection | undefined,
    values: Record<string, any>,
    onChange: (key: string, value: any) => void,
    advancedExpanded: boolean,
    setAdvancedExpanded: (expanded: boolean) => void
  ) => {
    if (!section) {
      return (
        <div className="mb-5">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h4>
          <p className="text-xs text-gray-400 italic">No parameters to configure</p>
        </div>
      );
    }

    const hasStandard = section.standard && Object.keys(section.standard).length > 0;
    const hasAdvanced = section.advanced && Object.keys(section.advanced).length > 0;

    return (
      <div className="mb-5">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h4>

        {hasStandard ? (
          <div className="mb-3">
            {Object.entries(section.standard).map(([key, config]) =>
              renderInput(key, config, values[key], onChange)
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-400 italic mb-3">No standard parameters to configure</p>
        )}

        {hasAdvanced && (
          <div className="border-t border-gray-100 pt-3">
            <button
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 mb-3 transition-colors"
            >
              {advancedExpanded ? <FaChevronDown size={10} /> : <FaChevronRight size={10} />}
              Advanced Parameters
            </button>

            {advancedExpanded && (
              <div className="ml-3 pl-3 border-l-2 border-gray-100">
                {Object.entries(section.advanced).map(([key, config]) =>
                  renderInput(key, config, values[key], onChange)
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const handleUpdateFitValue = (key: string, value: any) => {
    setFitValues(prev => ({ ...prev, [key]: value }));
  };

  const handleUpdateEvalValue = (key: string, value: any) => {
    setEvalValues(prev => ({ ...prev, [key]: value }));
  };

  const handleStartTraining = () => {
    // Filter out null values from configs
    const fit_config: Record<string, any> = {};
    const eval_config: Record<string, any> = {};
    
    Object.entries(fitValues).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        fit_config[key] = value;
      }
    });
    
    Object.entries(evalValues).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        eval_config[key] = value;
      }
    });

    onStart({
      num_rounds: numRounds,
      fit_config,
      eval_config,
      per_round_timeout: perRoundTimeoutMinutes * 60,
      transport,
      initial_weights: usePretrainedWeights && selectedArtifactId
        ? { artifact_id: selectedArtifactId, file_path: 'model.pth' }
        : null,
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading parameters...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <p className="text-red-800">Failed to load training parameters: {error}</p>
      </div>
    );
  }

  // Show message when no params are available (no trainers selected)
  if (!params) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
        <p className="text-blue-800">Please select at least one trainer to configure training parameters.</p>
      </div>
    );
  }

  return (
    <div>

      {/* Which model these parameters belong to. The lists below are read from
          the registered trainer's own schema, so without this line a user
          reading them has no way to tell whose parameters they are. */}
      {model && (
        <div className="mb-5 pb-4 border-b border-gray-100 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
            {model.display_name}
          </span>
          <p className="text-xs text-gray-400">
            Parameters below are declared by this federation's {model.display_name} trainer.
            Each round federates the weights under{' '}
            <code className="text-gray-500">{model.shared_weight_scope}</code>.
          </p>
        </div>
      )}

      {/* Top-level parameters */}
      <div className="mb-5 pb-5 border-b border-gray-100">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-0.5">Number of Rounds</label>
            <input
              type="number"
              min="1"
              step="1"
              value={numRounds}
              onChange={(e) => setNumRounds(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-400">All clients train locally, then the server aggregates (FedAvg).</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-0.5">Per Round Timeout (minutes)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={perRoundTimeoutMinutes}
              onChange={(e) => setPerRoundTimeoutMinutes(parseInt(e.target.value, 10) || 20)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-400">Maximum time for fit + evaluate per round. Aborts if exceeded.</p>
          </div>
        </div>

        {/* Weight transport. A run-level choice rather than a deployment one:
            the same orchestrator and trainers serve both, so switching costs a
            restart of the run and nothing else. Peer-to-peer is the normal
            path and covers restrictive networks through the TURN relay, so
            this switch exists for the residual case where even the relay is
            unreachable and the operator needs a way through without waiting
            for anyone.

            Presented as a single on/off switch rather than a pair of
            transport names. The operator's decision is whether weights
            should avoid the server, which is a privacy question they can
            answer; 'WebSocket vs WebRTC' asks them to translate that into
            protocol names first. The names still appear in the popover, so
            anyone matching this against a log or the orchestrator API can
            find them. */}
        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <label className="block text-xs font-semibold text-gray-700">Peer-to-Peer Weight Transfer</label>
              <InfoPopover label="About peer-to-peer weight transfer">
                <p className="font-semibold text-gray-800 mb-1">Peer-to-peer (WebRTC)</p>
                <p>{WEIGHT_TRANSPORT_LABELS.webrtc.hint}</p>
                <p className="mt-1">
                  A direct path is used where the network allows one. Where it does not, a TURN
                  relay forwards the encrypted packets without being able to read them, so a
                  relayed run is exactly as private as a direct one.
                </p>
                <p className="mt-1">
                  There is no automatic fallback to the server. If even the relay cannot connect,
                  the trainer sits out that round rather than quietly sending its weights through
                  the server. Turning this off is the way through a network that blocks all of it.
                </p>
                <p className="font-semibold text-gray-800 mt-3 mb-1">Off: through the server (WebSocket)</p>
                <p>{WEIGHT_TRANSPORT_LABELS.websocket.hint}</p>
                <p className="mt-3 text-gray-500">
                  Either way, only model weights and scalar metrics ever leave a site. Raw data
                  never does.
                </p>
              </InfoPopover>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {transport === 'webrtc'
                ? 'Weights travel encrypted between sites and no server can read them. Falls back to an encrypted relay where the network blocks a direct path.'
                : 'Weights pass through the Hypha server, which can read them. Use this only where peer-to-peer cannot connect at all.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={transport === 'webrtc'}
            aria-label="Peer-to-peer weight transfer"
            onClick={() => {
              const next: WeightTransport = transport === 'webrtc' ? 'websocket' : 'webrtc';
              setTransport(next);
              storeWeightTransport(next);
            }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${transport === 'webrtc' ? 'bg-emerald-500' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${transport === 'webrtc' ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {/* Pretrained weights */}
      <div className="mb-5 pb-5 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-1.5">
              <label className="block text-xs font-semibold text-gray-700">Start from Pretrained Weights</label>
              <InfoPopover label="About starting from pretrained weights">
                <p>
                  Broadcasts only the shared weights
                  {model?.shared_weight_scope && (
                    <> (<code className="text-gray-500">{model.shared_weight_scope}</code>)</>
                  )}{' '}from
                  the selected checkpoint to every trainer before round 1. Each
                  trainer's site-local components stay local: they are not
                  overwritten.
                </p>
                {hasHistory && (
                  <p className="mt-2">
                    This orchestrator already has training history. Enabling this
                    also resets that history, so the next run starts from scratch.
                  </p>
                )}
              </InfoPopover>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Initialise every trainer from a published checkpoint instead of
              starting from scratch.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              // Turning ON when history exists would overwrite the
              // already-trained transformer at the start of the next run;
              // surface a confirmation first.
              if (!usePretrainedWeights && hasHistory) {
                setShowOverwriteWarning(true);
                return;
              }
              setUsePretrainedWeights(v => !v);
            }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${usePretrainedWeights ? 'bg-emerald-500' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${usePretrainedWeights ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
        {usePretrainedWeights && (
          <div className="space-y-3 mt-3">
            {artifactsLoading ? (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-400" />
                Loading checkpoints…
              </div>
            ) : artifactsError ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-red-500">{artifactsError}</p>
                <button onClick={fetchArtifacts} className="text-xs text-blue-600 hover:underline">Retry</button>
              </div>
            ) : artifacts.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                No published {model?.display_name ? `${model.display_name} ` : ''}checkpoints in chiron-models yet
              </p>
            ) : (() => {
              const selected = artifacts.find(a => a.id === selectedArtifactId);
              const fullModels = artifacts.filter(a => a.manifest?.global_transformer !== true);
              const globalTransformers = artifacts.filter(a => a.manifest?.global_transformer === true);
              const fmt = (a: ArtifactEntry) => {
                const datasets = a.manifest?.datasets?.map(d => d.name).join(', ') || '';
                const rounds = a.manifest?.num_rounds;
                return [rounds ? `${rounds} rounds` : '', datasets].filter(Boolean).join(' · ');
              };
              return (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Checkpoint</label>
                  <button
                    type="button"
                    onClick={() => setIsCheckpointDropdownOpen(o => !o)}
                    className="w-full text-left px-3 py-2 border border-gray-200 rounded-lg bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors relative"
                  >
                    {selected ? (
                      <div className="pr-5">
                        <p className="text-sm text-gray-800">{selected.manifest?.name || selected.alias || selected.id}</p>
                        {fmt(selected) && <p className="text-xs text-gray-500 mt-0.5">{fmt(selected)}</p>}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-500 pr-5">Select a checkpoint…</span>
                    )}
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">{isCheckpointDropdownOpen ? '▴' : '▾'}</span>
                  </button>
                  {isCheckpointDropdownOpen && (
                    <div className="mt-1 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="max-h-64 overflow-y-auto divide-y divide-gray-50" onWheel={e => e.stopPropagation()}>
                        {fullModels.length > 0 && (
                          <>
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">Full Tabula Models</div>
                            {fullModels.map(a => {
                              const label = a.manifest?.name || a.alias || a.id;
                              const sub = fmt(a);
                              return (
                                <button key={a.id} type="button"
                                  onClick={() => { setSelectedArtifactId(a.id); setIsCheckpointDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedArtifactId === a.id ? 'bg-emerald-50' : ''}`}>
                                  <p className="text-sm text-gray-800">{label}</p>
                                  {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
                                </button>
                              );
                            })}
                          </>
                        )}
                        {globalTransformers.length > 0 && (
                          <>
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">Global Transformer Checkpoints</div>
                            {globalTransformers.map(a => {
                              const label = a.manifest?.name || a.alias || a.id;
                              const sub = fmt(a);
                              return (
                                <button key={a.id} type="button"
                                  onClick={() => { setSelectedArtifactId(a.id); setIsCheckpointDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedArtifactId === a.id ? 'bg-emerald-50' : ''}`}>
                                  <p className="text-sm text-gray-800">{label}</p>
                                  {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
                                </button>
                              );
                            })}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Fit parameters */}
      {renderSection(
        'Fit Configuration',
        params?.fit,
        fitValues,
        handleUpdateFitValue,
        fitAdvancedExpanded,
        setFitAdvancedExpanded
      )}

      {/* Evaluate parameters */}
      {renderSection(
        'Evaluate Configuration',
        params?.evaluate,
        evalValues,
        handleUpdateEvalValue,
        evalAdvancedExpanded,
        setEvalAdvancedExpanded
      )}

      {/* Start button */}
      <button
        onClick={handleStartTraining}
        disabled={isPreparingTraining || isTraining}
        className="w-full bg-emerald-600 text-white px-4 py-3 rounded-xl hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold text-sm shadow-sm transition-all"
      >
        {isPreparingTraining ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            Preparing Training...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            Start Training · {numRounds} round{numRounds !== 1 ? 's' : ''} · {perRoundTimeoutMinutes} min timeout
          </>
        )}
      </button>

      {showOverwriteWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-amber-50 flex items-center gap-3">
              <svg className="w-6 h-6 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="font-semibold text-gray-900">Overwrite trained weights and reset history?</h3>
            </div>
            <div className="px-6 py-4 text-sm text-gray-600 space-y-2">
              <p>
                This orchestrator already has training history. Enabling
                "Start from Pretrained Weights" will:
              </p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>
                  Overwrite the previously trained shared weights with the
                  selected checkpoint before round 1.
                </li>
                <li>
                  Reset the orchestrator's training history (per-round
                  losses, round counter, run metadata) so the next run
                  starts from scratch.
                </li>
              </ul>
              <p>
                Each trainer's site-local components stay local. Only the
                shared weights
                {model?.shared_weight_scope && (
                  <> (<code className="text-gray-500">{model.shared_weight_scope}</code>)</>
                )}{' '}are
                replaced. Trainers' on-disk weight checkpoints are not
                touched either.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                onClick={() => setShowOverwriteWarning(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setUsePretrainedWeights(true); setShowOverwriteWarning(false); }}
                className="px-4 py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors"
              >
                Overwrite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TrainingConfigPanel;
