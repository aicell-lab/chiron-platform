import React, { useState, useEffect, useCallback } from 'react';
import { FaChevronDown, FaChevronRight } from 'react-icons/fa';

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
}

interface ArtifactEntry {
  id: string;
  alias: string;
  manifest: { name?: string; model_type?: string; num_rounds?: number; datasets?: {name: string}[] };
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
  }) => void;
  isPreparingTraining: boolean;
  isTraining: boolean;
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
  onConfigChange,
}) => {

  // Top-level parameters
  const [numRounds, setNumRounds] = useState(5);
  const [perRoundTimeoutMinutes, setPerRoundTimeoutMinutes] = useState(20);

  // Pretrained weights
  const [usePretrainedWeights, setUsePretrainedWeights] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>('');
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

  // Fetch global transformer weight artifacts from chiron-models collection
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
      const globalWeights = (result || []).filter(
        (a: ArtifactEntry) => a.manifest?.model_type === 'global_transformer'
      );
      setArtifacts(globalWeights);
      if (globalWeights.length > 0) {
        setSelectedArtifactId(globalWeights[0].id);
      }
    } catch (e: any) {
      console.error('Failed to load global transformer weights:', e);
      setArtifactsError('Failed to load global transformer weights');
    } finally {
      setArtifactsLoading(false);
    }
  }, [artifactManager]);

  useEffect(() => {
    if (usePretrainedWeights) fetchArtifacts();
  }, [usePretrainedWeights]); // eslint-disable-line react-hooks/exhaustive-deps

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
      </div>

      {/* Pretrained weights */}
      <div className="mb-5 pb-5 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700">Start from Pretrained Weights</label>
            <p className="text-xs text-gray-400 mt-0.5">Load published transformer weights as the starting point before round 1.</p>
          </div>
          <button
            type="button"
            onClick={() => setUsePretrainedWeights(v => !v)}
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
              <p className="text-xs text-gray-400 italic">No global transformer weights in chiron-models yet</p>
            ) : (
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Checkpoint</label>
                <select
                  value={selectedArtifactId}
                  onChange={e => setSelectedArtifactId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {artifacts.map(a => {
                    const datasets = a.manifest?.datasets?.map(d => d.name).join(', ') || '';
                    const rounds = a.manifest?.num_rounds;
                    const label = a.manifest?.name || a.alias || a.id;
                    const sub = [rounds ? `${rounds} rounds` : '', datasets].filter(Boolean).join(' · ');
                    return (
                      <option key={a.id} value={a.id}>
                        {label}{sub ? ` - ${sub}` : ''}
                      </option>
                    );
                  })}
                </select>
                <p className="text-xs text-gray-400 mt-1">Loads model.pth from the selected artifact</p>
              </div>
            )}
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
    </div>
  );
};

export default TrainingConfigPanel;
