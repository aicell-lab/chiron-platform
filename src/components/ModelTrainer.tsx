import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box,
  Stepper,
  Step,
  StepLabel,
  Button,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Checkbox,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  CircularProgress,
  Alert,
  LinearProgress,
} from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useHyphaStore } from '../store/hyphaStore';
import { RiLoginBoxLine } from 'react-icons/ri';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { Link } from 'react-router-dom';

interface Worker {
  id: string;
  manifest: {
    name: string;
    description: string;
  };
}

interface Dataset {
  name: string;
  description?: string;
  manifest?: any;
}

interface WorkerDatasets {
  workerId: string;
  datasets: Dataset[];
}

interface TrainingConfig {
  modelType: string;
  learningRate: string;
  batchSize: string;
  epochs: string;
  numRounds: string;
  minFitClients: string;
  minEvaluateClients: string;
  minAvailableClients: string;
  fractionFit: string;
  fractionEvaluate: string;
}

// Mock training data for the chart (we'll replace this with real data later)
const mockTrainingData = Array.from({ length: 20 }, (_, i) => ({
  epoch: i + 1,
  loss: Math.random() * 0.5 + 0.5 - i * 0.02,
  accuracy: 0.5 + i * 0.02 + Math.random() * 0.1,
}));

const steps = ['Select Workers', 'Configure Training', 'Training Progress', 'Evaluate & Publish'];

