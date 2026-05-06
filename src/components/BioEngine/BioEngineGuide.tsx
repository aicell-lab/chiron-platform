import React, { useState, useRef, useEffect, useCallback } from 'react';
import { hyphaWebsocketClient } from 'hypha-rpc';
import { useHyphaStore } from '../../store/hyphaStore';

type OSType = 'linux' | 'macos' | 'windows';
type ContainerRuntimeType = 'docker' | 'podman' | 'singularity' | 'apptainer';

// Tag-badge input: space/enter commits a tag, backspace on empty field focuses last tag,
// arrow keys navigate tags, delete/backspace removes focused tag.
const TagInput: React.FC<{
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  allowWildcard?: boolean;
}> = ({ tags, onChange, placeholder, allowWildcard = true }) => {
  const [inputValue, setInputValue] = useState('');
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const commit = (value: string) => {
    const v = value.trim();
    if (v && !tags.includes(v) && (allowWildcard || v !== '*')) onChange([...tags, v]);
    setInputValue('');
  };

  const remove = (idx: number) => {
    const next = tags.filter((_, i) => i !== idx);
    onChange(next);
    if (next.length === 0) { setFocusedIdx(null); inputRef.current?.focus(); }
    else if (idx >= next.length) setFocusedIdx(next.length - 1);
    else setFocusedIdx(idx);
  };

  useEffect(() => {
    if (focusedIdx === null) return;
    const els = containerRef.current?.querySelectorAll<HTMLElement>('[data-tag-badge]');
    els?.[focusedIdx]?.focus();
  }, [focusedIdx]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === ' ' || e.key === 'Enter') && inputValue.trim()) {
      e.preventDefault(); commit(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      e.preventDefault(); setFocusedIdx(tags.length - 1);
    } else if (e.key === 'ArrowLeft' && !inputValue && tags.length > 0) {
      e.preventDefault(); setFocusedIdx(tags.length - 1);
    }
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>, idx: number) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault(); remove(idx);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx > 0) setFocusedIdx(idx - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx < tags.length - 1) setFocusedIdx(idx + 1);
      else { setFocusedIdx(null); inputRef.current?.focus(); }
    } else if (e.key.length === 1) {
      setFocusedIdx(null); inputRef.current?.focus();
    }
  };

  return (
    <div
      ref={containerRef}
      onClick={() => { if (focusedIdx === null) inputRef.current?.focus(); }}
      className="flex flex-wrap gap-1.5 items-center min-h-[38px] px-2.5 py-1.5 border border-gray-300 rounded-lg focus-within:ring-2 focus-within:ring-blue-500 bg-white cursor-text"
    >
      {tags.map((tag, i) => (
        <span
          key={tag}
          data-tag-badge
          tabIndex={0}
          onFocus={() => setFocusedIdx(i)}
          onBlur={() => setFocusedIdx(null)}
          onKeyDown={(e) => handleTagKeyDown(e, i)}
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border outline-none select-none
            ${tag === '*'
              ? 'bg-emerald-100 text-emerald-700 border-emerald-300 focus:ring-2 focus:ring-emerald-400'
              : 'bg-blue-100 text-blue-700 border-blue-200 focus:ring-2 focus:ring-blue-400'}`}
        >
          {tag === '*' ? '* public' : tag}
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); remove(i); }}
            className="opacity-50 hover:opacity-100 leading-none ml-0.5"
            aria-label={`Remove ${tag}`}
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        placeholder={tags.length === 0 ? placeholder : ''}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleInputKeyDown}
        onFocus={() => setFocusedIdx(null)}
        onBlur={() => { if (inputValue.trim()) commit(inputValue); }}
        className="flex-1 min-w-[140px] outline-none text-sm bg-transparent py-0.5"
      />
    </div>
  );
};

const DEFAULT_IMAGE = 'ghcr.io/aicell-lab/tabula:0.3.0';

const BioEngineGuide: React.FC = () => {
  const { server, isLoggedIn } = useHyphaStore();

  const [os, setOS] = useState<OSType>('linux');
  const [containerRuntime, setContainerRuntime] = useState<ContainerRuntimeType>('docker');
  const [shmSize, setShmSize] = useState('8g');
  const [cpus, setCpus] = useState(4);
  const [gpus, setGpus] = useState(1);
  const [memory, setMemory] = useState(30);
  const [dataDir, setDataDir] = useState('');

  const [copied, setCopied] = useState(false);
  const [copiedStep1, setCopiedStep1] = useState(false);
  const [copiedStep2, setCopiedStep2] = useState(false);
  const [copiedStep3, setCopiedStep3] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [showDataExample, setShowDataExample] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [timezone, setTimezone] = useState('');

  const [token, setToken] = useState('');
  const [tokenIsManual, setTokenIsManual] = useState(false);
  const [isGeneratingToken, setIsGeneratingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [workspaceResolved, setWorkspaceResolved] = useState(false);

  const [adminUsers, setAdminUsers] = useState<string[]>([]);
  const [managerAuthorizedUsers, setManagerAuthorizedUsers] = useState<string[]>([]);
  const [workerName, setWorkerName] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [gpuIndices, setGpuIndices] = useState('');
  const [customImage, setCustomImage] = useState('');
  const [platformOverride, setPlatformOverride] = useState('');

  const troubleshootingDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showTroubleshooting && troubleshootingDialogRef.current) {
      setTimeout(() => {
        troubleshootingDialogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [showTroubleshooting]);

  useEffect(() => {
    try {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setTimezone('UTC');
    }
  }, []);

  const generateToken = useCallback(async () => {
    if (!isLoggedIn || !server) return;
    setIsGeneratingToken(true);
    setTokenError(null);
    try {
      const thirtyDays = 30 * 24 * 3600;
      const newToken = await server.generateToken({ permission: 'admin', expires_in: thirtyDays });
      setToken(newToken);
      setTokenIsManual(false);
    } catch (err) {
      setTokenError(`Failed to generate token: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsGeneratingToken(false);
    }
  }, [isLoggedIn, server]);

  useEffect(() => {
    if (isLoggedIn && !tokenIsManual && !token) {
      generateToken();
    }
  }, [isLoggedIn, tokenIsManual, token, generateToken]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const resolveWorkspace = async () => {
      try {
        const url = serverUrl || 'https://hypha.aicell.io';
        const tmpServer = await hyphaWebsocketClient.connectToServer({ server_url: url, token });
        if (!cancelled) {
          const ws = tmpServer?.config?.workspace as string | undefined;
          if (ws) {
            setWorkspace(ws);
            setWorkspaceResolved(true);
          }
        }
        try { await tmpServer?.disconnect?.(); } catch (_) { /* ignore */ }
      } catch (_) { /* silently ignore */ }
    };
    setWorkspaceResolved(false);
    resolveWorkspace();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const isComposeRuntime = () => containerRuntime === 'docker' || containerRuntime === 'podman';

  const getWorkspaceDirPath = () => {
    if (workspaceDir) return workspaceDir;
    if (os === 'windows') return '%USERPROFILE%\\.bioengine';
    return '$HOME/.bioengine';
  };

  // Derive a clean SIF filename from the image reference
  const getSifFilename = () => {
    const img = customImage || DEFAULT_IMAGE;
    const parts = img.split('/');
    const nameTag = parts[parts.length - 1]; // e.g. "tabula:0.3.0"
    return nameTag.replace(':', '_') + '.sif'; // "tabula_0.3.0.sif"
  };

  // Build the common worker arg list (used by both compose and singularity)
  const buildWorkerArgs = (indent: string): string => {
    const adminUsersStr = adminUsers.length > 0
      ? adminUsers.map(u => `"${u}"`).join(' ')
      : '';
    return [
      '--mode single-machine',
      `--head-num-cpus ${cpus}`,
      gpus > 0 ? `--head-num-gpus ${gpus}` : '--head-num-gpus 0',
      `--head-memory-in-gb ${memory}`,
      (() => {
        const authPart = managerAuthorizedUsers.length > 0
          ? `, \\"authorized_users\\": [${managerAuthorizedUsers.map(u => `\\"${u}\\"`).join(', ')}]`
          : '';
        return `--startup-applications "{\\"artifact_id\\": \\"chiron-platform/chiron-manager\\", \\"application_id\\": \\"chiron-manager\\"${authPart}}"`;
      })(),
      adminUsersStr ? `--admin-users ${adminUsersStr}` : '',
      workspace ? `--workspace "${workspace}"` : '',
      `--worker-name "${workerName || 'Chiron Worker'}"`,
      clientId ? `--client-id "${clientId}"` : '',
      serverUrl ? `--server-url "${serverUrl}"` : '',
      '--dashboard-url "https://chiron.aicell.io/#/worker"',
    ].filter(Boolean).join(`\n${indent}`);
  };

  const getDockerComposeContent = () => {
    const imageToUse = customImage || DEFAULT_IMAGE;
    const workspaceDirPath = getWorkspaceDirPath();
    const workerSlug = (workerName || 'Chiron Worker')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const platformLine = platformOverride ? `\n    platform: ${platformOverride}` : '';

    // GPU configuration
    let gpuConfig = '';
    if (gpus > 0) {
      if (gpuIndices) {
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

    const workerArgs = buildWorkerArgs('      ');

    // Data-server service — only included when a data directory is configured.
    // The data-server requires --data-dir and will fail without it.
    const dataServerService = dataDir ? `  data-server:
    image: "${imageToUse}"${platformLine}
    container_name: ${workerSlug}-data-server
    user: "\${UID}:\${GID}"
    volumes:
      - "${workspaceDirPath}:/home/.bioengine"
      - "${dataDir}:/data"
    environment:
      - HOME=/home
      - TZ=${timezone || 'UTC'}
    command: >
      python -m tabula.datasets
      --data-dir /data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:39527/health/liveness"]
      start_period: 60s
      start_interval: 5s
      interval: 30s
      timeout: 10s
      retries: 3

` : '';

    // Worker depends on data-server only when the data-server is present
    const dependsOn = dataDir ? `    depends_on:
      data-server:
        condition: service_healthy
` : '';

    return `services:
${dataServerService}  worker:
    image: "${imageToUse}"${platformLine}
    container_name: ${workerSlug}-worker
    user: "\${UID}:\${GID}"
    shm_size: ${shmSize}
    volumes:
      - "${workspaceDirPath}:/home/.bioengine"${dataDir ? `\n      - "${dataDir}:/data"` : ''}
    environment:
      - HOME=/home
      - HYPHA_TOKEN=\${HYPHA_TOKEN}
      - TZ=${timezone || 'UTC'}
    command: >
      python -m bioengine.worker
      ${workerArgs}
    restart: unless-stopped${gpuConfig}
${dependsOn}`;
  };

  const getEnvSetupCommands = () => {
    const dirPath = getWorkspaceDirPath();
    if (os === 'windows') {
      // Windows / Docker only
      return `set UID=0
set GID=0
set HYPHA_TOKEN=${token || '<set_token_here>'}
md "${dirPath}" 2>nul`;
    }
    if (isComposeRuntime()) {
      return `export UID=$(id -u)
export GID=$(id -g)
export HYPHA_TOKEN=${token || '<set_token_here>'}
mkdir -p ${dirPath}`;
    }
    // Singularity / Apptainer — no UID/GID needed (process runs as caller)
    return `export HYPHA_TOKEN=${token || '<set_token_here>'}
mkdir -p ${dirPath}`;
  };

  const getPullCommand = () => {
    const bin = containerRuntime;
    const image = `docker://${customImage || DEFAULT_IMAGE}`;
    const sif = getSifFilename();
    return `# Pull and convert the Docker image to a local SIF file (~10 GB, one-time)
${bin} pull ${sif} ${image}`;
  };

  const getRunCommand = () => {
    if (containerRuntime === 'docker') return 'docker compose up';
    if (containerRuntime === 'podman') return 'podman-compose up';

    // Singularity / Apptainer
    const bin = containerRuntime;
    const sif = getSifFilename();
    const gpuFlag = gpus > 0 ? '--nv ' : '';
    const workspacePath = getWorkspaceDirPath();

    const bindParts = [
      `${workspacePath}:/home/.bioengine`,
      ...(dataDir ? [`${dataDir}:/data`] : []),
    ];
    const bindStr = `--bind ${bindParts.join(',')}`;
    const dataDirArg = dataDir ? ' \\\n  --data-dir /data' : '';

    // Singularity worker args (single-quote wrapped for shell safety)
    const adminUsersStr = adminUsers.length > 0
      ? adminUsers.map(u => `"${u}"`).join(' ')
      : '';
    const workerArgsList = [
      '--mode single-machine',
      `--head-num-cpus ${cpus}`,
      `--head-num-gpus ${gpus}`,
      `--head-memory-in-gb ${memory}`,
      (() => {
        const authPart = managerAuthorizedUsers.length > 0
          ? `,"authorized_users":[${managerAuthorizedUsers.map(u => `"${u}"`).join(',')}]`
          : '';
        return `--startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager"${authPart}}'`;
      })(),
      adminUsersStr ? `--admin-users ${adminUsersStr}` : '',
      workspace ? `--workspace "${workspace}"` : '',
      `--worker-name "${workerName || 'Chiron Worker'}"`,
      clientId ? `--client-id "${clientId}"` : '',
      serverUrl ? `--server-url "${serverUrl}"` : '',
      '--dashboard-url "https://chiron.aicell.io/#/worker"',
    ].filter(Boolean);
    const workerArgsStr = workerArgsList.join(' \\\n  ');

    const dataServerBlock = dataDir ? `# Start data server in background
${bin} exec \\
  ${bindStr} \\
  --env HOME=/home \\
  ${sif} python -m tabula.datasets${dataDirArg} &
DATA_SERVER_PID=$!

# Wait for data server health check
until curl -sf http://localhost:39527/health/liveness > /dev/null; do sleep 2; done

` : '';

    return `${dataServerBlock}# Start BioEngine worker (foreground, Ctrl+C to stop)
${bin} exec ${gpuFlag}\\
  ${bindStr} \\
  --env HOME=/home \\
  --env HYPHA_TOKEN=$HYPHA_TOKEN \\
  ${sif} python -m bioengine.worker \\
  ${workerArgsStr}`;
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

  const getTroubleshootingPrompt = () => {
    const runtimeName = containerRuntime.charAt(0).toUpperCase() + containerRuntime.slice(1);
    const step1Content = isComposeRuntime()
      ? getDockerComposeContent().replace(token, '<my-token>')
      : getPullCommand();

    return `# BioEngine Worker Troubleshooting (Chiron Platform)

I'm trying to set up a **BioEngine Worker** for the Chiron federated learning platform for single-cell analysis.

Source code: https://github.com/aicell-lab/bioengine-worker

## My Setup

- **Operating System**: ${os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows'}
- **Container Runtime**: ${runtimeName}
- **CPUs**: ${cpus}
- **GPUs**: ${gpus}${gpus > 0 && gpuIndices ? ` (indices: ${gpuIndices})` : ''}
- **Memory**: ${memory} GB${isComposeRuntime() ? `\n- **Shared Memory**: ${shmSize}` : ''}
${adminUsers.length > 0 ? `- **Admin Users**: ${adminUsers.join(', ')}` : '- **Admin Users**: Default (logged-in user)'}
${dataDir ? `- **Data Directory**: ${dataDir}` : '- **Data Directory**: Not set (Orchestrator-only)'}
${customImage ? `- **Custom Image**: ${customImage}` : ''}

## Step 1: ${isComposeRuntime() ? 'docker-compose.yaml' : 'Pull command'}

\`\`\`${isComposeRuntime() ? 'yaml' : 'bash'}
${step1Content}
\`\`\`

## Step 2: Environment variables

\`\`\`bash
${getEnvSetupCommands()}
\`\`\`

## Step 3: Run command

\`\`\`bash
${getRunCommand()}
\`\`\`

## My Issue

[Paste your error message or describe your problem here]`;
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

  const runtimeSubtitle = () => {
    if (containerRuntime === 'docker') return 'Docker Compose: desktop, workstation, or server';
    if (containerRuntime === 'podman') return 'Podman Compose: rootless alternative to Docker';
    if (containerRuntime === 'singularity') return 'Singularity: HPC clusters and shared systems';
    return 'Apptainer: HPC clusters and shared systems';
  };

  const CopyButton: React.FC<{ getText: () => string; copied: boolean; onCopied: () => void }> = ({ getText, copied: isCopied, onCopied }) => (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(getText()); onCopied(); } catch (_) {}
      }}
      className="flex items-center px-2 py-1 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
    >
      {isCopied ? (
        <><svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied!</>
      ) : (
        <><svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
      )}
    </button>
  );

  return (
    <div className="pt-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center justify-between text-left rounded-xl p-4 transition-all duration-200 ${
          isExpanded
            ? 'bg-gray-50 hover:bg-gray-100 border border-gray-200'
            : 'bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 border-2 border-blue-200 hover:shadow-md'
        }`}
      >
        <div className="flex items-center">
          <div className={`rounded-xl flex items-center justify-center mr-4 transition-all duration-200 ${
            isExpanded
              ? 'w-8 h-8 bg-gradient-to-r from-gray-400 to-gray-500'
              : 'w-12 h-12 bg-gradient-to-r from-cyan-500 to-blue-600 shadow-md'
          }`}>
            <svg className={`text-white transition-all duration-200 ${isExpanded ? 'w-4 h-4' : 'w-6 h-6'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h4 className={`font-semibold transition-all duration-200 ${isExpanded ? 'text-sm text-gray-700' : 'text-lg text-gray-800'}`}>
              Launch Your Own BioEngine Instance
            </h4>
            <p className={`text-gray-500 transition-all duration-200 ${isExpanded ? 'text-xs' : 'text-sm font-medium'}`}>
              {isExpanded ? runtimeSubtitle() : 'Set up a worker on your machine or HPC cluster'}
            </p>
          </div>
        </div>
        <div className="flex items-center">
          <span className={`text-gray-500 mr-3 transition-all duration-200 ${isExpanded ? 'text-xs' : 'text-sm font-medium'}`}>
            {isExpanded ? 'Hide' : 'Show'}
          </span>
          <svg className={`text-gray-400 transition-all duration-200 ${isExpanded ? 'w-4 h-4 rotate-180' : 'w-5 h-5'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-6">

          {/* Container runtime required */}
          <div className="p-4 bg-orange-50 rounded-xl border border-orange-200">
            <p className="text-sm font-semibold text-orange-800 mb-1">Container runtime required</p>
            <p className="text-sm text-orange-700">
              The Chiron worker runs inside a container image (~10 GB, pulled automatically on first use).{' '}
              <strong>Docker</strong> and <strong>Podman</strong> use Docker Compose to manage the two services.{' '}
              <strong>Singularity</strong> and <strong>Apptainer</strong> run each process directly, recommended for HPC clusters where Docker is unavailable.
            </p>
            {gpus > 0 && (
              <p className="text-sm text-orange-700 mt-2">
                <strong>GPU support: </strong>
                {isComposeRuntime() ? (
                  <>Requires the <strong>NVIDIA Container Toolkit</strong> on the host. See the{' '}
                    <a href="https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-orange-900">installation guide</a>.
                  </>
                ) : (
                  <>Pass <code className="bg-orange-100 px-1 rounded">--nv</code> to expose NVIDIA GPUs to the container. NVIDIA drivers must be installed on the host; no additional toolkit is required on most HPC systems.</>
                )}
              </p>
            )}
          </div>

          {/* Data Import Directory */}
          <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
            <div className="flex items-start">
              <svg className="w-4 h-4 text-blue-500 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm text-blue-800 flex-1">
                <span className="font-medium">Data Import Directory</span>
                <span className="text-blue-700 text-xs block mt-1">
                  A <strong>Tabula Trainer</strong> requires a local directory of single-cell datasets (<code className="bg-blue-100 px-1 rounded">.h5ad</code> or <code className="bg-blue-100 px-1 rounded">.zarr</code>).
                  Set the path below to mount it into the data server. Each dataset subfolder must contain a <code className="bg-blue-100 px-1 rounded">manifest.yaml</code>.
                  If only <code className="bg-blue-100 px-1 rounded">.h5ad</code> files are present, Zarr conversion runs automatically on first start and re-checks every 30 seconds for new files.
                  <br />
                  An <strong>Orchestrator</strong> coordinates training without local data. Leave this field empty to omit the data server entirely.
                </span>
                <button
                  onClick={() => setShowDataExample(!showDataExample)}
                  className="flex items-center text-xs text-blue-600 hover:text-blue-900 transition-colors mt-2"
                >
                  <svg className={`w-3 h-3 mr-1 transition-transform ${showDataExample ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {showDataExample ? 'Hide' : 'Show'} example data structure
                </button>
                {showDataExample && (
                  <div className="mt-3 space-y-3">
                    <div className="bg-gray-900 rounded-lg p-3">
                      <pre className="text-green-400 text-xs font-mono overflow-x-auto whitespace-pre">{`/path/to/data/
├── liver/
│   ├── liver_healthy.h5ad
│   ├── liver_disease.h5ad
│   └── manifest.yaml
├── blood/
│   ├── pbmc_10k.zarr/
│   └── manifest.yaml
└── thymus/
    ├── thymus_adult.h5ad
    ├── thymus_fetal.zarr/
    └── manifest.yaml`}</pre>
                    </div>
                    <div className="bg-white rounded-lg p-3 border border-blue-100">
                      <p className="text-xs font-semibold text-gray-800 mb-2">Minimal manifest.yaml</p>
                      <pre className="text-gray-700 text-xs font-mono overflow-x-auto whitespace-pre bg-gray-50 p-2 rounded">{`id: my-dataset
name: My Dataset
description: Brief description of the dataset.
authorized_users:
  - user@example.com
  - "*"  # Use "*" for public access`}</pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* BioEngine Workspace Directory */}
          <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
            <div className="flex items-start">
              <svg className="w-4 h-4 text-blue-500 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-blue-800">
                <span className="font-medium">BioEngine Workspace Directory: </span>
                <code className="bg-blue-100 px-1 rounded">{getWorkspaceDirPath()}</code>
                <span className="text-blue-700 text-xs block mt-1">
                  Created on the host and mounted into the container(s). Stores worker app data, Ray state, logs, and temporary files. Change it under Advanced Options below.
                </span>
              </p>
            </div>
          </div>

          {/* Authentication warning */}
          {!token && (
            <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
              <div className="flex items-start">
                <svg className="w-5 h-5 text-amber-600 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div className="text-sm text-amber-800">
                  <p className="font-medium mb-1">Authentication Required</p>
                  <div className="text-amber-700 space-y-1">
                    {isLoggedIn ? (
                      <p>Generating your authentication token… or set one manually in <strong>Advanced Options → Authentication Token</strong>.</p>
                    ) : (
                      <>
                        <p>An authentication token is required to connect the worker to Hypha. Either:</p>
                        <ol className="list-decimal list-inside space-y-1 ml-2 text-xs">
                          <li><strong>Log in</strong> to auto-generate a 30-day admin token, or</li>
                          <li>Set a token manually in <strong>Advanced Options → Authentication Token</strong></li>
                        </ol>
                        <p className="text-xs italic mt-1">Manually provided tokens must have <strong>Permission Level: Admin</strong>.</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Configure Worker */}
          <div>
            <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
              <h5 className="text-sm font-semibold text-gray-700 mb-3">Container &amp; Compute</h5>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Operating System</label>
                  <select value={os} onChange={(e) => setOS(e.target.value as OSType)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="linux">Linux</option>
                    <option value="macos">macOS</option>
                    <option value="windows">Windows</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Container Runtime</label>
                  <select value={containerRuntime} onChange={(e) => setContainerRuntime(e.target.value as ContainerRuntimeType)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="docker">Docker</option>
                    <option value="podman">Podman</option>
                    <option value="singularity">Singularity</option>
                    <option value="apptainer">Apptainer</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    {containerRuntime === 'docker' ? 'Most common runtime, requires Docker Compose' :
                     containerRuntime === 'podman' ? 'Rootless Docker alternative, requires Podman Compose' :
                     containerRuntime === 'singularity' ? 'HPC-compatible, no root required' :
                     'Singularity successor, common on newer HPC systems'}
                  </p>
                </div>

                {/* Shared memory — compose only */}
                {isComposeRuntime() && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Shared Memory Size</label>
                    <select value={shmSize} onChange={(e) => setShmSize(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {['1g','2g','4g','6g','8g','10g','12g','16g'].map(v => (
                        <option key={v} value={v}>{v.replace('g', ' GB')}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">Shared memory for the worker container. Increase for large models.</p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">CPU Cores</label>
                  <input type="number" min="1" max="128" value={cpus}
                    onChange={(e) => setCpus(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="text-xs text-gray-500 mt-1">CPUs allocated to the Ray head node</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">GPUs</label>
                  <input type="number" min="0" max="16" value={gpus}
                    onChange={(e) => setGpus(parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="text-xs text-gray-500 mt-1">
                    {gpus > 0
                      ? (isComposeRuntime() ? 'Requires NVIDIA Container Toolkit on host' : 'Enables --nv GPU passthrough flag')
                      : 'Set to 0 for CPU-only mode (e.g. Orchestrator)'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Memory (GB)</label>
                  <input type="number" min="4" max="512" value={memory}
                    onChange={(e) => setMemory(parseInt(e.target.value) || 4)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="text-xs text-gray-500 mt-1">RAM for the Ray head node in GB</p>
                </div>

                {/* Worker Name (1/3) + Training Data Directory (2/3) */}
                <div className="md:col-span-2 lg:col-span-3 grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Worker Name</label>
                    <input type="text" value={workerName} onChange={(e) => setWorkerName(e.target.value)}
                      placeholder="Chiron Worker"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Display name for this worker in the Chiron UI</p>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Training Data Directory</label>
                    <input
                      type="text"
                      value={dataDir}
                      onChange={(e) => setDataDir(e.target.value)}
                      placeholder="/path/to/your/single-cell/data"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Path to your local single-cell datasets for model training. Required for a <strong>Tabula Trainer</strong>.
                      Leave empty if running an <strong>Orchestrator only</strong>. The data server will be omitted.
                    </p>
                  </div>
                </div>

                {/* Chiron Manager Authorized Users — full-width row */}
                <div className="md:col-span-2 lg:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Chiron Manager Authorized Users</label>
                  <TagInput
                    tags={managerAuthorizedUsers}
                    onChange={setManagerAuthorizedUsers}
                    placeholder="user@example.com or *"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Who can manage and use this worker in the Chiron Platform. Use <code className="bg-gray-100 px-0.5 rounded">*</code> to allow all users.
                    Leave empty to restrict to admin users only. Press Space or Enter to add.
                  </p>
                </div>

              </div>
            </div>

            {/* Advanced Options */}
            <div className="border-t border-gray-200 mt-4 pt-4">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                <svg className={`w-4 h-4 mr-2 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Advanced Options
              </button>

              {showAdvanced && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Admin Users</label>
                    <TagInput
                      tags={adminUsers}
                      onChange={setAdminUsers}
                      placeholder="user@example.com"
                      allowWildcard={false}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Users who can manage and redeploy apps on this worker. Leave empty to use the logged-in user. Press Space or Enter to add.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">BioEngine Workspace Directory</label>
                    <input type="text" value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)}
                      placeholder={os === 'windows' ? '%USERPROFILE%\\.bioengine' : '$HOME/.bioengine'}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">
                      Directory for app data, logs, and Ray cluster state. Defaults to {os === 'windows' ? '%USERPROFILE%\\.bioengine' : '$HOME/.bioengine'}.
                    </p>
                  </div>

                  <div className="md:col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-medium text-gray-700">Authentication Token</label>
                      {isLoggedIn && (
                        <button
                          type="button"
                          onClick={() => { setTokenIsManual(false); generateToken(); }}
                          disabled={isGeneratingToken}
                          className="flex items-center px-2 py-1 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 transition-colors"
                        >
                          {isGeneratingToken ? (
                            <div className="w-3 h-3 border border-blue-600 border-t-transparent rounded-full animate-spin mr-1" />
                          ) : (
                            <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          )}
                          Regenerate (30 days)
                        </button>
                      )}
                    </div>
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => { setToken(e.target.value); setTokenIsManual(true); }}
                      placeholder={isLoggedIn ? (isGeneratingToken ? 'Generating…' : 'Auto-generated. Paste to override.') : 'Paste your Hypha token'}
                      autoComplete="new-password"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {tokenError && <p className="text-xs text-red-600 mt-1">{tokenError}</p>}
                    {isLoggedIn && !tokenIsManual && token && (
                      <p className="text-xs text-green-600 mt-1">Auto-generated 30-day admin token. Regenerate when it expires using the button above.</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">Required. Manually provided tokens must have <strong>Permission Level: Admin</strong>.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Server URL</label>
                    <input type="text" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://hypha.aicell.io"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Hypha server URL (defaults to public server)</p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-medium text-gray-700">Hypha Workspace</label>
                      {workspaceResolved && workspace && (
                        <span className="flex items-center text-xs text-green-600">
                          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Resolved from token
                        </span>
                      )}
                    </div>
                    <input type="text" value={workspace}
                      onChange={(e) => { setWorkspace(e.target.value); setWorkspaceResolved(false); }}
                      placeholder="my-workspace" autoComplete="off"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Hypha workspace for service registration (auto-resolved from token)</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
                    <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Custom client ID (auto-generated if empty)</p>
                  </div>

                  {gpus > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">GPU Indices</label>
                      <input type="text" value={gpuIndices} onChange={(e) => setGpuIndices(e.target.value)}
                        placeholder="0,1,2 (leave empty to use count)"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <p className="text-xs text-gray-500 mt-1">Comma-separated GPU device IDs. Leave empty to use the GPU count above</p>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Container Image</label>
                    <input type="text" value={customImage} onChange={(e) => setCustomImage(e.target.value)}
                      placeholder={DEFAULT_IMAGE}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Custom image tag. Leave empty for default ({DEFAULT_IMAGE})</p>
                  </div>

                  {/* Platform override — compose only */}
                  {isComposeRuntime() && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Platform Override</label>
                      <select value={platformOverride} onChange={(e) => setPlatformOverride(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">Auto-detect (default)</option>
                        <option value="linux/amd64">linux/amd64</option>
                        <option value="linux/arm64">linux/arm64</option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1">Override platform only if auto-detection is wrong</p>
                    </div>
                  )}

                </div>
              )}
            </div>
          </div>

          {/* ── Steps 1–3 ── */}
          <div className="space-y-3">

            {/* Step 1 */}
            {isComposeRuntime() ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm text-gray-700 font-medium">1. Download docker-compose.yaml</p>
                  <div className="flex items-center space-x-2">
                    <CopyButton
                      getText={getDockerComposeContent}
                      copied={copiedStep1}
                      onCopied={() => { setCopiedStep1(true); setTimeout(() => setCopiedStep1(false), 2000); }}
                    />
                    <button
                      onClick={downloadDockerCompose}
                      className="flex items-center px-2 py-1 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
                    >
                      <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download
                    </button>
                  </div>
                </div>
                <div className="bg-gray-900 rounded-lg p-3 overflow-x-auto">
                  <pre className="text-green-400 text-xs font-mono whitespace-pre">{getDockerComposeContent()}</pre>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {dataDir
                    ? <>Two-service stack: <strong>data-server</strong> (serves datasets from disk, health-checked) + <strong>worker</strong> (BioEngine + Ray). The worker waits for the data server to be healthy before starting.</>
                    : <>Single-service stack: <strong>worker</strong> only (BioEngine + Ray). No data server is started. Suitable for an Orchestrator-only worker.</>
                  }
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm text-gray-700 font-medium">1. Pull container image</p>
                  <CopyButton
                    getText={getPullCommand}
                    copied={copiedStep1}
                    onCopied={() => { setCopiedStep1(true); setTimeout(() => setCopiedStep1(false), 2000); }}
                  />
                </div>
                <div className="bg-gray-900 rounded-lg p-3 overflow-x-auto">
                  <pre className="text-green-400 text-xs font-mono whitespace-pre">{getPullCommand()}</pre>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Downloads and converts the Docker image to a local SIF file (~10 GB). Run once; subsequent starts use the cached file.
                  Set <code className="bg-gray-100 px-1 rounded">SINGULARITY_CACHEDIR</code> (or <code className="bg-gray-100 px-1 rounded">APPTAINER_CACHEDIR</code>) to control where the conversion cache is stored.
                </p>
              </div>
            )}

            {/* Step 2: Environment variables */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm text-gray-700 font-medium">2. Set environment variables</p>
                <CopyButton
                  getText={getEnvSetupCommands}
                  copied={copiedStep2}
                  onCopied={() => { setCopiedStep2(true); setTimeout(() => setCopiedStep2(false), 2000); }}
                />
              </div>
              <div className="bg-gray-900 rounded-lg p-3 overflow-x-auto">
                <pre className="text-green-400 text-xs font-mono whitespace-pre">{getEnvSetupCommands()}</pre>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                The token expires after <strong>30 days</strong>. Regenerate it in Advanced Options, then update <code className="bg-gray-100 px-1 rounded">HYPHA_TOKEN</code> and restart the worker.
              </p>
            </div>

            {/* Step 3: Start BioEngine */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm text-gray-700 font-medium">3. Start BioEngine</p>
                <CopyButton
                  getText={getRunCommand}
                  copied={copiedStep3}
                  onCopied={() => { setCopiedStep3(true); setTimeout(() => setCopiedStep3(false), 2000); }}
                />
              </div>
              <div className="bg-gray-900 rounded-lg p-3 overflow-x-auto">
                <pre className="text-green-400 text-xs font-mono whitespace-pre">{getRunCommand()}</pre>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {containerRuntime === 'docker' && (
                  <>Add <code className="bg-gray-100 px-1 rounded">-d</code> to run in the background. View logs with <code className="bg-gray-100 px-1 rounded">docker compose logs -f</code>. Stop with <code className="bg-gray-100 px-1 rounded">docker compose down</code>.</>
                )}
                {containerRuntime === 'podman' && (
                  <>Add <code className="bg-gray-100 px-1 rounded">-d</code> to run in the background. View logs with <code className="bg-gray-100 px-1 rounded">podman-compose logs -f</code>. Stop with <code className="bg-gray-100 px-1 rounded">podman-compose down</code>.</>
                )}
                {(containerRuntime === 'singularity' || containerRuntime === 'apptainer') && (
                  <>
                    Run inside a persistent session (<code className="bg-gray-100 px-1 rounded">tmux</code> or <code className="bg-gray-100 px-1 rounded">screen</code>) or a SLURM batch job.
                    {dataDir && <> The data server runs in the background (<code className="bg-gray-100 px-1 rounded">$DATA_SERVER_PID</code>) and the worker runs in the foreground. Stop both with <code className="bg-gray-100 px-1 rounded">Ctrl+C</code> then <code className="bg-gray-100 px-1 rounded">kill $DATA_SERVER_PID</code>.</>}
                    {!dataDir && <> The worker runs in the foreground. Stop with <code className="bg-gray-100 px-1 rounded">Ctrl+C</code>.</>}
                  </>
                )}
              </p>
            </div>

          </div>

          {/* Troubleshooting */}
          <div className="flex justify-center pt-4 border-t border-gray-200">
            <button
              onClick={() => setShowTroubleshooting(true)}
              className="flex items-center px-4 py-2 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 hover:border-orange-300 transition-colors"
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
                  <p className="text-sm text-gray-600">Copy this prompt to ChatGPT, Claude, Gemini, or your preferred LLM</p>
                </div>
              </div>
              <button
                onClick={() => setShowTroubleshooting(false)}
                className="text-gray-400 hover:text-gray-600 p-2 rounded-xl hover:bg-gray-100 transition-all"
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
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center"
                  >
                    {promptCopied ? (
                      <><svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied!</>
                    ) : (
                      <><svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy Prompt</>
                    )}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  This prompt includes your current configuration. Add your specific error message or question at the end.
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
                  </ol>
                </div>
                <button
                  onClick={() => setShowTroubleshooting(false)}
                  className="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
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
