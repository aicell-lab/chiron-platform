import React, { useState, useEffect } from 'react';
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

interface TrainingConfigPanelProps {
  params: TrainerParams | null;
  loading: boolean;
  error: string | null;
  onStart: (config: {
    num_rounds: number;
    fit_config: Record<string, any>;
    eval_config: Record<string, any>;
    per_round_timeout: number;
  }) => void;
  isPreparingTraining: boolean;
  isTraining: boolean;
}

const TrainingConfigPanel: React.FC<TrainingConfigPanelProps> = ({
  params,
  loading,
  error,
  onStart,
  isPreparingTraining,
  isTraining,
}) => {
  
  // Top-level parameters
  const [numRounds, setNumRounds] = useState(5);
  const [perRoundTimeout, setPerRoundTimeout] = useState(600);
  
  // Parameter values
  const [fitValues, setFitValues] = useState<Record<string, any>>({});
  const [evalValues, setEvalValues] = useState<Record<string, any>>({});
  
  // Accordion state
  const [fitAdvancedExpanded, setFitAdvancedExpanded] = useState(false);
  const [evalAdvancedExpanded, setEvalAdvancedExpanded] = useState(false);

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
      <div key={key} className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
        </label>
        <p className="text-xs text-gray-500 mb-2">{config.description}</p>
        
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
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : config.type === 'number' ? (
          <input
            type="number"
            step="any"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <input
            type="text"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
        <div className="mb-6">
          <h4 className="text-lg font-semibold mb-3">{title}</h4>
          <p className="text-sm text-gray-500 italic">No parameters to configure</p>
        </div>
      );
    }

    const hasStandard = section.standard && Object.keys(section.standard).length > 0;
    const hasAdvanced = section.advanced && Object.keys(section.advanced).length > 0;

    return (
      <div className="mb-6">
        <h4 className="text-lg font-semibold mb-3">{title}</h4>
        
        {/* Standard parameters */}
        {hasStandard ? (
          <div className="mb-4">
            {Object.entries(section.standard).map(([key, config]) =>
              renderInput(key, config, values[key], onChange)
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500 italic mb-4">No standard parameters to configure</p>
        )}
        
        {/* Advanced parameters */}
        {hasAdvanced && (
          <div className="border-t border-gray-200 pt-4">
            <button
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              className="flex items-center text-sm font-medium text-gray-700 hover:text-gray-900 mb-3"
            >
              {advancedExpanded ? (
                <FaChevronDown className="mr-2" />
              ) : (
                <FaChevronRight className="mr-2" />
              )}
              Advanced Parameters
            </button>
            
            {advancedExpanded && (
              <div className="ml-4 pl-4 border-l-2 border-gray-200">
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
      per_round_timeout: perRoundTimeout,
    });
  };

  if (loading) {
    return (
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-xl font-semibold mb-4">Start Federated Training</h3>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">Loading parameters...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-xl font-semibold mb-4">Start Federated Training</h3>
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-red-800">Failed to load training parameters: {error}</p>
        </div>
      </div>
    );
  }

  // Show message when no params are available (no trainers selected)
  if (!params) {
    return (
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-xl font-semibold mb-4">Start Federated Training</h3>
        <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
          <p className="text-blue-800">Please select at least one trainer to configure training parameters.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <h3 className="text-xl font-semibold mb-4">Start Federated Training</h3>
      
      {/* Top-level parameters */}
      <div className="mb-6 pb-6 border-b border-gray-200">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Number of Rounds
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={numRounds}
              onChange={(e) => setNumRounds(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Per Round Timeout (seconds)
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={perRoundTimeout}
              onChange={(e) => setPerRoundTimeout(parseInt(e.target.value, 10) || 600)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
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
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center"
      >
        {isPreparingTraining ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
            Preparing Training...
          </>
        ) : (
          'Start Training'
        )}
      </button>
    </div>
  );
};

export default TrainingConfigPanel;