const ModelTrainer: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { artifactManager, server, isLoggedIn } = useHyphaStore();
  const [activeStep, setActiveStep] = useState(0);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [workerDatasets, setWorkerDatasets] = useState<WorkerDatasets[]>([]);
  const [selectedDatasets, setSelectedDatasets] = useState<{workerId: string, datasetName: string}[]>([]);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    modelType: 'tabula',
    learningRate: '0.001',
    batchSize: '32',
    epochs: '1',
    numRounds: '10',
    minFitClients: '1',
    minEvaluateClients: '1',
    minAvailableClients: '1',
    fractionFit: '1.0',
    fractionEvaluate: '1.0'
  });
  const [isTraining, setIsTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [orchestratorInfo, setOrchestratorInfo] = useState<any>(null);
  const [modelClients, setModelClients] = useState<any[]>([]);

  // Training progress state
  const [progressValue, setProgressValue] = useState(0);
  const [maxRounds, setMaxRounds] = useState(0);
  const [currentMessage, setCurrentMessage] = useState<string | null>(null);
  
  // Training metrics state
  const [trainRounds, setTrainRounds] = useState<number[]>([]);
  const [trainLossData, setTrainLossData] = useState<number[]>([]);
  const [trainAccData, setTrainAccData] = useState<number[]>([]);
  const [valRounds, setValRounds] = useState<number[]>([]);
  const [valLossData, setValLossData] = useState<number[]>([]);
  const [valAccData, setValAccData] = useState<number[]>([]);
  
  // Current metrics for display
  const [currentTrainingLoss, setCurrentTrainingLoss] = useState<number | null>(null);
  const [currentTrainingAcc, setCurrentTrainingAcc] = useState<number | null>(null);
  const [currentValLoss, setCurrentValLoss] = useState<number | null>(null);
  const [currentValAcc, setCurrentValAcc] = useState<number | null>(null);

  // Add new state for orchestrator worker
  const [selectedOrchestratorWorker, setSelectedOrchestratorWorker] = useState<string>('');
  const [workerManager, setWorkerManager] = useState<any>(null);

  useEffect(() => {
    if (isLoggedIn && artifactManager) {
      loadWorkers();
    }
  }, [isLoggedIn, artifactManager]);

  useEffect(() => {
    if (isLoggedIn && server) {
      // Listen for progress events from the orchestrator
      server.on("progress", (data: any) => {
        if (data.message) {
          setCurrentMessage(data.message);
        }
        if (!data.progress) return;

        const { type, round, metrics } = data.progress;
        
        // Handle training (fit) progress
        if (type === "fit") {
          const { loss, accuracy } = metrics;
          setTrainRounds(prev => [...prev, round]);
          setTrainLossData(prev => [...prev, loss]);
          setTrainAccData(prev => [...prev, accuracy]);
          setCurrentTrainingLoss(loss);
          setCurrentTrainingAcc(accuracy);
          setProgressValue(round);
        } 
        // Handle validation (evaluate) progress
        else if (type === "evaluate") {
          setValRounds(prev => [...prev, round]);
          setValLossData(prev => [...prev, metrics.loss]);
          setValAccData(prev => [...prev, metrics.accuracy]);
          setCurrentValLoss(metrics.loss);
          setCurrentValAcc(metrics.accuracy);
        }
        // Handle training finish
        else if (type === "finish") {
          setIsTraining(false);
          setCurrentMessage("Training completed!");
        }
      });
    }
  }, [isLoggedIn, server]);

  const loadWorkers = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await artifactManager.list({
        parent_id: "chiron-platform/collection",
        filters: { type: 'worker' },
        limit: 100,
        _rkwargs: true
      });

      setWorkers(response);
    } catch (err) {
      console.error('Error loading workers:', err);
      setError('Failed to load workers');
    } finally {
      setLoading(false);
    }
  };

  const loadWorkerDatasets = async (workerId: string) => {
    try {
      const workerService = await server.getService(workerId.split('/')[1]);
      const datasets = await workerService.list_datasets({
        offset: 0,
        limit: 100,
        _rkwargs: true
      });
      
      setWorkerDatasets(prev => [
        ...prev.filter(wd => wd.workerId !== workerId),
        { workerId, datasets: datasets.items }
      ]);
    } catch (err) {
      console.error(`Error loading datasets for worker ${workerId}:`, err);
      setError(`Failed to load datasets for worker ${workerId}`);
    }
  };

  const handleNext = () => {
    setActiveStep((prevStep) => prevStep + 1);
  };

  const handleBack = () => {
    setActiveStep((prevStep) => prevStep - 1);
  };

  const handleWorkerToggle = async (workerId: string) => {
    const isSelected = selectedWorkers.includes(workerId);
    
    if (!isSelected) {
      // Worker is being selected
      setSelectedWorkers(prev => [...prev, workerId]);
      await loadWorkerDatasets(workerId);
    } else {
      // Worker is being unselected
      setSelectedWorkers(prev => prev.filter(id => id !== workerId));
      setSelectedDatasets(prev => prev.filter(ds => ds.workerId !== workerId));
    }
  };

  const handleDatasetToggle = (workerId: string, datasetName: string) => {
    const key = JSON.stringify({ workerId, datasetName });
    const isSelected = selectedDatasets.some(
      ds => ds.workerId === workerId && ds.datasetName === datasetName
    );

    if (isSelected) {
      setSelectedDatasets(prev => 
        prev.filter(ds => !(ds.workerId === workerId && ds.datasetName === datasetName))
      );
    } else {
      setSelectedDatasets(prev => [...prev, { workerId, datasetName }]);
    }
  };

  const handleConfigChange = (field: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setTrainingConfig((prev) => ({
      ...prev,
      [field]: event.target.value,
    }));
  };

  const handleStartTraining = async () => {
    if (!selectedOrchestratorWorker) {
      setError('Please select a worker to run the orchestrator');
      return;
    }

    try {
      setIsTraining(true);
      setError(null);
      
      // Clear previous training data
      setTrainRounds([]);
      setTrainLossData([]);
      setTrainAccData([]);
      setValRounds([]);
      setValLossData([]);
      setValAccData([]);
      setCurrentTrainingLoss(null);
      setCurrentTrainingAcc(null);
      setCurrentValLoss(null);
      setCurrentValAcc(null);
      setCurrentMessage(null);

      const numRounds = parseInt(trainingConfig.numRounds);
      setProgressValue(0);
      setMaxRounds(numRounds);

      // Get the worker service
      const manager = await server.getService(selectedOrchestratorWorker.split('/')[1]);
      setWorkerManager(manager);

      // Launch orchestrator on the selected worker
      const response = await manager.launch_orchestrator({
        num_rounds: numRounds,
        _rkwargs: true
      });

      if (response.error) {
        throw new Error(`Failed to launch orchestrator: ${response.error}`);
      }

      setOrchestratorInfo(response);

      // Launch model clients for each selected worker/dataset pair
      for (const { workerId, datasetName } of selectedDatasets) {
        const workerService = await server.getService(workerId.split('/')[1]);
        const modelResponse = await workerService.load_model({
          model_id: trainingConfig.modelType,
          dataset_path: datasetName,
          _rkwargs: true
        });

        if (modelResponse.error) {
          throw new Error(`Failed to launch model client: ${modelResponse.error}`);
        }

        setModelClients(prev => [...prev, modelResponse]);
      }

      handleNext(); // Move to next step in stepper
    } catch (err) {
      console.error('Error starting training:', err);
      setError(err instanceof Error ? err.message : 'Failed to start training');
      setIsTraining(false);
    }
  };

  const handleStopTraining = async () => {
    if (!workerManager || !orchestratorInfo) {
      return;
    }

    try {
      await workerManager.stop_orchestrator({
        orchestrator_id: orchestratorInfo.orchestrator_id,
        _rkwargs: true
      });

      // Stop all model clients
      for (const { workerId } of selectedDatasets) {
        try {
          const workerService = await server.getService(workerId.split('/')[1]);
          // You might need to implement a method to stop specific model clients
          // This depends on your worker API
        } catch (error) {
          console.error(`Failed to stop model client on worker ${workerId}:`, error);
        }
      }
    } catch (err) {
      console.error('Failed to stop training:', err);
    } finally {
      setIsTraining(false);
    }
  };

  const handlePublishModel = () => {
    // TODO: Implement model publishing
    alert('Model published successfully!');
  };

  const refreshWorkers = async () => {
    await loadWorkers();
  };

  const refreshDatasets = async (workerId: string) => {
    await loadWorkerDatasets(workerId);
  };

  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="mb-4">
            <RiLoginBoxLine className="mx-auto h-12 w-12 text-gray-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Login Required
          </h2>
          <p className="text-gray-500 mb-4">
            Please login to access the Model Trainer
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

  const renderStepContent = (step: number) => {
    switch (step) {
      case 0:
        return (
          <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                Select Workers to Join Federation
              </Typography>
              <Button
                variant="outlined"
                startIcon={<ArrowPathIcon className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />}
                onClick={refreshWorkers}
                disabled={loading}
              >
                {loading ? 'Refreshing...' : 'Refresh Workers'}
              </Button>
            </Box>
            {loading ? (
              <Box display="flex" justifyContent="center" my={4}>
                <CircularProgress />
              </Box>
            ) : error ? (
              <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
            ) : (
              <>
                <List>
                  {workers.map((worker) => (
                    <ListItem
                      key={worker.id}
                      onClick={() => handleWorkerToggle(worker.id)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <ListItemIcon>
                        <Checkbox
                          checked={selectedWorkers.includes(worker.id)}
                          edge="start"
                        />
                      </ListItemIcon>
                      <ListItemText 
                        primary={worker.manifest.name} 
                        secondary={worker.manifest.description}
                      />
                    </ListItem>
                  ))}
                </List>

                <Box display="flex" justifyContent="space-between" alignItems="center" mt={4} mb={2}>
                  <Typography variant="h6">
                    Select Datasets
                  </Typography>
                  {selectedWorkers.length > 0 && (
                    <Button
                      variant="outlined"
                      startIcon={<ArrowPathIcon className="h-5 w-5" />}
                      onClick={() => Promise.all(selectedWorkers.map(refreshDatasets))}
                    >
                      Refresh Datasets
                    </Button>
                  )}
                </Box>
                <List>
                  {workerDatasets.map((workerDs) => (
                    <React.Fragment key={workerDs.workerId}>
                      <Typography variant="subtitle1" color="text.secondary" sx={{ mt: 2, ml: 2 }}>
                        {workers.find(w => w.id === workerDs.workerId)?.manifest.name}
                      </Typography>
                      {workerDs.datasets.map((dataset) => (
                        <ListItem
                          key={`${workerDs.workerId}-${dataset.name}`}
                          onClick={() => handleDatasetToggle(workerDs.workerId, dataset.name)}
                          sx={{ cursor: 'pointer', pl: 4 }}
                        >
                          <ListItemIcon>
                            <Checkbox
                              checked={selectedDatasets.some(
                                ds => ds.workerId === workerDs.workerId && ds.datasetName === dataset.name
                              )}
                              edge="start"
                            />
                          </ListItemIcon>
                          <ListItemText
                            primary={dataset.name}
                            secondary={dataset.description}
                          />
                        </ListItem>
                      ))}
                    </React.Fragment>
                  ))}
                </List>
              </>
            )}
          </Box>
        );

      case 1:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Training Configuration
            </Typography>
            <Paper sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
              <Grid container spacing={3}>
                {/* Worker Selection */}
                <Grid item xs={12}>
                  <FormControl fullWidth>
                    <InputLabel>Select Worker for Orchestrator</InputLabel>
                    <Select
                      value={selectedOrchestratorWorker}
                      onChange={(e) => setSelectedOrchestratorWorker(e.target.value)}
                      label="Select Worker for Orchestrator"
                    >
                      {workers.map((worker) => (
                        <MenuItem key={worker.id} value={worker.id}>
                          {worker.manifest.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>

                {/* Model Selection */}
                <Grid item xs={12}>
                  <FormControl fullWidth>
                    <InputLabel>Model Type</InputLabel>
                    <Select
                      value={trainingConfig.modelType}
                      onChange={(e) => handleConfigChange('modelType')(e as any)}
                      label="Model Type"
                    >
                      <MenuItem value="tabula">Tabula</MenuItem>
                      <MenuItem value="test-model">Test Model</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>

                {/* Rest of the configuration fields */}
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Learning Rate"
                    type="number"
                    value={trainingConfig.learningRate}
                    onChange={handleConfigChange('learningRate')}
                    inputProps={{ step: '0.0001' }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Batch Size"
                    type="number"
                    value={trainingConfig.batchSize}
                    onChange={handleConfigChange('batchSize')}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Local Epochs"
                    type="number"
                    value={trainingConfig.epochs}
                    onChange={handleConfigChange('epochs')}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Number of Rounds"
                    type="number"
                    value={trainingConfig.numRounds}
                    onChange={handleConfigChange('numRounds')}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Min Fit Clients"
                    type="number"
                    value={trainingConfig.minFitClients}
                    onChange={handleConfigChange('minFitClients')}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Min Evaluate Clients"
                    type="number"
                    value={trainingConfig.minEvaluateClients}
                    onChange={handleConfigChange('minEvaluateClients')}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Fraction Fit"
                    type="number"
                    value={trainingConfig.fractionFit}
                    onChange={handleConfigChange('fractionFit')}
                    inputProps={{ step: '0.1', min: 0, max: 1 }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Fraction Evaluate"
                    type="number"
                    value={trainingConfig.fractionEvaluate}
                    onChange={handleConfigChange('fractionEvaluate')}
                    inputProps={{ step: '0.1', min: 0, max: 1 }}
                  />
                </Grid>
              </Grid>

              {error && (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {error}
                </Alert>
              )}

              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center', gap: 2 }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleStartTraining}
                  disabled={isTraining || !selectedOrchestratorWorker || selectedDatasets.length === 0}
                  startIcon={isTraining ? <CircularProgress size={20} /> : null}
                >
                  {isTraining ? 'Training...' : 'Start Training'}
                </Button>
                {isTraining && (
                  <Button
                    variant="outlined"
                    color="secondary"
                    onClick={handleStopTraining}
                  >
                    Stop Training
                  </Button>
                )}
              </Box>

              {/* Selected Configuration Summary */}
              {selectedOrchestratorWorker && selectedDatasets.length > 0 && (
                <Box sx={{ mt: 4, p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Training Setup Summary:
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Orchestrator Worker: {workers.find(w => w.id === selectedOrchestratorWorker)?.manifest.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Selected Datasets: {selectedDatasets.length}
                  </Typography>
                  <List dense>
                    {selectedDatasets.map(({ workerId, datasetName }, index) => (
                      <ListItem key={index}>
                        <ListItemText
                          primary={datasetName}
                          secondary={workers.find(w => w.id === workerId)?.manifest.name}
                        />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Paper>
          </Box>
        );

      case 2:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Training Progress
            </Typography>
            <Paper sx={{ p: 3 }}>
              {error ? (
                <Alert severity="error" sx={{ mb: 3 }}>
                  {error}
                </Alert>
              ) : (
                <>
                  {/* Progress Information */}
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                      Training Status
                    </Typography>
                    {currentMessage && (
                      <Alert severity="info" sx={{ mb: 2 }}>
                        {currentMessage}
                      </Alert>
                    )}
                    {isTraining && (
                      <Box sx={{ width: '100%', mb: 2 }}>
                        <LinearProgress 
                          variant="determinate" 
                          value={(progressValue / maxRounds) * 100} 
                        />
                        <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1 }}>
                          Round {progressValue} of {maxRounds}
                        </Typography>
                      </Box>
                    )}
                  </Box>

                  {/* Current Metrics */}
                  <Grid container spacing={2} sx={{ mb: 3 }}>
                    <Grid item xs={12} sm={6} md={3}>
                      <Paper sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="subtitle2" color="text.secondary">
                          Training Loss
                        </Typography>
                        <Typography variant="h6">
                          {currentTrainingLoss?.toFixed(4) || '--'}
                        </Typography>
                      </Paper>
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                      <Paper sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="subtitle2" color="text.secondary">
                          Training Accuracy
                        </Typography>
                        <Typography variant="h6">
                          {currentTrainingAcc ? `${(currentTrainingAcc * 100).toFixed(2)}%` : '--'}
                        </Typography>
                      </Paper>
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                      <Paper sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="subtitle2" color="text.secondary">
                          Validation Loss
                        </Typography>
                        <Typography variant="h6">
                          {currentValLoss?.toFixed(4) || '--'}
                        </Typography>
                      </Paper>
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                      <Paper sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="subtitle2" color="text.secondary">
                          Validation Accuracy
                        </Typography>
                        <Typography variant="h6">
                          {currentValAcc ? `${(currentValAcc * 100).toFixed(2)}%` : '--'}
                        </Typography>
                      </Paper>
                    </Grid>
                  </Grid>

                  {/* Training Charts */}
                  <Box sx={{ width: '100%', display: 'flex', flexWrap: 'wrap' }}>
                    <Box sx={{ width: '100%', md: '50%', p: 1 }}>
                      <LineChart
                        width={500}
                        height={300}
                        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="round" />
                        <YAxis yAxisId="left" />
                        <YAxis yAxisId="right" orientation="right" />
                        <Tooltip />
                        <Legend />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          data={trainRounds.map((round, i) => ({
                            round,
                            loss: trainLossData[i],
                            accuracy: trainAccData[i]
                          }))}
                          dataKey="loss"
                          name="Training Loss"
                          stroke="#8884d8"
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          data={trainRounds.map((round, i) => ({
                            round,
                            loss: trainLossData[i],
                            accuracy: trainAccData[i]
                          }))}
                          dataKey="accuracy"
                          name="Training Accuracy"
                          stroke="#82ca9d"
                        />
                      </LineChart>
                    </Box>
                    <Box sx={{ width: '100%', md: '50%', p: 1 }}>
                      <LineChart
                        width={500}
                        height={300}
                        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="round" />
                        <YAxis yAxisId="left" />
                        <YAxis yAxisId="right" orientation="right" />
                        <Tooltip />
                        <Legend />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          data={valRounds.map((round, i) => ({
                            round,
                            loss: valLossData[i],
                            accuracy: valAccData[i]
                          }))}
                          dataKey="loss"
                          name="Validation Loss"
                          stroke="#8884d8"
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          data={valRounds.map((round, i) => ({
                            round,
                            loss: valLossData[i],
                            accuracy: valAccData[i]
                          }))}
                          dataKey="accuracy"
                          name="Validation Accuracy"
                          stroke="#82ca9d"
                        />
                      </LineChart>
                    </Box>
                  </Box>
                </>
              )}
            </Paper>
          </Box>
        );

      case 3:
        return (
          <Box>
            <Typography variant="h6" gutterBottom>
              Model Evaluation
            </Typography>
            <Paper sx={{ p: 3 }}>
              <Grid container spacing={3}>
                <Grid item xs={12} md={6}>
                  <Typography variant="subtitle1" gutterBottom>
                    UMAP Visualization
                  </Typography>
                  <Box
                    sx={{
                      width: '100%',
                      height: 300,
                      bgcolor: 'grey.100',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    UMAP Placeholder
                  </Box>
                </Grid>
                <Grid item xs={12} md={6}>
                  <Typography variant="subtitle1" gutterBottom>
                    Performance Metrics
                  </Typography>
                  <List>
                    <ListItem>
                      <ListItemText
                        primary="Test Accuracy"
                        secondary="0.89"
                      />
                    </ListItem>
                    <ListItem>
                      <ListItemText
                        primary="Test Loss"
                        secondary="0.32"
                      />
                    </ListItem>
                    <ListItem>
                      <ListItemText
                        primary="F1 Score"
                        secondary="0.87"
                      />
                    </ListItem>
                  </List>
                </Grid>
              </Grid>
              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handlePublishModel}
                >
                  Publish Model
                </Button>
              </Box>
            </Paper>
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Model Trainer
      </Typography>
      <Typography variant="subtitle1" color="text.secondary" gutterBottom>
        Model ID: {id}
      </Typography>

      <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      <Box sx={{ mt: 4 }}>
        {renderStepContent(activeStep)}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 4 }}>
          <Button
            disabled={activeStep === 0}
            onClick={handleBack}
            sx={{ mr: 1 }}
          >
            Back
          </Button>
          <Button
            variant="contained"
            onClick={handleNext}
            disabled={
              (activeStep === 0 && selectedWorkers.length === 0) ||
              (activeStep === 1 && !isTraining) ||
              activeStep === steps.length - 1
            }
          >
            {activeStep === steps.length - 1 ? 'Finish' : 'Next'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
};

export default ModelTrainer; 
