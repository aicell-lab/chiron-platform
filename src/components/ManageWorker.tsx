import React, { useState, useEffect } from 'react';
import { useLocation, useParams, useNavigate, Link } from 'react-router-dom';
import { TextField, Button, Select, MenuItem, FormControl, InputLabel, Chip, Autocomplete, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Box, Alert } from '@mui/material';
import PublishIcon from '@mui/icons-material/Publish';
import { useHyphaStore } from '../store/hyphaStore';
import { ClipboardIcon, CheckIcon, InformationCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { RiLoginBoxLine } from 'react-icons/ri';

interface WorkerInfo {
  type: 'worker';
  name: string;
  description: string;
  id?: string;
  version?: string;
  versions?: string[];
  allowed_models?: string[];
  allowed_users?: string[];
}

interface Dataset {
  name: string;
  description?: string;
  manifest?: any;
}

interface RunningModel {
  client_id: string;
  pid: number;
  status: string;
  cpu_percent: number;
  memory_rss: number;
  memory_vms: number;
}

interface RunningOrchestrator {
  orchestrator_id: string;
  pid: number;
  status: string;
  cpu_percent: number;
  memory_rss: number;
  memory_vms: number;
}

interface PublishData {
  version?: string;
  comment: string;
}

const ManageWorker: React.FC = () => {
  const { artifactId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { server, isLoggedIn, user, artifactManager } = useHyphaStore();
  const [workerInfo, setWorkerInfo] = useState<WorkerInfo>(
    location.state?.workerInfo || {
      type: 'worker',
      name: '',
      description: '',
      version: '0.1.0'
    }
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [expiresIn, setExpiresIn] = useState<string>('3600'); // 1 hour default
  const [permission, setPermission] = useState<'read' | 'read_write' | 'admin'>('read');
  const [workerManager, setWorkerManager] = useState<any>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [runningModels, setRunningModels] = useState<RunningModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [runningOrchestrators, setRunningOrchestrators] = useState<RunningOrchestrator[]>([]);
  const [loadingOrchestrators, setLoadingOrchestrators] = useState(false);
  const [allowedModels, setAllowedModels] = useState<{id: string}[]>([]);
  const [loadingAllowedModels, setLoadingAllowedModels] = useState(false);
  const [allowedUsers, setAllowedUsers] = useState<{id: string}[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{text: string, type: 'success' | 'error'} | null>(null);
  const [modelInputValue, setModelInputValue] = useState<string>('');
  const [userInputValue, setUserInputValue] = useState<string>('');
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishData, setPublishData] = useState<PublishData>({
    version: '',
    comment: ''
  });
  const [uploadStatus, setUploadStatus] = useState<{
    message: string;
    severity: 'info' | 'success' | 'error';
  } | null>(null);

  useEffect(() => {
    if (isLoggedIn && server && workerInfo.id) {
      initializeWorkerManager();
    }
  }, [server, workerInfo.id, isLoggedIn]);

  const initializeWorkerManager = async () => {
    try {
      const workerId = workerInfo.id?.split('/')[1];
      if (!workerId) return;
      
      const manager = await server.getService(workerId);
      setWorkerManager(manager);
      
      // Load initial data
      loadDatasets();
      loadRunningModels();
      loadRunningOrchestrators();
      loadAllowedModels();
    } catch (error) {
      console.error('Failed to initialize worker manager:', error);
    }
  };

  const loadDatasets = async () => {
    if (!workerManager) return;
    
    try {
      setLoadingDatasets(true);
      const response = await workerManager.list_datasets({
        offset: 0,
        limit: 100,
        _rkwargs: true
      });
      setDatasets(response.items || []);
    } catch (error) {
      console.error('Failed to load datasets:', error);
    } finally {
      setLoadingDatasets(false);
    }
  };

  const loadRunningModels = async () => {
    if (!workerManager) return;
    
    try {
      setLoadingModels(true);
      const models = await workerManager.list_loaded_models({
        _rkwargs: true
      });
      setRunningModels(models);
    } catch (error) {
      console.error('Failed to load running models:', error);
    } finally {
      setLoadingModels(false);
    }
  };

  const loadRunningOrchestrators = async () => {
    if (!workerManager) return;
    
    try {
      setLoadingOrchestrators(true);
      const orchestrators = await workerManager.list_orchestrators({
        _rkwargs: true
      });
      setRunningOrchestrators(orchestrators);
    } catch (error) {
      console.error('Failed to load running orchestrators:', error);
    } finally {
      setLoadingOrchestrators(false);
    }
  };

  const loadAllowedModels = async () => {
    if (!workerManager) return;
    
    try {
      setLoadingAllowedModels(true);
      const models = await workerManager.list_allowed_models({
        _rkwargs: true
      });
      setAllowedModels(models);
    } catch (error) {
      console.error('Failed to load allowed models:', error);
    } finally {
      setLoadingAllowedModels(false);
    }
  };

  const handleChange = (field: keyof WorkerInfo, value: string) => {
    setWorkerInfo(prev => ({
      ...prev,
      [field]: value
    }));

    // Clear error for this field if it exists
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    
    if (!workerInfo.name.trim()) {
      newErrors.name = 'Name is required';
    }
    
    if (!workerInfo.description.trim()) {
      newErrors.description = 'Description is required';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm() || !artifactManager || !workerInfo.id) return;
    
    try {
      setIsSaving(true);
      setSaveMessage(null);

      // Create updated manifest
      const updatedManifest = {
        ...workerInfo,
        type: 'worker',
        allowed_models: allowedModels.map(model => model.id),
        allowed_users: allowedUsers.map(user => user.id)
      };

      // Update the artifact's manifest using artifactManager
      await artifactManager.edit({
        artifact_id: workerInfo.id,
        version: "stage",
        manifest: updatedManifest,
        _rkwargs: true
      });

      setSaveMessage({
        text: 'Worker information saved successfully',
        type: 'success'
      });

      // Clear message after 3 seconds
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (error) {
      console.error('Error saving worker information:', error);
      setSaveMessage({
        text: 'Failed to save worker information',
        type: 'error'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const generateToken = async () => {
    if (!server) return;
    
    try {
      setIsGeneratingToken(true);
      const newToken = await server.generateToken({
        config: {
          expires_in: parseInt(expiresIn),
          permission: permission
        },
        _rkwargs: true
      });
      setToken(newToken);
    } catch (error) {
      console.error('Failed to generate token:', error);
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy token:', error);
    }
  };

  const handlePublish = async () => {
    if (!publishData.comment) {
      setUploadStatus({
        message: 'Please provide a comment for publishing',
        severity: 'error'
      });
      return;
    }

    try {
      setUploadStatus({
        message: 'Publishing worker configuration...',
        severity: 'info'
      });

      if (!artifactManager) {
        throw new Error('Artifact manager not initialized');
      }

      await artifactManager.commit(workerInfo.id!, {
        version: publishData.version || undefined,
        comment: publishData.comment
      });

      setUploadStatus({
        message: 'Worker configuration published successfully',
        severity: 'success'
      });

      setShowPublishDialog(false);
      // Remove navigation
      // navigate('/artifacts');
      
      // Clear publish data
      setPublishData({
        version: '',
        comment: ''
      });

      // Clear message after 5 seconds
      setTimeout(() => {
        setUploadStatus(null);
      }, 5000);
    } catch (error: any) {
      console.error('Error publishing worker:', error);
      setUploadStatus({
        message: `Failed to publish worker: ${error?.message || 'Unknown error'}`,
        severity: 'error'
      });
    }
  };

  const renderPublishDialog = () => (
    <Dialog open={showPublishDialog} onClose={() => setShowPublishDialog(false)}>
      <DialogTitle>Publish Worker Configuration</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Publish the current worker configuration. This will create a new version that others can use.
        </DialogContentText>
        <TextField
          margin="dense"
          label="Version (optional)"
          fullWidth
          variant="outlined"
          value={publishData.version || ''}
          onChange={(e) => setPublishData({ ...publishData, version: e.target.value })}
        />
        <TextField
          margin="dense"
          label="Comment"
          fullWidth
          required
          multiline
          rows={4}
          variant="outlined"
          value={publishData.comment}
          onChange={(e) => setPublishData({ ...publishData, comment: e.target.value })}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setShowPublishDialog(false)}>Cancel</Button>
        <Button onClick={handlePublish} variant="contained" color="primary">
          Publish
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="mb-4">
            <RiLoginBoxLine className="mx-auto h-12 w-12 text-gray-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Admin Access Required
          </h2>
          <p className="text-gray-500 mb-4">
            Please login with admin credentials to manage workers
          </p>
          <Link
            to="/"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            Return to Home
          </Link>
        </div>
      </div>
    );
  }

  if (!workerInfo) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Worker Not Found
          </h2>
          <p className="text-gray-500">
            Could not find worker information for the specified ID.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Manage Worker
          </h1>
          <p className="text-gray-600">Configure and monitor your worker node</p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outlined"
            onClick={() => navigate('/my-artifacts')}
            startIcon={<ArrowPathIcon className="h-5 w-5" />}
          >
            Back to Artifacts
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={() => setShowPublishDialog(true)}
            startIcon={<PublishIcon />}
          >
            Publish Changes
          </Button>
        </div>
      </div>

      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-6 mb-8 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0 mt-1">
              <div className="p-2 bg-blue-100 rounded-lg">
                <InformationCircleIcon className="h-6 w-6 text-blue-600" />
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Worker ID</h3>
              <p className="mt-1 text-sm text-gray-600">
                <code className="px-2 py-1 bg-blue-100 rounded-md text-blue-700 font-mono">
                  {workerInfo.id?.split('/')[1]}
                </code>
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0 mt-1">
              <div className="p-2 bg-blue-100 rounded-lg">
                <InformationCircleIcon className="h-6 w-6 text-blue-600" />
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Worker Name</h3>
              <p className="mt-1 text-sm text-gray-600">
                <code className="px-2 py-1 bg-blue-100 rounded-md text-blue-700 font-mono">
                  {workerInfo.name}
                </code>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* General Settings Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">General Settings</h2>
              <div className="flex items-center gap-4">
                {saveMessage && (
                  <span className={`text-sm px-3 py-1 rounded-full ${
                    saveMessage.type === 'success' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {saveMessage.text}
                  </span>
                )}
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleSubmit}
                  disabled={isSaving}
                  startIcon={isSaving ? <ArrowPathIcon className="animate-spin h-5 w-5" /> : null}
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-4 p-6">
            <TextField
              fullWidth
              label="Name"
              value={workerInfo.name}
              onChange={(e) => handleChange('name', e.target.value)}
              error={!!errors.name}
              helperText={errors.name || "A descriptive name for your worker"}
              margin="normal"
            />

            <TextField
              fullWidth
              label="Description"
              value={workerInfo.description}
              onChange={(e) => handleChange('description', e.target.value)}
              error={!!errors.description}
              helperText={errors.description || "Detailed description of your worker's capabilities"}
              margin="normal"
              multiline
              rows={3}
            />

            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Allowed Models</h3>
              {loadingAllowedModels ? (
                <div className="text-sm text-gray-500">Loading models...</div>
              ) : (
                <div className="space-y-2">
                  <Autocomplete
                    multiple
                    options={[]}
                    value={allowedModels.map(model => model.id)}
                    inputValue={modelInputValue}
                    onInputChange={(_, newValue) => {
                      setModelInputValue(newValue);
                    }}
                    freeSolo
                    renderTags={(value: string[], getTagProps) =>
                      value.map((option: string, index: number) => {
                        const props = getTagProps({ index });
                        // Remove key from props and pass it directly
                        const { key, ...chipProps } = props;
                        return (
                          <Chip
                            key={key}
                            {...chipProps}
                            variant="outlined"
                            label={option}
                            color="primary"
                          />
                        );
                      })
                    }
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        variant="outlined"
                        placeholder="Type and press enter to add model"
                        fullWidth
                        size="small"
                      />
                    )}
                    onChange={(_, newValue) => {
                      setAllowedModels(newValue.map(id => ({ id: String(id) })));
                    }}
                  />
                  <p className="text-xs text-gray-500">
                    Enter model IDs that this worker is allowed to run. Press Enter after each model ID.
                  </p>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Allowed Users</h3>
              <div className="space-y-2">
                <Autocomplete
                  multiple
                  options={[]}
                  value={allowedUsers.map(user => user.id)}
                  inputValue={userInputValue}
                  onInputChange={(_, newValue) => {
                    setUserInputValue(newValue);
                  }}
                  freeSolo
                  renderTags={(value: string[], getTagProps) =>
                    value.map((option: string, index: number) => {
                      const props = getTagProps({ index });
                      // Remove key from props and pass it directly
                      const { key, ...chipProps } = props;
                      return (
                        <Chip
                          key={key}
                          {...chipProps}
                          variant="outlined"
                          label={option}
                          color="secondary"
                        />
                      );
                    })
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      variant="outlined"
                      placeholder="Type and press enter to add user"
                      fullWidth
                      size="small"
                    />
                  )}
                  onChange={(_, newValue) => {
                    setAllowedUsers(newValue.map(id => ({ id: String(id) })));
                  }}
                />
                <p className="text-xs text-gray-500">
                  Enter user IDs that are allowed to use this worker. Leave empty to allow all users.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Token Generation Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Connect Worker</h2>
          </div>
          <div className="p-6">
            <div className="mb-6 bg-gray-50 rounded-lg p-4 border border-gray-200">
              <p className="text-sm text-gray-600 leading-relaxed">
                To connect your worker to the Chiron Platform, you'll need to generate an authentication token.
                This token will allow your worker to securely communicate with the platform and participate in federated learning tasks.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <TextField
                fullWidth
                label="Token Expiration (seconds)"
                type="number"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                helperText="How long the token should be valid for"
              />
              <FormControl fullWidth>
                <InputLabel>Permission Level</InputLabel>
                <Select
                  value={permission}
                  label="Permission Level"
                  onChange={(e) => setPermission(e.target.value as 'read' | 'read_write' | 'admin')}
                >
                  <MenuItem value="read">Read Only</MenuItem>
                  <MenuItem value="read_write">Read & Write</MenuItem>
                  <MenuItem value="admin">Admin</MenuItem>
                </Select>
              </FormControl>
            </div>

            <Button
              variant="contained"
              color="primary"
              onClick={generateToken}
              disabled={isGeneratingToken}
              className="mb-6"
            >
              {isGeneratingToken ? 'Generating...' : 'Generate Token'}
            </Button>

            {token && (
              <div className="mt-4">
                <div className="flex items-center space-x-2">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={token}
                      readOnly
                      aria-label="Worker authentication token"
                      title="Worker authentication token"
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono overflow-x-auto"
                      style={{ overflowWrap: 'break-word', wordBreak: 'break-all' }}
                    />
                  </div>
                  <button
                    onClick={copyToClipboard}
                    className="inline-flex items-center p-2 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    title="Copy to clipboard"
                  >
                    {copied ? (
                      <CheckIcon className="h-5 w-5 text-green-500" />
                    ) : (
                      <ClipboardIcon className="h-5 w-5 text-gray-500" />
                    )}
                  </button>
                </div>
                {copied && (
                  <span className="text-sm text-green-600 mt-1 inline-block">
                    Copied to clipboard!
                  </span>
                )}
                
                <div className="mt-4 p-4 bg-blue-50 rounded-md text-sm text-blue-700">
                  <p className="font-medium mb-3">Follow these steps to connect your worker:</p>
                  <ol className="list-decimal list-inside space-y-2">
                    <li className="pb-2 border-b border-blue-100">
                      Install the Chiron client:
                      <div className="mt-1 bg-blue-100 p-2 rounded font-mono text-blue-800">
                        pip install chiron-client
                      </div>
                    </li>
                    <li className="pb-2 border-b border-blue-100">
                      Set the token as an environment variable:
                      <div className="mt-1 bg-blue-100 p-2 rounded font-mono text-blue-800 break-all">
                        export CHIRON_TOKEN="{token}"
                      </div>
                    </li>
                    <li>
                      Start your worker:
                      <div className="mt-1 bg-blue-100 p-2 rounded font-mono text-blue-800">
                        chiron-worker start
                      </div>
                    </li>
                  </ol>
                  <div className="mt-4 text-sm bg-blue-100 p-3 rounded">
                    <p className="font-medium text-blue-800">💡 Tip:</p>
                    <p className="mt-1">
                      Make sure to securely store your token and never share it with others. 
                      The token will expire in {parseInt(expiresIn) / 3600} hours.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Datasets Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Available Datasets</h2>
              <Button
                variant="outlined"
                startIcon={<ArrowPathIcon className={`h-5 w-5 ${loadingDatasets ? 'animate-spin' : ''}`} />}
                onClick={loadDatasets}
                disabled={loadingDatasets}
              >
                {loadingDatasets ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>
          <div className="p-6">
            {loadingDatasets ? (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="mt-2 text-sm text-gray-500">Loading datasets...</p>
              </div>
            ) : datasets.length === 0 ? (
              <div className="text-center py-4 text-gray-500">
                No datasets available
              </div>
            ) : (
              <div className="space-y-4">
                {datasets.map((dataset, index) => (
                  <div key={index} className="border rounded-lg p-4">
                    <h3 className="font-medium text-gray-900">{dataset.name}</h3>
                    {dataset.description && (
                      <p className="text-sm text-gray-500 mt-1">{dataset.description}</p>
                    )}
                    {dataset.manifest && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {Object.entries(dataset.manifest).map(([key, value]) => (
                          <div key={key} className="text-xs bg-gray-100 rounded px-2 py-1">
                            <span className="font-medium">{key}:</span> {String(value)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Running Models Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Running Models</h2>
              <Button
                variant="outlined"
                startIcon={<ArrowPathIcon className={`h-5 w-5 ${loadingModels ? 'animate-spin' : ''}`} />}
                onClick={loadRunningModels}
                disabled={loadingModels}
              >
                {loadingModels ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>
          <div className="p-6">
            {loadingModels ? (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="mt-2 text-sm text-gray-500">Loading running models...</p>
              </div>
            ) : runningModels.length === 0 ? (
              <div className="text-center py-4 text-gray-500">
                No models currently running
              </div>
            ) : (
              <div className="space-y-4">
                {runningModels.map((model, index) => (
                  <div key={index} className="border rounded-lg p-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-medium text-gray-900">Client ID: {model.client_id}</h3>
                        <p className="text-sm text-gray-500 mt-1">PID: {model.pid}</p>
                      </div>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        model.status === 'running' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {model.status}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-4">
                      <div className="text-sm">
                        <span className="text-gray-500">CPU Usage:</span>{' '}
                        <span className="font-medium">{model.cpu_percent.toFixed(1)}%</span>
                      </div>
                      <div className="text-sm">
                        <span className="text-gray-500">Memory:</span>{' '}
                        <span className="font-medium">{(model.memory_rss / 1024 / 1024).toFixed(1)} MB</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Running Orchestrators Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Running Orchestrators</h2>
              <Button
                variant="outlined"
                startIcon={<ArrowPathIcon className={`h-5 w-5 ${loadingOrchestrators ? 'animate-spin' : ''}`} />}
                onClick={loadRunningOrchestrators}
                disabled={loadingOrchestrators}
              >
                {loadingOrchestrators ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>
          <div className="p-6">
            {loadingOrchestrators ? (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="mt-2 text-sm text-gray-500">Loading running orchestrators...</p>
              </div>
            ) : runningOrchestrators.length === 0 ? (
              <div className="text-center py-4 text-gray-500">
                No orchestrators currently running
              </div>
            ) : (
              <div className="space-y-4">
                {runningOrchestrators.map((orchestrator, index) => (
                  <div key={index} className="border rounded-lg p-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-medium text-gray-900">Orchestrator ID: {orchestrator.orchestrator_id}</h3>
                        <p className="text-sm text-gray-500 mt-1">PID: {orchestrator.pid}</p>
                      </div>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        orchestrator.status === 'running' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {orchestrator.status}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-4">
                      <div className="text-sm">
                        <span className="text-gray-500">CPU Usage:</span>{' '}
                        <span className="font-medium">{orchestrator.cpu_percent.toFixed(1)}%</span>
                      </div>
                      <div className="text-sm">
                        <span className="text-gray-500">Memory:</span>{' '}
                        <span className="font-medium">{(orchestrator.memory_rss / 1024 / 1024).toFixed(1)} MB</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {uploadStatus && (
        <Alert severity={uploadStatus.severity} sx={{ mb: 2 }}>
          {uploadStatus.message}
        </Alert>
      )}
      {renderPublishDialog()}
    </div>
  );
};

export default ManageWorker; 