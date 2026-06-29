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

const DEFAULT_IMAGE = 'ghcr.io/aicell-lab/tabula:0.6.1';

const BioEngineGuide: React.FC = () => {
  const { client, server, connect, isConnected, isLoggedIn, user } = useHyphaStore();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = useCallback(async () => {
    if (isConnected && server) return;
    setIsLoggingIn(true);
    try {
      const serverUrl = 'https://hypha.aicell.io';
      const loginToken = await client.login({
        server_url: serverUrl,
        login_callback: (ctx: { login_url: string }) => window.open(ctx.login_url),
      });
      if (!loginToken) throw new Error('Failed to obtain token');
      localStorage.setItem('token', loginToken);
      localStorage.setItem('tokenExpiry', new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString());
      await connect({ server_url: serverUrl, token: loginToken, method_timeout: 300 });
    } catch (err) {
      console.error('Login failed:', err);
      localStorage.removeItem('token');
      localStorage.removeItem('tokenExpiry');
    } finally {
      setIsLoggingIn(false);
    }
  }, [client, connect, isConnected, server]);

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
  const [showDataExample, setShowDataExample] = useState(false);
  const [showAnnDataKeys, setShowAnnDataKeys] = useState(false);
  // Human / AI Agent toggle at the top of the wizard. Default to Human (the
  // full manual configurator). Agent mode hands the entire setup over to an
  // AI agent through a copyable prompt that points the agent at Chiron's
  // skill, asks for the training data directory or specific files to prep,
  // and walks the user through the docker compose launch.
  const [audience, setAudience] = useState<'human' | 'agent'>('human');
  const [agentPromptCopied, setAgentPromptCopied] = useState(false);
  const [includeAgentToken, setIncludeAgentToken] = useState(false);

  // Manifest builder (Training Data Directory panel)
  const [showManifestForm, setShowManifestForm] = useState(false);
  const [manifestId, setManifestId] = useState('');
  const [manifestName, setManifestName] = useState('');
  const [manifestDescription, setManifestDescription] = useState('');
  const [manifestAuthorizedUsers, setManifestAuthorizedUsers] = useState<string[]>(['*']);
  const [manifestTags, setManifestTags] = useState<string[]>([]);
  const [manifestLicense, setManifestLicense] = useState('CC-BY-4.0');
  const [manifestDownloaded, setManifestDownloaded] = useState(false);
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

  // Pre-populate Admin Users and Manager Authorized Users with the logged-in user's email on first load.
  useEffect(() => {
    if (isLoggedIn && user?.email) {
      if (adminUsers.length === 0) setAdminUsers([user.email]);
      if (managerAuthorizedUsers.length === 0) setManagerAuthorizedUsers([user.email]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, user?.email]);

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
    const nameTag = parts[parts.length - 1]; // e.g. "tabula:0.6.0"
    return nameTag.replace(':', '_') + '.sif'; // "tabula_0.3.3.sif"
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
        return `--startup-applications "{\\"artifact_id\\": \\"chiron-platform/chiron-manager\\", \\"application_id\\": \\"chiron-manager\\", \\"auto_redeploy\\": true${authPart}}"`;
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
        return `--startup-applications '{"artifact_id":"chiron-platform/chiron-manager","application_id":"chiron-manager","auto_redeploy":true${authPart}}'`;
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

  const runtimeSubtitle = () => {
    if (containerRuntime === 'docker') return 'Docker Compose: desktop, workstation, or server';
    if (containerRuntime === 'podman') return 'Podman Compose: rootless alternative to Docker';
    if (containerRuntime === 'singularity') return 'Singularity: HPC clusters and shared systems';
    return 'Apptainer: HPC clusters and shared systems';
  };

  // --- manifest.yaml builder ---------------------------------------------
  // Tiny scalar-quoting helper. We only emit strings, lists of strings, and
  // simple key: value pairs — the AnnData manifest schema doesn't need the
  // full YAML grammar. Identifiers (snake_case, urls, version-like) pass
  // through unquoted; anything with whitespace, colons, or non-ASCII gets
  // double-quoted with backslash-escapes.
  const yamlScalar = (s: string): string => {
    if (s === '') return '""';
    if (/^[\w\-./@:]+$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
      return s;
    }
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  };

  const buildManifestYaml = (): string => {
    const lines: string[] = [];
    const id = manifestId.trim() || 'my-dataset';
    lines.push(`id: ${yamlScalar(id)}`);
    if (manifestName.trim()) lines.push(`name: ${yamlScalar(manifestName.trim())}`);
    if (manifestDescription.trim()) lines.push(`description: ${yamlScalar(manifestDescription.trim())}`);
    lines.push('authorized_users:');
    const users = manifestAuthorizedUsers.length > 0 ? manifestAuthorizedUsers : ['*'];
    for (const u of users) lines.push(`  - ${yamlScalar(u)}`);
    if (manifestTags.length > 0) {
      lines.push('tags:');
      for (const t of manifestTags) lines.push(`  - ${yamlScalar(t)}`);
    }
    if (manifestLicense.trim()) lines.push(`license: ${yamlScalar(manifestLicense.trim())}`);
    return lines.join('\n') + '\n';
  };

  const downloadManifest = () => {
    const blob = new Blob([buildManifestYaml()], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'manifest.yaml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setManifestDownloaded(true);
    setTimeout(() => setManifestDownloaded(false), 2000);
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

          {/* ── Audience toggle: Human (full manual configurator) vs AI Agent
                (single copyable prompt that drives the whole setup via an
                external AI agent). Default to Human. ── */}
          <div className="flex justify-center -mb-2">
            <div className="inline-flex items-center bg-gray-100 rounded-lg p-1" role="tablist" aria-label="Audience">
              {(['human', 'agent'] as const).map(value => {
                const selected = audience === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setAudience(value)}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      selected
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {value === 'human' ? 'Human' : 'AI Agent'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── AI Agent mode: blue intro + grey copyable prompt with optional
                admin-token injection. The prompt points the agent at Chiron's
                SKILL.md and asks it to set up the worker AND prepare any raw
                .h5ad files the user has, gathering them into a new data
                directory laid out as one subfolder per dataset. ── */}
          {audience === 'agent' && (() => {
            const skillUrl = 'https://chiron.aicell.io/skills/chiron-platform/SKILL.md';
            const basePrompt =
              `Read ${skillUrl} and help me set up a Chiron worker on this machine.`;
            const promptText = (includeAgentToken && token)
              ? `${basePrompt}\n\nUse this Hypha admin token for my workspace:\n${token}`
              : basePrompt;
            return (
              <div className="space-y-4">
                <div className="p-5 bg-blue-50 rounded-xl border border-blue-200">
                  <h4 className="text-base font-semibold text-blue-900 mb-2">Set up your worker with an AI agent</h4>
                  <p className="text-sm text-blue-800">
                    Copy the prompt below into your AI agent (Claude Code, Codex, Gemini CLI, and so on). It loads the Chiron skill, which tells the agent to detect your OS, container runtime, and GPU, ask for your training data, prepare any files that need adjustment, and walk you through the worker launch.
                  </p>
                </div>

                <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-sm font-semibold text-gray-800">Set up Chiron Worker</h5>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(promptText);
                          setAgentPromptCopied(true);
                          setTimeout(() => setAgentPromptCopied(false), 2000);
                        } catch (_) { /* ignore */ }
                      }}
                      className="flex items-center px-2 py-1 text-xs text-gray-600 bg-white border border-gray-200 rounded hover:bg-gray-100 transition-colors"
                    >
                      {agentPromptCopied ? (
                        <><svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied!</>
                      ) : (
                        <><svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-gray-700 mb-3">Paste this into your AI agent.</p>
                  <pre className="bg-white border border-gray-200 rounded p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap break-words">{promptText}</pre>
                  <label className={`flex items-start mt-3 ${isLoggedIn ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                    <input
                      type="checkbox"
                      disabled={!isLoggedIn}
                      checked={includeAgentToken && isLoggedIn}
                      onChange={(e) => setIncludeAgentToken(e.target.checked)}
                      className="mt-0.5 w-4 h-4 text-blue-600 border-gray-300 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">
                      Include an admin Hypha token for my workspace in the prompt
                      {!isLoggedIn && <span className="text-gray-500"> (log in to enable)</span>}
                      {isLoggedIn && isGeneratingToken && <span className="text-gray-500"> (generating token...)</span>}
                    </span>
                  </label>
                </div>
              </div>
            );
          })()}

          {/* ── Human mode: full manual configurator (Chiron-specific). ── */}
          {audience === 'human' && (<>

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
                <span className="font-medium">Training Data Directory</span>
                <span className="text-blue-700 text-xs block mt-1">
                  A <strong>Tabula Trainer</strong> reads single-cell datasets from a directory on the host that the worker mounts. Nothing is copied or imported. Each dataset lives in its own subfolder with one or more <code className="bg-blue-100 px-1 rounded">.h5ad</code> files and a <code className="bg-blue-100 px-1 rounded">manifest.yaml</code>. The data&#8209;server auto&#8209;converts <code className="bg-blue-100 px-1 rounded">.h5ad</code> &rarr; <code className="bg-blue-100 px-1 rounded">.zarr</code> on first read, ranks genes by per-dataset over-dispersion to pick the 1,200 most variable as the trainer-ready input, discretises every cell into 50 quantile bins, and pre-cuts a <code className="bg-blue-100 px-1 rounded">tabula_binned</code> layer of shape <code className="bg-blue-100 px-1 rounded">(n_cells, 1200)</code>. It rescans every 30&nbsp;seconds. Cell- and gene-level quality control is left to whatever you applied upstream.
                  <br /><br />
                  An <strong>Orchestrator</strong> needs no data &mdash; leave the field empty and the data&#8209;server is omitted entirely.
                </span>

                {/* Amber callout: zarr is mutated in place */}
                <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                  <svg className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
                  </svg>
                  <div className="text-xs text-amber-800 leading-snug">
                    <strong>Heads up:</strong> the data&#8209;server writes the HVG rank, the value&#8209;binned layer, and a UMAP into every <code className="bg-amber-100 px-1 rounded">.zarr/</code> it discovers. To keep your original file unchanged, ship the <code className="bg-amber-100 px-1 rounded">.h5ad</code>. The <code className="bg-amber-100 px-1 rounded">.h5ad</code> is opened read&#8209;only and the data&#8209;server only ever mutates the sibling <code className="bg-amber-100 px-1 rounded">.zarr/</code> it creates. If you point the worker at a <code className="bg-amber-100 px-1 rounded">.zarr/</code> you consider canonical, back it up first.
                  </div>
                </div>

                {/* Disclosure 1 — example folder structure */}
                <button
                  onClick={() => setShowDataExample(!showDataExample)}
                  className="flex items-center text-xs text-blue-600 hover:text-blue-900 mt-3 transition-colors duration-150 ease-out active:scale-[0.97]"
                >
                  <svg className={`w-3 h-3 mr-1 transition-transform duration-200 ease-out ${showDataExample ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {showDataExample ? 'Hide' : 'Show'} example folder layout
                </button>
                {showDataExample && (
                  <div className="mt-3 bg-gray-900 rounded-lg p-3">
                    <pre className="text-green-400 text-xs font-mono overflow-x-auto whitespace-pre">{`/path/to/data/
├── aging/
│   ├── blsa_fibroblasts.h5ad
│   └── manifest.yaml         ← describes this dataset
├── blood/
│   ├── pbmc_10k.zarr/        ← already-converted zarr is fine too
│   └── manifest.yaml
└── thymus/
    ├── thymus_atlas.zarr/    ← .h5ad or .zarr, your choice
    └── manifest.yaml`}</pre>
                  </div>
                )}

                {/* Disclosure 2 — expected AnnData structure */}
                <button
                  onClick={() => setShowAnnDataKeys(!showAnnDataKeys)}
                  className="flex items-center text-xs text-blue-600 hover:text-blue-900 mt-3 transition-colors duration-150 ease-out active:scale-[0.97]"
                >
                  <svg className={`w-3 h-3 mr-1 transition-transform duration-200 ease-out ${showAnnDataKeys ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {showAnnDataKeys ? 'Hide' : 'Show'} expected AnnData structure
                </button>
                {showAnnDataKeys && (
                  <div className="mt-3 bg-white rounded-lg p-3 border border-blue-100">
                    <p className="text-xs text-blue-900 mb-2 leading-snug">
                      Only these AnnData slots are read. Anything in <code className="bg-blue-50 px-1 rounded">adata.raw.X</code>, <code className="bg-blue-50 px-1 rounded">adata.layers[...]</code>, or other groups is ignored. Move counts into <code className="bg-blue-50 px-1 rounded">adata.X</code> before shipping.
                    </p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="text-left font-medium pb-1">Slot</th>
                          <th className="text-left font-medium pb-1">Role</th>
                          <th className="text-left font-medium pb-1">Required?</th>
                        </tr>
                      </thead>
                      <tbody className="text-blue-900">
                        <tr className="border-t border-blue-100">
                          <td className="py-1 font-mono"><code className="bg-blue-50 px-1 rounded">adata.X</code></td>
                          <td className="py-1">Raw integer count matrix <code className="bg-blue-50 px-1 rounded">(n_cells, n_vars)</code>. Source for HVG ranking, binning, and UMAP.</td>
                          <td className="py-1 font-medium">Yes</td>
                        </tr>
                        <tr className="border-t border-blue-100">
                          <td className="py-1 font-mono"><code className="bg-blue-50 px-1 rounded">adata.var[&quot;gene_id&quot;]</code></td>
                          <td className="py-1">Int gene token IDs the trainer feeds to the model. Without it cross-dataset gene matching breaks.</td>
                          <td className="py-1">Strongly recommended</td>
                        </tr>
                        <tr className="border-t border-blue-100">
                          <td className="py-1 font-mono"><code className="bg-blue-50 px-1 rounded">adata.obs</code>, <code className="bg-blue-50 px-1 rounded">adata.var</code></td>
                          <td className="py-1">Preserved verbatim. HVG rank and selection arrays are written alongside.</td>
                          <td className="py-1">Optional</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Disclosure 3 — manifest.yaml builder form */}
                <button
                  onClick={() => setShowManifestForm(!showManifestForm)}
                  className="flex items-center text-xs text-blue-600 hover:text-blue-900 mt-3 transition-colors duration-150 ease-out active:scale-[0.97]"
                >
                  <svg className={`w-3 h-3 mr-1 transition-transform duration-200 ease-out ${showManifestForm ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {showManifestForm ? 'Hide' : 'Build'}<code className="bg-blue-100 px-1 rounded mx-1">manifest.yaml</code>
                </button>
                {showManifestForm && (
                  <div className="mt-3 bg-white rounded-lg p-3 border border-blue-100 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Dataset ID <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={manifestId}
                          onChange={(e) => setManifestId(e.target.value)}
                          placeholder="blood_perturb"
                          className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-[10px] text-gray-500 mt-1">Unique. <code>snake_case</code> conventional.</p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Display name <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={manifestName}
                          onChange={(e) => setManifestName(e.target.value)}
                          placeholder="Blood-Perturb"
                          className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-[10px] text-gray-500 mt-1">Short, Title-cased label shown in the Chiron UI. Use a tissue or one-word descriptor, hyphenate a sub-descriptor when needed (e.g. <code className="bg-gray-100 px-1 rounded">Thymus</code>, <code className="bg-gray-100 px-1 rounded">Blood-Perturb</code>, <code className="bg-gray-100 px-1 rounded">Skin Aging - BLSA</code>).</p>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                      <textarea autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other"
                        rows={2}
                        value={manifestDescription}
                        onChange={(e) => setManifestDescription(e.target.value)}
                        placeholder="One-line description of what the dataset contains."
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Authorized users</label>
                        <TagInput
                          tags={manifestAuthorizedUsers}
                          onChange={setManifestAuthorizedUsers}
                          placeholder="user@example.com or *"
                        />
                        <p className="text-[10px] text-gray-500 mt-1"><code>*</code> = public access on this worker.</p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Tags</label>
                        <TagInput
                          tags={manifestTags}
                          onChange={setManifestTags}
                          placeholder="tissue, assay, disease…"
                        />
                        <p className="text-[10px] text-gray-500 mt-1">Free-text. Optional.</p>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">License</label>
                      <select
                        value={manifestLicense}
                        onChange={(e) => setManifestLicense(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="CC-BY-4.0">CC-BY-4.0 — attribution, commercial OK</option>
                        <option value="CC-BY-NC-4.0">CC-BY-NC-4.0 — attribution, non-commercial</option>
                        <option value="CC0-1.0">CC0-1.0 — public domain</option>
                        <option value="MIT">MIT</option>
                        <option value="">Other / unspecified</option>
                      </select>
                    </div>

                    {/* Preview + download */}
                    <div className="bg-gray-50 border border-gray-200 rounded p-2">
                      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 mb-1">Preview</p>
                      <pre className="text-gray-700 text-[11px] font-mono whitespace-pre overflow-x-auto">{buildManifestYaml()}</pre>
                    </div>

                    <button
                      onClick={downloadManifest}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-[transform,background-color] duration-150 ease-out active:scale-[0.97]"
                    >
                      {manifestDownloaded ? (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          Downloaded
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                          Download manifest.yaml
                        </>
                      )}
                    </button>
                    <p className="text-[11px] text-gray-600">
                      Drop the file inside the dataset's subfolder (alongside your <code className="bg-gray-100 px-1 rounded">.h5ad</code> or <code className="bg-gray-100 px-1 rounded">.zarr</code>), with filename <code className="bg-gray-100 px-1 rounded font-mono">manifest.yaml</code>.
                    </p>
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
                        <p>An authentication token is required to connect the worker to Hypha. Either log in to auto-generate a 30-day admin token, or set one manually in <strong>Advanced Options → Authentication Token</strong>.</p>
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={handleLogin}
                            disabled={isLoggingIn}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                          >
                            {isLoggingIn ? (
                              <>
                                <svg className="animate-spin -ml-0.5 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                </svg>
                                Logging in…
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                                </svg>
                                Log in
                              </>
                            )}
                          </button>
                        </div>
                        <p className="text-xs italic mt-2">Manually provided tokens must have <strong>Permission Level: Admin</strong>.</p>
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

                {/* Worker Name (1/3) + Training Data Directory (2/3) */}
                <div className="md:col-span-2 lg:col-span-3 grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Worker Name</label>
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={workerName} onChange={(e) => setWorkerName(e.target.value)}
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

                {/* Chiron Manager Authorized Users — full-width row */}
                <div className="md:col-span-2 lg:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Chiron Manager Authorized Users</label>
                  <TagInput
                    tags={managerAuthorizedUsers}
                    onChange={setManagerAuthorizedUsers}
                    placeholder="user@example.com or *"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Who can use this worker in the Chiron federated training. Use <code className="bg-gray-100 px-0.5 rounded">*</code> to allow all users.
                    Leave empty to restrict to worker admin users only. Press Space or Enter to add.
                  </p>
                </div>

              </div>
            </div>

            {/* Advanced Options */}
            <div className="pt-6">
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
                      Users who can deploy and manage apps on this worker. Press Space or Enter to add.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">BioEngine Workspace Directory</label>
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)}
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
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
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
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={workspace}
                      onChange={(e) => { setWorkspace(e.target.value); setWorkspaceResolved(false); }}
                      placeholder="my-workspace" autoComplete="off"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Hypha workspace for service registration (auto-resolved from token)</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={clientId} onChange={(e) => setClientId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-xs text-gray-500 mt-1">Custom client ID (auto-generated if empty)</p>
                  </div>

                  {gpus > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">GPU Indices</label>
                      <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={gpuIndices} onChange={(e) => setGpuIndices(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <p className="text-xs text-gray-500 mt-1">Comma-separated GPU device IDs. Leave empty to use the GPU count above</p>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Container Image</label>
                    <input type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" value={customImage} onChange={(e) => setCustomImage(e.target.value)}
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
          <div className="border-t border-gray-200 pt-4">

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

          </>)}
          {/* end human mode */}

          {/* ── GitHub link (visible in both Human and AI Agent modes) ── */}
          <div className="flex justify-center pt-4 border-t border-gray-200">
            <a
              href="https://github.com/aicell-lab/bioengine"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              <span>aicell-lab/bioengine on GitHub</span>
            </a>
          </div>

        </div>
      )}
    </div>
  );
};

export default BioEngineGuide;
