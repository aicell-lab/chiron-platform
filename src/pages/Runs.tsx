import React, { useEffect, useState, useCallback } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import { MdHistory, MdRefresh } from 'react-icons/md';
import { BiLoaderAlt } from 'react-icons/bi';
import { FaChevronDown, FaChevronRight, FaExternalLinkAlt } from 'react-icons/fa';
import { Link } from 'react-router-dom';

interface RoundMeta {
  round: number;
  started_at: string;
  completed_at: string;
  training_loss: number | null;
  validation_loss: number | null;
  trainers: Array<{
    service_id: string;
    client_name: string;
    datasets: Array<{ id: string; name: string }>;
    fit: boolean;
    evaluate: boolean;
    train_loss: number | null;
    val_loss: number | null;
  }>;
}

interface RunArtifact {
  id: string;
  alias?: string;
  manifest: {
    name: string;
    status: 'running' | 'completed' | 'stopped';
    started_at: string;
    orchestrator_service_id: string;
    config: Record<string, any>;
    trainers: Record<string, { client_name: string; datasets: Array<{ id: string; name: string }>; train_samples: number }>;
    rounds: RoundMeta[];
    history?: {
      training_losses: [number, number][];
      validation_losses: [number, number][];
    };
    published_global_weights: Array<{ artifact_id: string; round: number; description?: string; published_at: string }>;
    saved_trainer_models: Record<string, any>;
  };
  // resolved at display time
  liveStatus?: 'running' | 'resumable' | 'completed' | 'stopped';
}

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const cfg: Record<string, { bg: string; dot: string; label: string }> = {
    running:   { bg: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500 animate-pulse', label: 'Running' },
    resumable: { bg: 'bg-blue-100 text-blue-700',       dot: 'bg-blue-500',                 label: 'Resumable' },
    completed: { bg: 'bg-gray-100 text-gray-600',       dot: 'bg-gray-400',                 label: 'Completed' },
    stopped:   { bg: 'bg-amber-100 text-amber-700',     dot: 'bg-amber-500',                label: 'Stopped' },
  };
  const c = cfg[status] || cfg['completed'];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
};

const formatTs = (iso?: string) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
};

