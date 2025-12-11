import React, { useState, useRef, useEffect } from 'react';
import { useHyphaStore } from '../../store/hyphaStore';

type ContainerRuntimeType = 'docker' | 'podman';

const BioEngineGuide: React.FC = () => {
  const { server, user } = useHyphaStore();
  
  const [containerRuntime, setContainerRuntime] = useState<ContainerRuntimeType>('docker');
  const [cpus, setCpus] = useState(4);
  const [memory, setMemory] = useState(30);
  const [hasGpu, setHasGpu] = useState(true);
  const [gpus, setGpus] = useState(1);
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced options
  const [adminUsers, setAdminUsers] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [shmSize, setShmSize] = useState(8);
  const [customImage, setCustomImage] = useState('');
  const [gpuIndices, setGpuIndices] = useState('');
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [showDataExample, setShowDataExample] = useState(false);
  const [timezone, setTimezone] = useState('');

  // Token generation
  const [token, setToken] = useState('');
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [tokenFlash, setTokenFlash] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState('');

  // Ref for the troubleshooting dialog
  const troubleshootingDialogRef = useRef<HTMLDivElement>(null);

  // Effect to scroll to dialog when troubleshooting opens
  useEffect(() => {
    if (showTroubleshooting && troubleshootingDialogRef.current) {
      setTimeout(() => {
        troubleshootingDialogRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'center'
        });
      }, 100);
    }
  }, [showTroubleshooting]);

  // Detect timezone from browser
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setTimezone(tz);
    } catch (error) {
      console.error('Failed to detect timezone:', error);
      setTimezone('UTC');
    }
  }, []);

  // Auto-generate token on component mount when user is logged in
  useEffect(() => {
    if (server && user && !token) {
      generateToken();
    }
  }, [server, user]);

  const generateToken = async () => {
    if (!server) {
      setTokenError('Not connected to server. Please login first.');
      return;
    }
    
    setIsGeneratingToken(true);
    setTokenError('');
    
    try {
      const newToken = await server.generateToken({
        workspace: server.config.workspace,
        permission: "admin",
        expires_in: 3600 * 24 * 30, // 30 days
      });
      setToken(newToken);
      // Trigger flash animation
      setTokenFlash(true);
      setTimeout(() => setTokenFlash(false), 1000);
    } catch (error) {
      console.error('Failed to generate token:', error);
      setTokenError('Failed to generate token. Please try again.');
    } finally {
      setIsGeneratingToken(false);
    }
  };

  const getDockerComposeContent = () => {
    const imageToUse = customImage || 'ghcr.io/aicell-lab/tabula:0.2.3';
    
    // Build admin users string
    let adminUsersStr = '';
    if (adminUsers) {
      if (adminUsers === '*') {
        adminUsersStr = '"*"';
      } else {
        adminUsersStr = adminUsers.split(',').map(u => `"${u.trim()}"`).join(' ');
      }
    }

    // GPU configuration for docker-compose
    let gpuConfig = '';
    if (hasGpu) {
      if (gpuIndices) {
        // Use specific GPU indices
        const indices = gpuIndices.split(',').map(i => `"${i.trim()}"`).join(', ');
        gpuConfig = `
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: [${indices}]
              capabilities: [gpu]`;
      } else {
        // Use count
        gpuConfig = `
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: ${gpus}
              capabilities: [gpu]`;
      }
    }

    // Workspace directory - use custom if set, otherwise ${HOME}/.bioengine
    const workspaceDirPath = workspaceDir || '${HOME}/.bioengine';

    // Data import directory - optional
    const dataImportVolume = dataDir ? `\n      - ${dataDir}:/data` : '';
    const dataImportCommand = dataDir ? '\n      --data-import-dir /data' : '';

    // Worker command arguments
    const workerArgs = [
      '--mode single-machine',
      `--head-num-cpus ${cpus}`,
      hasGpu ? `--head-num-gpus ${gpus}` : '',
      `--head-memory-in-gb ${memory}`,
      '--startup-applications "{\\"artifact_id\\": \\"chiron-platform/chiron-manager\\", \\"application_id\\": \\"chiron-manager\\"}"',
      adminUsersStr ? `--admin-users ${adminUsersStr}` : '',
      workspace ? `--workspace ${workspace}` : '',
      '--dashboard-url https://chiron.aicell.io/#/bioengine'
    ].filter(Boolean).join('\n      ');

    return `version: "3.8"

services:
  data-server:
    image: ${imageToUse}
    container_name: bioengine-data-server
    user: "\${UID}:\${GID}"
    volumes:
      - ${workspaceDirPath}:/home/.bioengine${dataImportVolume}
    environment:
      - HOME=/home
      - TZ=${timezone || 'UTC'}
    command: >
      python -m tabula.datasets${dataImportCommand}
      --workspace-dir /home/.bioengine
      --server-port 9527
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9527/health/liveness"]
      start_period: 60s
      start_interval: 5s
      interval: 30s
      timeout: 10s
      retries: 3

  worker:
    image: ${imageToUse}
    container_name: bioengine-worker
    user: "\${UID}:\${GID}"
    shm_size: ${shmSize}g
    volumes:
      - ${workspaceDirPath}:/home/.bioengine
    environment:
      - HOME=/home
      - HYPHA_TOKEN=\${HYPHA_TOKEN}
      - TZ=${timezone || 'UTC'}
    command: >
      python -m bioengine.worker
      ${workerArgs}
    restart: unless-stopped${gpuConfig}
    depends_on:
      data-server:
        condition: service_healthy
`;
  };

  const getRunCommand = () => {
    if (containerRuntime === 'docker') {
      return 'docker compose up';
    } else {
      return 'podman-compose up';
    }
  };

  const getEnvFileContent = () => {
    const workspaceDirPath = workspaceDir || '~/.bioengine';
    return `# Get your user and group IDs
UID=$(id -u)
GID=$(id -g)

# Your Hypha authentication token
HYPHA_TOKEN=${token || '<set_token_here>'}

# Create workspace directory if it doesn't exist
mkdir -p ${workspaceDirPath}
`;
  };

  const downloadDockerCompose = () => {
    const content = getDockerComposeContent();
    const blob = new Blob([content], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'docker-compose.yaml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getTroubleshootingPrompt = () => {
    const containerName = containerRuntime.charAt(0).toUpperCase() + containerRuntime.slice(1);

    return `# BioEngine Worker Troubleshooting Assistant

## Context & Background

I'm trying to set up a **BioEngine Worker** for single-cell analysis using Docker Compose. BioEngine is part of the AI4Life project and provides cloud-powered AI tools for single-cell analysis.

### What is BioEngine?
- BioEngine is a distributed computing platform for running AI models on life sciences
- It uses Ray (distributed computing framework) and Hypha (service orchestration) 
- The system allows deploying and running AI models

### My Current Setup
- **Container Runtime**: ${containerName}
- **CPUs**: ${cpus}
- **Memory**: ${memory} GB
- **GPUs**: ${hasGpu ? gpus : 'None'}
- **Shared Memory Size**: ${shmSize}g
${adminUsers ? `- **Admin Users**: ${adminUsers}` : '- **Admin Users**: Default (logged-in user)'}
${dataDir ? `- **Data Directory**: ${dataDir}` : ''}
${customImage ? `- **Custom Image**: ${customImage}` : ''}

### Generated docker-compose.yaml
\`\`\`yaml
${getDockerComposeContent()}
\`\`\`

### Run Command
\`\`\`bash
${getRunCommand()}
\`\`\`

## Complete BioEngine Worker Help Reference

\`\`\`
python -m bioengine_worker --help
usage: __main__.py [-h] --mode MODE [--admin_users EMAIL [EMAIL ...]] [--cache_dir PATH] [--ray_cache_dir PATH]
                   [--startup_applications JSON [JSON ...]] [--monitoring_interval_seconds SECONDS] [--dashboard_url URL]
                   [--log_file PATH] [--debug] [--graceful_shutdown_timeout SECONDS] [--server_url URL] [--workspace NAME]
                   [--token TOKEN] [--client_id ID] [--head_node_address ADDRESS] [--head_node_port PORT] [--node_manager_port PORT]
                   [--object_manager_port PORT] [--redis_shard_port PORT] [--serve_port PORT] [--dashboard_port PORT]
                   [--client_server_port PORT] [--redis_password PASSWORD] [--head_num_cpus COUNT] [--head_num_gpus COUNT]
                   [--head_memory_in_gb GB] [--runtime_env_pip_cache_size_gb GB] [--no_ray_cleanup] [--image IMAGE]
                   [--worker_cache_dir PATH] [--default_num_gpus COUNT] [--default_num_cpus COUNT] [--default_mem_in_gb_per_cpu GB]
                   [--default_time_limit TIME] [--further_slurm_args ARG [ARG ...]] [--min_workers COUNT] [--max_workers COUNT]
                   [--scale_up_cooldown_seconds SECONDS] [--scale_down_check_interval_seconds SECONDS]
                   [--scale_down_threshold_seconds SECONDS]

BioEngine Worker - Enterprise AI Model Deployment Platform

options:
  -h, --help            show this help message and exit

Core Options:
  Basic worker configuration

  --mode MODE           Deployment mode: 'single-machine' for local Ray cluster, 'slurm' for HPC clusters with SLURM job scheduling,
                        'external-cluster' for connecting to an existing Ray cluster
  --admin_users EMAIL [EMAIL ...]
                        List of user emails/IDs with administrative privileges for worker management. If not specified, defaults to the
                        authenticated user from Hypha login.
  --cache_dir PATH      Directory for worker cache, temporary files, and Ray data storage. Also used to detect running data servers for
                        dataset access. Should be accessible across worker nodes in distributed deployments.
  --ray_cache_dir PATH  Directory for Ray cluster cache when connecting to an external Ray cluster. Only used in 'external-cluster'
                        mode. This allows the remote Ray cluster to use a different cache directory than the local machine. If not
                        specified, uses the same directory as --cache_dir. Not applicable for 'single-machine' or 'slurm' modes.
  --startup_applications JSON [JSON ...]
                        List of applications to deploy automatically during worker startup. Each element should be a JSON string with
                        deployment configuration. Example: '{"artifact_id": "my_model", "application_id": "my_app"}'
  --monitoring_interval_seconds SECONDS
                        Interval in seconds for worker status monitoring and health checks. Lower values provide faster response but
                        increase overhead.
  --dashboard_url URL   Base URL of the BioEngine dashboard for worker management interfaces.
  --log_file PATH       Path to the log file. If set to 'off', logging will only go to console. If not specified (None), a log file
                        will be created in '<cache_dir>/logs'.
  --debug               Enable debug-level logging for detailed troubleshooting and development. Increases log verbosity significantly.
  --graceful_shutdown_timeout SECONDS
                        Timeout in seconds for graceful shutdown operations.

Hypha Options:
  Server connection and authentication

  --server_url URL      URL of the Hypha server for service registration and remote access. Must be accessible from the deployment
                        environment.
  --workspace NAME      Hypha workspace name for service isolation and organization. If not specified, uses the workspace associated
                        with the authentication token.
  --token TOKEN         Authentication token for Hypha server access. If not provided, will use the HYPHA_TOKEN environment variable or
                        prompt for interactive login. Recommend using a long-lived token for production deployments.
  --client_id ID        Unique client identifier for Hypha connection. If not specified, an identifier will be generated automatically
                        to ensure unique registration.

Ray Cluster Options:
  Cluster networking and resource configuration

  --head_node_address ADDRESS
                        IP address of the Ray head node. For external-cluster mode, this specifies the cluster to connect to. If not
                        set in other modes, uses the first available system IP address.
  --head_node_port PORT
                        Port for Ray head node and GCS (Global Control Service) server. Must be accessible from all worker nodes.
  --node_manager_port PORT
                        Port for Ray node manager services. Used for inter-node communication and coordination.
  --object_manager_port PORT
                        Port for Ray object manager service. Handles distributed object storage and transfer between nodes.
  --redis_shard_port PORT
                        Port for Redis sharding in Ray's internal metadata storage. Used for cluster state management.
  --serve_port PORT     Port for Ray Serve HTTP endpoint serving deployed models and applications. This is where model inference
                        requests are handled.
  --dashboard_port PORT
                        Port for Ray dashboard web interface. Provides cluster monitoring and debugging capabilities.
  --client_server_port PORT
                        Port for Ray client server connections. Used by external Ray clients to connect to the cluster.
  --redis_password PASSWORD
                        Password for Ray cluster Redis authentication. If not specified, a secure random password will be generated
                        automatically.
  --head_num_cpus COUNT
                        Number of CPU cores allocated to the head node for task execution. Set to 0 to reserve head node for
                        coordination only.
  --head_num_gpus COUNT
                        Number of GPU devices allocated to the head node for task execution. Typically 0 to reserve GPUs for worker
                        nodes.
  --head_memory_in_gb GB
                        Memory allocation in GB for head node task execution. If not specified, Ray will auto-detect available memory.
  --runtime_env_pip_cache_size_gb GB
                        Size limit in GB for Ray runtime environment pip package cache. Larger cache improves environment setup time.
  --no_ray_cleanup      Skip cleanup of previous Ray cluster processes and data. Use with caution as it may cause port conflicts or
                        resource issues.

SLURM Job Options:
  HPC job scheduling and worker deployment

  --image IMAGE         Container image for SLURM worker jobs. Should include all required dependencies and be accessible on compute
                        nodes.
  --worker_cache_dir PATH
                        Cache directory path mounted to worker containers in SLURM jobs. Must be accessible from compute nodes.
                        Required for SLURM mode.
  --default_num_gpus COUNT
                        Default number of GPU devices to request per SLURM worker job. Can be overridden per deployment.
  --default_num_cpus COUNT
                        Default number of CPU cores to request per SLURM worker job. Should match typical model inference requirements.
  --default_mem_in_gb_per_cpu GB
                        Default memory allocation in GB per CPU core for SLURM workers. Total memory = num_cpus * mem_per_cpu.
  --default_time_limit TIME
                        Default time limit for SLURM worker jobs in "HH:MM:SS" format. Jobs will be terminated after this duration.
  --further_slurm_args ARG [ARG ...]
                        Additional SLURM sbatch arguments for specialized cluster configurations. Example: "--partition=gpu" "--
                        qos=high-priority"

Ray Autoscaler Options:
  Automatic worker scaling behavior

  --min_workers COUNT   Minimum number of worker nodes to maintain in the cluster. Workers below this threshold will be started
                        immediately.
  --max_workers COUNT   Maximum number of worker nodes allowed in the cluster. Prevents unlimited scaling and controls costs.
  --scale_up_cooldown_seconds SECONDS
                        Cooldown period in seconds between scaling up operations. Prevents rapid scaling oscillations.
  --scale_down_check_interval_seconds SECONDS
                        Interval in seconds between checks for scaling down idle workers. More frequent checks enable faster response
                        to load changes.
  --scale_down_threshold_seconds SECONDS
                        Time threshold in seconds before scaling down idle worker nodes. Longer thresholds reduce churn but may waste
                        resources.

Examples:
  # SLURM HPC deployment with autoscaling
  __main__.py --mode slurm --max_workers 10 --admin_users admin@institution.edu

  # Single-machine development deployment  
  __main__.py --mode single-machine --debug --cache_dir ./cache

  # Connect to existing Ray cluster
  __main__.py --mode external-cluster --head_node_address 10.0.0.100

For detailed documentation, visit: https://github.com/aicell-lab/bioengine-worker
\`\`\`

## Troubleshooting Chain of Thought

When helping me troubleshoot, please consider:

1. **Docker/Podman Issues**: Container startup, platform compatibility, volume mounting
2. **Network Issues**: Port conflicts, firewall settings, connectivity
3. **Resource Issues**: CPU/GPU allocation, memory constraints
4. **Permission Issues**: User permissions, file access, Docker daemon access
5. **Ray Cluster Issues**: Ray startup, cluster connectivity, node communication
6. **Hypha Integration**: Workspace access, authentication, service registration
7. **Configuration Issues**: Invalid arguments, missing dependencies, environment setup

## Common Issues to Check

- ${containerName} is installed and running
- Sufficient system resources (CPU, memory, disk space)
- Network ports are available (especially for Ray cluster communication)
${hasGpu ? `- For GPU mode: NVIDIA ${containerRuntime === 'docker' ? 'Docker runtime' : 'container toolkit for Podman'}` : ''}

## My Question

[Please describe your specific issue or question here. For example:
- Error messages you're seeing
- What you expected to happen vs what actually happened
- Steps you've already tried
- Any specific error logs or output]

Please help me troubleshoot this BioEngine Worker setup. Provide step-by-step guidance and explain the reasoning behind each suggestion.`;
  };

  const copyTroubleshootingPrompt = async () => {
    try {
      await navigator.clipboard.writeText(getTroubleshootingPrompt());
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy prompt:', err);
    }
  };

  return (
    <div className="pt-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between text-left rounded-xl p-4 transition-all duration-200 ${isExpanded
            ? 'bg-gray-50 hover:bg-gray-100 border border-gray-200'
            : 'bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 border-2 border-blue-200 hover:shadow-md'
          }`}
      >
        <div className="flex items-center">
          <div className={`rounded-xl flex items-center justify-center mr-4 transition-all duration-200 ${isExpanded
              ? 'w-8 h-8 bg-gradient-to-r from-gray-400 to-gray-500'
              : 'w-12 h-12 bg-gradient-to-r from-cyan-500 to-blue-600 shadow-md'
            }`}>
            <svg className={`text-white transition-all duration-200 ${isExpanded ? 'w-4 h-4' : 'w-6 h-6'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h4 className={`font-semibold transition-all duration-200 ${isExpanded
                ? 'text-sm text-gray-700'
                : 'text-lg text-gray-800'
              }`}>Launch Your Own BioEngine Instance</h4>
            <p className={`text-gray-500 transition-all duration-200 ${isExpanded
                ? 'text-xs'
                : 'text-sm font-medium'
              }`}>Deploy on your Desktop/Workstation using Docker Compose</p>
          </div>
        </div>
        <div className="flex items-center">
          <span className={`text-gray-500 mr-3 transition-all duration-200 ${isExpanded
              ? 'text-xs'
              : 'text-sm font-medium'
            }`}>{isExpanded ? 'Hide' : 'Show'}</span>
          <svg
            className={`text-gray-400 transition-all duration-200 ${isExpanded
                ? 'w-4 h-4 rotate-180'
                : 'w-5 h-5'
              }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-6">
          {/* Data Structure Section */}
          <div className="bg-gradient-to-r from-green-50 to-teal-50 p-6 rounded-xl border border-green-200">
            <h4 className="text-lg font-semibold text-gray-800 mb-4 flex items-center">
              <svg className="w-5 h-5 mr-2 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Prepare Your Data Import Directory (Optional)
            </h4>
            
            <p className="text-sm text-gray-700 mb-4">
              Optionally, you can organize your single-cell datasets in a data import directory. Data from this directory will be automatically copied to the workspace directory where a local S3-compatible storage is hosted. Each dataset folder must contain a <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">manifest.yaml</code> file and either <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">.h5ad</code> (AnnData) or <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">.zarr</code> files. Both formats are supported. If the same file exists in both formats, <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">.zarr</code> is used. If no zarr file is provided, one will be generated automatically when starting the data server.
            </p>

            {/* Collapsible Example Section */}
            <button
              onClick={() => setShowDataExample(!showDataExample)}
              className="flex items-center text-sm text-green-700 hover:text-green-900 transition-colors duration-200 mb-3"
            >
              <svg
                className={`w-4 h-4 mr-2 transition-transform duration-200 ${showDataExample ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {showDataExample ? 'Hide' : 'Show'} example data structure
            </button>

            {showDataExample && (
              <div className="space-y-4">
                <div className="bg-gray-900 rounded-lg p-4">
                  <pre className="text-green-400 text-sm font-mono overflow-x-auto whitespace-pre">{`/path/to/data/
├── dataset1/                    
│   ├── anndata1.h5ad        
│   ├── anndata2.h5ad
│   ├── ...      
│   └── manifest.yaml         # Required: Dataset configuration
└── dataset2/
    ├── data1.zarr/
    ├── data2.zarr/
    ├── ...
    └── manifest.yaml         # Required: Dataset configuration`}</pre>
                </div>

                <div className="bg-white rounded-lg p-4 border border-green-100">
                  <h5 className="text-sm font-semibold text-gray-800 mb-2">Example manifest.yaml</h5>
                  <pre className="text-gray-700 text-xs font-mono overflow-x-auto whitespace-pre bg-gray-50 p-3 rounded">{`id: blood-perturb-rna
name: Blood-Perturb-RNA
description: CRISPR perturbation screen in human HSPCs with scRNA-seq.
authorized_users:
  - user@example.com
  - "*"  # Use "*" for public access`}</pre>
                  <p className="text-xs text-gray-500 mt-2">
                    See the <a href="https://github.com/aicell-lab/bioengine-worker/blob/main/bioengine/datasets/README.md" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Datasets Documentation</a> for full manifest options including authors, license, and tags.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Configuration Section */}
          <div className="bg-gradient-to-r from-blue-50 to-purple-50 p-6 rounded-xl border border-blue-200">
            <h4 className="text-lg font-semibold text-gray-800 mb-4 flex items-center">
              <svg className="w-5 h-5 mr-2 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Step 1: Configure Your Worker
            </h4>

            {/* Warning for not logged in users */}
            {!user && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start">
                <svg className="w-5 h-5 text-amber-600 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-1.963-1.333-2.732 0L3.268 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="text-sm text-amber-800">
                  <p className="font-medium">Not logged in</p>
                  <p>Without logging in, you'll need to manually set a Hypha Authentication Token in the Advanced Options below.</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Data Import Directory */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Data Import Directory (Optional)</label>
                <input
                  type="text"
                  value={dataDir}
                  onChange={(e) => setDataDir(e.target.value)}
                  placeholder="/path/to/your/data"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Data will be imported to workspace directory
                </p>
              </div>

              {/* CPU Count */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">CPU Cores</label>
                <input
                  type="number"
                  min="1"
                  max="128"
                  value={cpus}
                  onChange={(e) => setCpus(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  aria-label="Number of CPU cores"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Number of CPU cores for the Ray head node
                </p>
              </div>

              {/* Memory */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Memory (GB)</label>
                <input
                  type="number"
                  min="4"
                  max="512"
                  value={memory}
                  onChange={(e) => setMemory(parseInt(e.target.value) || 4)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  aria-label="Memory in GB"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Memory allocation for the worker in GB
                </p>
              </div>

              {/* Container Runtime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Container Runtime</label>
                <select
                  value={containerRuntime}
                  onChange={(e) => setContainerRuntime(e.target.value as ContainerRuntimeType)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  aria-label="Select container runtime"
                >
                  <option value="docker">Docker</option>
                  <option value="podman">Podman</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {containerRuntime === 'docker'
                    ? 'Docker - Most common container runtime'
                    : 'Podman - Daemonless, rootless alternative to Docker'}
                </p>
              </div>

              {/* GPU Count */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">GPU Count</label>
                <input
                  type="number"
                  min="0"
                  max="8"
                  value={gpus}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    setGpus(val);
                    setHasGpu(val > 0);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  aria-label="Number of GPUs"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {gpus > 0 ? `Requires NVIDIA ${containerRuntime === 'docker' ? 'Docker runtime' : 'container toolkit'}` : 'Set to 0 for CPU-only mode'}
                </p>
              </div>

              {/* Shared Memory Size */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Shared Memory Size (GB)</label>
                <input
                  type="number"
                  min="1"
                  max="64"
                  value={shmSize}
                  onChange={(e) => setShmSize(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  aria-label="Shared memory size in GB"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Shared memory for Ray operations
                </p>
              </div>
            </div>

            {/* Advanced Options Toggle */}
            <div className="border-t border-gray-200 mt-4 pt-4">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center text-sm text-gray-600 hover:text-gray-800 transition-colors duration-200"
              >
                <svg
                  className={`w-4 h-4 mr-2 transition-transform duration-200 ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Advanced Options
              </button>
            </div>

            {/* Advanced Options */}
            {showAdvanced && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 p-4 bg-gray-50 rounded-lg">
                {/* Authentication Token */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Authentication Token</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={isGeneratingToken ? 'Generating...' : 'Token will be generated automatically'}
                      aria-label="Authentication Token"
                      className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-xs transition-all duration-300 ${
                        tokenFlash ? 'ring-2 ring-green-500 bg-green-50' : ''
                      }`}
                    />
                    <button
                      onClick={generateToken}
                      disabled={isGeneratingToken}
                      className="inline-flex items-center p-2 border border-gray-300 rounded-lg hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                      title="Refresh token"
                    >
                      {isGeneratingToken ? (
                        <svg className="animate-spin w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Auto-generated 30-day Hypha token (Permission Level: Admin)</p>
                  {tokenError && <p className="text-xs text-red-600 mt-1">{tokenError}</p>}
                </div>

                {/* Workspace */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Workspace</label>
                  <input
                    type="text"
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                    placeholder="Leave empty for token associated workspace"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Hypha workspace name</p>
                </div>

                {/* Workspace Directory */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Workspace Directory</label>
                  <input
                    type="text"
                    value={workspaceDir}
                    onChange={(e) => setWorkspaceDir(e.target.value)}
                    placeholder="~/.bioengine"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Leave empty for default (~/.bioengine)</p>
                </div>

                {/* Admin Users */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Admin Users</label>
                  <input
                    type="text"
                    value={adminUsers}
                    onChange={(e) => setAdminUsers(e.target.value)}
                    placeholder="user1,user2,user3 or *"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Leave empty for logged-in user, use * for all users</p>
                </div>

                {/* Custom Container Image */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Custom Container Image</label>
                  <input
                    type="text"
                    value={customImage}
                    onChange={(e) => setCustomImage(e.target.value)}
                    placeholder="ghcr.io/aicell-lab/tabula:0.2.3"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Leave empty for default image</p>
                </div>

                {/* GPU Indices - only show when GPU count > 0 */}
                {hasGpu && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">GPU Indices</label>
                    <input
                      type="text"
                      value={gpuIndices}
                      onChange={(e) => setGpuIndices(e.target.value)}
                      placeholder="0,1,2 (leave empty to use count)"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">Comma-separated GPU indices (e.g., 0,1,2)</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Docker Compose Preview and Download */}
          <div className="bg-gray-900 rounded-xl p-4 relative">
            <div className="flex justify-between items-start mb-4">
              <h4 className="text-lg font-medium text-gray-300 flex items-center">
                <svg className="w-5 h-5 mr-2 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Step 2: Download docker-compose.yaml
              </h4>
              <div className="flex space-x-2">
                <button
                  onClick={() => copyToClipboard(getDockerComposeContent())}
                  className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg transition-colors duration-200 flex items-center"
                >
                  {copied ? (
                    <>
                      <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
                <button
                  onClick={downloadDockerCompose}
                  className="px-4 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors duration-200 flex items-center"
                >
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download
                </button>
              </div>
            </div>
            <pre className="text-green-400 text-sm font-mono overflow-x-auto whitespace-pre-wrap">
              {getDockerComposeContent()}
            </pre>
          </div>

          {/* Environment Variables */}
          <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
            <h4 className="text-lg font-medium text-amber-800 mb-3 flex items-center">
              <svg className="w-5 h-5 mr-2 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              Step 3: Set Environment Variables
            </h4>
            <p className="text-sm text-amber-700 mb-3">
              Before running docker compose, set these environment variables in your terminal:
            </p>
            <div className="bg-gray-900 rounded-lg p-3 relative">
              <button
                onClick={() => copyToClipboard(getEnvFileContent())}
                className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors duration-200"
              >
                Copy
              </button>
              <pre className="text-green-400 text-sm font-mono overflow-x-auto whitespace-pre-wrap">
                {getEnvFileContent()}
              </pre>
            </div>
          </div>

          {/* Run Command */}
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl p-4 border border-purple-200">
            <h4 className="text-lg font-medium text-purple-800 mb-3 flex items-center">
              <svg className="w-5 h-5 mr-2 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Step 4: Start BioEngine
            </h4>
            <p className="text-sm text-purple-700 mb-3">
              Navigate to the directory containing your docker-compose.yaml file and run:
            </p>
            <div className="bg-gray-900 rounded-lg p-3 relative">
              <button
                onClick={() => copyToClipboard(getRunCommand())}
                className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors duration-200"
              >
                Copy
              </button>
              <code className="text-green-400 text-lg font-mono">
                {getRunCommand()}
              </code>
            </div>
          </div>

          {/* Prerequisites & Notes */}
          <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
            <div className="flex items-start">
              <svg className="w-5 h-5 text-blue-600 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">Prerequisites & Notes:</p>
                <ul className="list-disc list-inside space-y-1 text-blue-700">
                  <li>{containerRuntime.charAt(0).toUpperCase() + containerRuntime.slice(1)} and {containerRuntime === 'docker' ? 'Docker Compose' : 'podman-compose'} must be installed</li>
                  {hasGpu && <li>NVIDIA container toolkit required for GPU support</li>}
                  <li>The token expires after 30 days - generate a new one when needed</li>
                  <li>A ~/.bioengine workspace directory will be created for storage and S3-compatible data hosting</li>
                  {dataDir && <li>Data from the import directory will be automatically copied to the workspace directory at startup</li>}
                  <li>After starting, the worker will connect to the Chiron platform automatically</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Troubleshooting Button */}
          <div className="flex justify-center pt-4 border-t border-gray-200">
            <button
              onClick={() => setShowTroubleshooting(true)}
              className="flex items-center px-4 py-2 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 hover:border-orange-300 transition-colors duration-200"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Need Help? Get AI Troubleshooting Prompt
            </button>
          </div>
        </div>
      )}

      {/* Troubleshooting Dialog */}
      {showTroubleshooting && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div ref={troubleshootingDialogRef} className="bg-white rounded-2xl shadow-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl flex items-center justify-center mr-3">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-800">AI Troubleshooting Assistant</h3>
                  <p className="text-sm text-gray-600">Copy this prompt to ChatGPT, Claude, Gemini, or your favorite LLM</p>
                </div>
              </div>
              <button
                onClick={() => setShowTroubleshooting(false)}
                className="text-gray-400 hover:text-gray-600 p-2 rounded-xl hover:bg-gray-100 transition-all duration-200"
                aria-label="Close dialog"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 p-6 overflow-hidden flex flex-col">
              <div className="mb-4">
                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-sm font-medium text-gray-700">Troubleshooting Prompt</h4>
                  <button
                    onClick={copyTroubleshootingPrompt}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors duration-200 flex items-center"
                  >
                    {promptCopied ? (
                      <>
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Copied!
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Copy Prompt
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  This prompt includes your current configuration and troubleshooting guidelines.
                  Just add your specific question or error message at the end.
                </p>
              </div>

              <div className="flex-1 overflow-auto">
                <pre className="text-xs text-gray-700 bg-gray-50 p-4 rounded-lg border whitespace-pre-wrap font-mono leading-relaxed">
                  {getTroubleshootingPrompt()}
                </pre>
              </div>

              <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-between items-center">
                <div className="text-sm text-gray-600">
                  <p className="font-medium mb-1">How to use:</p>
                  <ol className="list-decimal list-inside space-y-1 text-xs">
                    <li>Copy the prompt above</li>
                    <li>Paste it into ChatGPT, Claude, or your preferred AI assistant</li>
                    <li>Add your specific question or error message at the end</li>
                    <li>Get detailed, context-aware troubleshooting help</li>
                  </ol>
                </div>
                <button
                  onClick={() => setShowTroubleshooting(false)}
                  className="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors duration-200"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BioEngineGuide;