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
  const [trainingConfig, setTrainingConfig] = useState({
    modelType: 'tabula',
    learningRate: '0.001',
    batchSize: '32',
    epochs: '100',
  });
  const [isTraining, setIsTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [orchestratorInfo, setOrchestratorInfo] = useState<any>(null);
  const [modelClients, setModelClients] = useState<any[]>([]);

  useEffect(() => {
    if (isLoggedIn && artifactManager) {
      loadWorkers();
    }
  }, [isLoggedIn, artifactManager]);

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
    try {
      setIsTraining(true);
      setError(null);

      // Launch orchestrator first
      for (const workerId of selectedWorkers) {
        const workerService = await server.getService(workerId.split('/')[1]);
        
        // Launch orchestrator
        const orchestratorResponse = await workerService.launch_orchestrator({
          num_rounds: parseInt(trainingConfig.epochs),
          _rkwargs: true
        });

        if (orchestratorResponse.error) {
          throw new Error(`Failed to launch orchestrator: ${orchestratorResponse.error}`);
        }

        setOrchestratorInfo(orchestratorResponse);

        // Launch model clients for each selected dataset
        const workerDatasets = selectedDatasets.filter(ds => ds.workerId === workerId);
        
        for (const dataset of workerDatasets) {
          const modelResponse = await workerService.load_model({
            model_id: trainingConfig.modelType,
            dataset_path: dataset.datasetName,
            _rkwargs: true
          });

          if (modelResponse.error) {
            throw new Error(`Failed to launch model client: ${modelResponse.error}`);
          }

          setModelClients(prev => [...prev, modelResponse]);
        }
      }

      // Move to next step
      handleNext();
    } catch (err) {
      console.error('Error starting training:', err);
      setError(err instanceof Error ? err.message : 'Failed to start training');
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
                <Grid item xs={12}>
                  <TextField
                    fullWidth
                    label="Learning Rate"
                    type="number"
                    value={trainingConfig.learningRate}
                    onChange={handleConfigChange('learningRate')}
                    inputProps={{ step: '0.0001' }}
                  />
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    fullWidth
                    label="Batch Size"
                    type="number"
                    value={trainingConfig.batchSize}
                    onChange={handleConfigChange('batchSize')}
                  />
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    fullWidth
                    label="Number of Epochs"
                    type="number"
                    value={trainingConfig.epochs}
                    onChange={handleConfigChange('epochs')}
                  />
                </Grid>
              </Grid>
              {error && (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {error}
                </Alert>
              )}
              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleStartTraining}
                  disabled={isTraining}
                >
                  {isTraining ? 'Starting Training...' : 'Start Training'}
                </Button>
              </Box>
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
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                      Orchestrator Status
                    </Typography>
                    {orchestratorInfo && (
                      <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                          <Typography variant="body2" color="text.secondary">
                            ID: {orchestratorInfo.orchestrator_id}
                          </Typography>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                          <Typography variant="body2" color="text.secondary">
                            Status: {orchestratorInfo.status || 'running'}
                          </Typography>
                        </Grid>
                      </Grid>
                    )}
                  </Box>

                  <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                      Connected Model Clients
                    </Typography>
                    <List>
                      {modelClients.map((client, index) => (
                        <ListItem key={client.client_id}>
                          <ListItemText
                            primary={`Client ${index + 1}: ${client.client_id}`}
                            secondary={`Status: ${client.status}`}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>

                  <Box sx={{ width: '100%', height: 400 }}>
                    <LineChart
                      width={800}
                      height={400}
                      data={mockTrainingData}
                      margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="epoch" />
                      <YAxis yAxisId="left" />
                      <YAxis yAxisId="right" orientation="right" />
                      <Tooltip />
                      <Legend />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="loss"
                        stroke="#8884d8"
                        name="Loss"
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="accuracy"
                        stroke="#82ca9d"
                        name="Accuracy"
                      />
                    </LineChart>
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