const LossSparkline: React.FC<{ losses: [number, number][] }> = ({ losses }) => {
  if (!losses || losses.length === 0) return null;
  const vals = losses.map(([, l]) => l);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const W = 80, H = 24, pad = 2;
  const pts = vals.map((v, i) => {
    const x = pad + (i / Math.max(vals.length - 1, 1)) * (W - 2 * pad);
    const y = H - pad - ((v - min) / range) * (H - 2 * pad);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={W} height={H} className="opacity-70">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

const RunCard: React.FC<{ run: RunArtifact; defaultOpen?: boolean }> = ({ run, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const m = run.manifest;
  const status = run.liveStatus || m.status || 'completed';
  const numRounds = m.rounds?.length ?? 0;
  const numTrainers = Object.keys(m.trainers ?? {}).length;
  const trainLosses = m.history?.training_losses ?? [];
  const valLosses = m.history?.validation_losses ?? [];

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-gray-50/50 transition-colors"
      >
        <span className="text-gray-400 flex-shrink-0">{open ? <FaChevronDown size={12} /> : <FaChevronRight size={12} />}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 truncate">{m.name}</p>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {formatTs(m.started_at)} · {numRounds} round{numRounds !== 1 ? 's' : ''} · {numTrainers} site{numTrainers !== 1 ? 's' : ''}
          </p>
        </div>
        {/* Mini sparklines */}
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0 text-blue-400">
          {trainLosses.length > 0 && <LossSparkline losses={trainLosses} />}
          {valLosses.length > 0 && <span className="text-emerald-400"><LossSparkline losses={valLosses} /></span>}
        </div>
        {status === 'running' && (
          <Link to="/training" onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition-colors flex-shrink-0">
            <FaExternalLinkAlt size={10} /> View
          </Link>
        )}
        {status === 'resumable' && (
          <Link to="/training" onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors flex-shrink-0">
            <FaExternalLinkAlt size={10} /> Resume
          </Link>
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-5">
          {/* Config summary */}
          {m.config && Object.keys(m.config).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Config</p>
              <div className="flex flex-wrap gap-2">
                {m.config.num_rounds != null && (
                  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">{m.config.num_rounds} rounds</span>
                )}
                {m.config.per_round_timeout != null && (
                  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">{m.config.per_round_timeout}s timeout</span>
                )}
                {m.config.initial_weights?.artifact_id && (
                  <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">Pretrained: {m.config.initial_weights.artifact_id.split('/').pop()}</span>
                )}
                {Object.entries(m.config.fit_config ?? {}).map(([k, v]) => (
                  <span key={k} className="text-xs bg-gray-50 border border-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{k}: {String(v)}</span>
                ))}
              </div>
            </div>
          )}

          {/* Sites */}
          {numTrainers > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sites</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(m.trainers).map(([svcId, t]) => (
                  <div key={svcId} className="text-xs bg-gray-50 border border-gray-100 rounded-lg px-3 py-1.5">
                    <p className="font-medium text-gray-800">{t.client_name}</p>
                    <p className="text-gray-400">{t.datasets?.map((d: any) => d.name || d.id).join(', ') || '-'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-round table */}
          {m.rounds && m.rounds.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Rounds</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-100">
                      <th className="text-left pb-1.5 pr-4">Round</th>
                      <th className="text-left pb-1.5 pr-4">Train Loss</th>
                      <th className="text-left pb-1.5 pr-4">Val Loss</th>
                      <th className="text-left pb-1.5">Sites</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.rounds.map(r => (
                      <tr key={r.round} className="border-b border-gray-50 last:border-0">
                        <td className="py-1.5 pr-4 font-medium text-gray-700">{r.round}</td>
                        <td className="py-1.5 pr-4 text-blue-600">{r.training_loss != null ? r.training_loss.toFixed(4) : '-'}</td>
                        <td className="py-1.5 pr-4 text-emerald-600">{r.validation_loss != null ? r.validation_loss.toFixed(4) : '-'}</td>
                        <td className="py-1.5 text-gray-500">{r.trainers?.map(t => t.client_name).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Published global weights */}
          {m.published_global_weights && m.published_global_weights.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Published Global Weights</p>
              <div className="space-y-1">
                {m.published_global_weights.map((pw, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-gray-600">
                    <span className="font-mono bg-violet-50 text-violet-700 px-2 py-0.5 rounded border border-violet-100 truncate max-w-xs">{pw.artifact_id}</span>
                    <span className="text-gray-400">· round {pw.round}</span>
                    <span className="text-gray-400">· {formatTs(pw.published_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Orchestrator service ID */}
          <div className="text-xs text-gray-400 font-mono truncate" title={m.orchestrator_service_id}>
            Orchestrator: {m.orchestrator_service_id}
          </div>
        </div>
      )}
    </div>
  );
};

const Runs: React.FC = () => {
  const { server, artifactManager, isLoggedIn } = useHyphaStore();
  const [runs, setRuns] = useState<RunArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!artifactManager || !server) return;
    setLoading(true);
    setError(null);
    try {
      const workspace = server.config?.workspace || 'chiron-platform';
      const items = await artifactManager.list({
        parent_id: `${workspace}/chiron-training-runs`,
        stage: 'all',
        _rkwargs: true,
      });

      // Sort newest first
      const sorted: RunArtifact[] = [...(items || [])].sort((a: any, b: any) => {
        const ta = a.manifest?.started_at ?? '';
        const tb = b.manifest?.started_at ?? '';
        return tb.localeCompare(ta);
      });

      // Resolve live status by pinging orchestrators for 'running' artifacts
      const resolved = await Promise.all(sorted.map(async (run: any): Promise<RunArtifact> => {
        const m = run.manifest ?? {};
        if (m.status !== 'running') {
          return { ...run, liveStatus: m.status ?? 'completed' };
        }
        // Try to reach the orchestrator
        try {
          const orchSvc = await server.getService(m.orchestrator_service_id);
          const status = await orchSvc.get_training_status();
          const liveStatus = status?.is_running ? 'running' : 'resumable';
          return { ...run, liveStatus };
        } catch {
          return { ...run, liveStatus: 'resumable' };
        }
      }));

      setRuns(resolved);
    } catch (e: any) {
      if (String(e).toLowerCase().includes('not found') || String(e).toLowerCase().includes('does not exist')) {
        setRuns([]);
      } else {
        setError(e?.message ?? String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [artifactManager, server]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const runningRuns = runs.filter(r => r.liveStatus === 'running');
  const otherRuns = runs.filter(r => r.liveStatus !== 'running');

  return (
    <div className="px-6 py-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MdHistory size={28} className="text-blue-500" />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Training Runs</h1>
            <p className="text-gray-500 text-sm mt-0.5">Browse past and ongoing federated training runs</p>
          </div>
        </div>
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          {loading ? <BiLoaderAlt className="animate-spin" size={14} /> : <MdRefresh size={14} />}
          Refresh
        </button>
      </div>

      {!isLoggedIn && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
          <p className="text-amber-800 text-sm font-medium">Please log in to view training runs.</p>
        </div>
      )}

      {isLoggedIn && error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-5 text-sm text-red-700">{error}</div>
      )}

      {isLoggedIn && !loading && !error && runs.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <MdHistory size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No training runs found yet.</p>
          <p className="text-xs mt-1">Start a federated training session from the <Link to="/training" className="text-blue-500 hover:underline">Training</Link> tab.</p>
        </div>
      )}

      {isLoggedIn && loading && runs.length === 0 && (
        <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
          <BiLoaderAlt className="animate-spin" size={18} />
          <span className="text-sm">Loading runs…</span>
        </div>
      )}

      {isLoggedIn && runs.length > 0 && (
        <div className="space-y-4">
          {runningRuns.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 px-1">Active</p>
              <div className="space-y-3">
                {runningRuns.map(r => <RunCard key={r.id} run={r} defaultOpen />)}
              </div>
            </div>
          )}
          {otherRuns.length > 0 && (
            <div>
              {runningRuns.length > 0 && <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 mt-4 px-1">History</p>}
              <div className="space-y-3">
                {otherRuns.map(r => <RunCard key={r.id} run={r} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Runs;
