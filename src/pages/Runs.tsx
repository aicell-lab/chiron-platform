import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useHyphaStore } from '../store/hyphaStore';
import { MdHistory, MdRefresh } from 'react-icons/md';
import { BiLoaderAlt } from 'react-icons/bi';
import { FaChevronDown, FaChevronRight, FaExternalLinkAlt, FaTrash } from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { listHyphaServices, callHyphaService } from '../utils/hyphaHttp';

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
    // Identifier of this run, minted by the orchestrator when it created
    // the artifact. Re-checked against the orchestrator's current run_id on
    // every status poll — mismatch means the orchestrator's training state
    // has been reset since, so this artifact is no longer resumable even
    // though the orchestrator service is still alive.
    run_id?: string;
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
  liveStatus?: 'running' | 'resumable' | 'completed' | 'stopped';
}

// Worker name + geo location, resolved on demand from the BioEngine worker
// behind each trainer/orchestrator service id. Keyed by the worker service id
// (e.g. "chiron-platform/8jeJoA...:bioengine-worker"), not the
// trainer/orchestrator service id — multiple apps on the same worker share one
// entry.
interface WorkerInfo {
  name?: string;
  region?: string;
  country_name?: string;
  country_code?: string;
  loading: boolean;
  reachable: boolean;
}

// "chiron-platform/<workerClientId>-<replica>:<svcName>" →
// "chiron-platform/<workerClientId>:bioengine-worker". Returns null if the
// service id is malformed (no workspace).
const parseWorkerServiceId = (svcId: string): string | null => {
  const slash = svcId.indexOf('/');
  if (slash < 0) return null;
  const workspace = svcId.slice(0, slash);
  const rest = svcId.slice(slash + 1);
  const clientPart = rest.split(':')[0];
  const workerClientId = clientPart.split('-')[0];
  if (!workerClientId) return null;
  return `${workspace}/${workerClientId}:bioengine-worker`;
};

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

const CountryFlag: React.FC<{ code?: string }> = ({ code }) => {
  if (!code) return null;
  return (
    <img
      src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
      alt={code}
      className="w-4 h-3 object-cover rounded-sm inline-block flex-shrink-0"
      loading="lazy"
    />
  );
};

const formatTs = (iso?: string) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
};

// Tiny inline sparkline kept in the collapsed header row so the user can
// glance the loss trend without expanding. Real chart lives in the expanded
// section.
const LossSparkline: React.FC<{ losses: [number, number][]; stroke: string }> = ({ losses, stroke }) => {
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
    <svg width={W} height={H} className="opacity-80">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

// Renders worker name + flag + region, country. Falls back gracefully while
// the lookup is in flight or has failed.
const WorkerBadge: React.FC<{ info?: WorkerInfo; fallback?: string }> = ({ info, fallback }) => {
  if (!info || info.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-gray-400 text-xs">
        <BiLoaderAlt className="animate-spin" size={12} />
        Resolving…
      </span>
    );
  }
  const name = info.name || fallback || 'Unknown worker';
  const hasGeo = info.region || info.country_name;
  return (
    <div className="flex flex-col min-w-0">
      <p className="text-sm font-medium text-gray-800 truncate" title={name}>{name}</p>
      {hasGeo ? (
        <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5 truncate">
          <CountryFlag code={info.country_code} />
          <span className="truncate">{[info.region, info.country_name].filter(Boolean).join(', ')}</span>
        </p>
      ) : (
        <p className="text-xs text-gray-400 mt-0.5">Location unavailable</p>
      )}
    </div>
  );
};

interface RunCardProps {
  run: RunArtifact;
  defaultOpen?: boolean;
  onDelete: (run: RunArtifact) => void;
  workerInfoMap: Record<string, WorkerInfo>;
}

const RunCard: React.FC<RunCardProps> = ({ run, defaultOpen, onDelete, workerInfoMap }) => {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const m = run.manifest;
  const status = run.liveStatus || m.status || 'completed';
  const completedRounds = m.rounds?.length ?? 0;
  const trainerSvcIds = useMemo(() => Object.keys(m.trainers ?? {}), [m.trainers]);
  const numTrainers = trainerSvcIds.length;
  const trainLosses = useMemo(() => m.history?.training_losses ?? [], [m.history]);
  const valLosses   = useMemo(() => m.history?.validation_losses ?? [], [m.history]);

  // Build chart data from per-round meta. The rounds list is the source of
  // truth — m.history is a derived per-epoch view that may include
  // intermediate evaluation points that don't align with discrete rounds.
  const chartData = useMemo(() => {
    if (m.rounds && m.rounds.length > 0) {
      return m.rounds.map(r => ({ round: r.round, train: r.training_loss, val: r.validation_loss }));
    }
    // Fallback to history if rounds aren't populated (older runs).
    const byRound: Record<number, { round: number; train?: number | null; val?: number | null }> = {};
    for (const [round, loss] of trainLosses) {
      byRound[round] = { ...(byRound[round] ?? { round }), round, train: loss };
    }
    for (const [round, loss] of valLosses) {
      byRound[round] = { ...(byRound[round] ?? { round }), round, val: loss };
    }
    return Object.values(byRound).sort((a, b) => a.round - b.round);
  }, [m.rounds, trainLosses, valLosses]);

  const lastTrain = chartData.length > 0 ? chartData[chartData.length - 1].train : null;
  const lastVal = chartData.length > 0 ? chartData[chartData.length - 1].val : null;
  const orchWorkerSvcId = parseWorkerServiceId(m.orchestrator_service_id);
  const orchWorkerInfo = orchWorkerSvcId ? workerInfoMap[orchWorkerSvcId] : undefined;

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
            {formatTs(m.started_at)} · {completedRounds} round{completedRounds !== 1 ? 's' : ''} completed · {numTrainers} trainer{numTrainers !== 1 ? 's' : ''}
            {(lastTrain != null || lastVal != null) && (
              <>
                {' · '}
                {lastTrain != null && <span className="text-blue-500">train {lastTrain.toFixed(3)}</span>}
                {lastTrain != null && lastVal != null && ' · '}
                {lastVal != null && <span className="text-emerald-500">val {lastVal.toFixed(3)}</span>}
              </>
            )}
          </p>
        </div>
        {/* Inline sparklines — visible on every screen size now so the
            loss trend is never invisible. */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {trainLosses.length > 0 && <LossSparkline losses={trainLosses} stroke="#3b82f6" />}
          {valLosses.length > 0 && <LossSparkline losses={valLosses} stroke="#10b981" />}
        </div>
        {(status === 'running' || status === 'resumable') && (() => {
          // Deep-link to /#/training with the orchestrator pre-selected and the
          // wizard jumped to step 3 ("Train"). Without these params the page
          // lands on step 1 and the operator has to click through to find
          // their own session again.
          const orchSvcId = m.orchestrator_service_id;
          const to = `/training?orchestrator_id=${encodeURIComponent(orchSvcId)}&step=train`;
          const isRunning = status === 'running';
          return (
            <Link
              to={to}
              onClick={e => e.stopPropagation()}
              className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0 active:scale-[0.97] ${isRunning ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
            >
              <FaExternalLinkAlt size={10} /> {isRunning ? 'View' : 'Resume'}
            </Link>
          );
        })()}
        <span
          role="button"
          tabIndex={0}
          aria-label="Delete run"
          title="Delete run"
          onClick={e => { e.stopPropagation(); onDelete(run); }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); e.stopPropagation(); onDelete(run);
            }
          }}
          className="flex items-center justify-center w-8 h-8 text-gray-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0 cursor-pointer"
        >
          <FaTrash size={12} />
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-5 py-5 space-y-6">
          {/* Config summary */}
          {m.config && Object.keys(m.config).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Config</p>
              <div className="flex flex-wrap gap-2">
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

          {/* Loss chart */}
          {chartData.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Training & Validation Loss</p>
              <div className="w-full h-56 bg-gray-50/50 rounded-xl border border-gray-100 p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                    <XAxis dataKey="round" tick={{ fontSize: 11, fill: '#6b7280' }} label={{ value: 'Round', position: 'insideBottom', offset: -2, fontSize: 11, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} width={48} />
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                      formatter={(v: any) => typeof v === 'number' ? v.toFixed(4) : v}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconType="line" />
                    <Line type="monotone" dataKey="train" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} name="Train" connectNulls />
                    <Line type="monotone" dataKey="val"   stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} name="Val"   connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Orchestrator */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Orchestrator</p>
            <div className="bg-gray-50/60 border border-gray-100 rounded-xl px-4 py-3">
              <WorkerBadge info={orchWorkerInfo} fallback="Orchestrator worker" />
            </div>
          </div>

          {/* Trainers */}
          {numTrainers > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trainers</p>
              <div className="space-y-2">
                {trainerSvcIds.map(svcId => {
                  const t = m.trainers[svcId];
                  const workerSvcId = parseWorkerServiceId(svcId);
                  const workerInfo = workerSvcId ? workerInfoMap[workerSvcId] : undefined;
                  const datasets = t?.datasets ?? [];
                  return (
                    <div
                      key={svcId}
                      className="flex items-start gap-4 bg-gray-50/60 border border-gray-100 rounded-xl px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <WorkerBadge info={workerInfo} fallback={t?.client_name || 'Trainer worker'} />
                      </div>
                      {datasets.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-1.5 max-w-[60%]">
                          {datasets.map(d => (
                            <span
                              key={d.id}
                              title={d.id}
                              className="text-xs bg-white border border-gray-200 text-gray-700 px-2 py-0.5 rounded-md"
                            >
                              {d.name || d.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
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
                      <th className="text-left pb-1.5">Trainers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.rounds.map(r => (
                      <tr key={r.round} className="border-b border-gray-50 last:border-0">
                        <td className="py-1.5 pr-4 font-medium text-gray-700">{r.round}</td>
                        <td className="py-1.5 pr-4 text-blue-600">{r.training_loss != null ? r.training_loss.toFixed(4) : '-'}</td>
                        <td className="py-1.5 pr-4 text-emerald-600">{r.validation_loss != null ? r.validation_loss.toFixed(4) : '-'}</td>
                        <td className="py-1.5 text-gray-500">
                          {(r.trainers ?? []).map(t => {
                            const workerSvcId = parseWorkerServiceId(t.service_id);
                            const wi = workerSvcId ? workerInfoMap[workerSvcId] : undefined;
                            return wi?.name || t.client_name;
                          }).join(', ')}
                        </td>
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
  // Confirmation dialog for delete. Holds the run pending deletion + the
  // in-flight state so the Delete button can show a spinner while we wait
  // for artifactManager.delete to finish.
  const [pendingDelete, setPendingDelete] = useState<RunArtifact | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Resolved worker info keyed by worker service id. Shared across all run
  // cards — same worker is usually referenced by multiple runs.
  const [workerInfoMap, setWorkerInfoMap] = useState<Record<string, WorkerInfo>>({});

  // Ref-mirrored copies so the 30s status-poll interval doesn't restart on
  // every state change.
  const runsRef = useRef(runs);
  useEffect(() => { runsRef.current = runs; }, [runs]);
  const serverRef = useRef(server);
  useEffect(() => { serverRef.current = server; }, [server]);

  const fetchRuns = useCallback(async () => {
    if (!artifactManager || !server) return;
    setLoading(true);
    setError(null);
    try {
      // The orchestrator now runs with a user-scoped HYPHA_TOKEN (issued by
      // the UI's createOrchestrator), so its hypha_client.config.workspace
      // resolves to the user's personal workspace and run artifacts land in
      // ws-user-<userId>/chiron-training-runs. The runs page reads from the
      // logged-in user's own workspace, which means each user naturally sees
      // only their own runs and the orchestrator never needs write perms on
      // anyone else's workspace.
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
        // Try to reach the orchestrator. If the orchestrator returns a
        // different run_id than the one stored on this artifact, its
        // training state has been reset and this run is no longer
        // resumable — surface it as Completed so the user is not invited
        // to Resume into someone else's session.
        try {
          const orchSvc = await server.getService(m.orchestrator_service_id);
          const status = await orchSvc.get_training_status();
          const orchRunId = status?.run_id ?? null;
          if (m.run_id && orchRunId && m.run_id !== orchRunId) {
            return { ...run, liveStatus: 'completed' };
          }
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

  // Auto-poll orchestrator status every 30s so a run flipping from running →
  // resumable (e.g. orchestrator went idle) reflects without a manual refresh.
  // Only the liveStatus is updated; we don't re-list the collection here to
  // avoid pulling history payloads on every tick.
  useEffect(() => {
    if (!server) return;
    const interval = setInterval(async () => {
      const currentRuns = runsRef.current;
      const live = serverRef.current;
      if (!live || currentRuns.length === 0) return;
      const updates = await Promise.all(currentRuns.map(async run => {
        const m = run.manifest;
        if (m.status === 'completed' || m.status === 'stopped') {
          return { id: run.id, liveStatus: m.status };
        }
        try {
          const orchSvc = await live.getService(m.orchestrator_service_id);
          const status = await orchSvc.get_training_status();
          const orchRunId = status?.run_id ?? null;
          if (m.run_id && orchRunId && m.run_id !== orchRunId) {
            return { id: run.id, liveStatus: 'completed' as const };
          }
          return {
            id: run.id,
            liveStatus: (status?.is_running ? 'running' : 'resumable') as 'running' | 'resumable',
          };
        } catch {
          return { id: run.id, liveStatus: 'resumable' as const };
        }
      }));
      setRuns(prev => prev.map(r => {
        const u = updates.find(u => u.id === r.id);
        return u && u.liveStatus !== r.liveStatus ? { ...r, liveStatus: u.liveStatus } : r;
      }));
    }, 30000);
    return () => clearInterval(interval);
  }, [server]);

  // Resolve worker info for every distinct worker referenced by the visible
  // runs. Runs once per change in the set of worker service ids — caches in
  // workerInfoMap so each worker is hit at most once across all cards.
  useEffect(() => {
    if (!server || runs.length === 0) return;
    const needed = new Set<string>();
    for (const run of runs) {
      const m = run.manifest;
      const orchWsId = parseWorkerServiceId(m.orchestrator_service_id);
      if (orchWsId) needed.add(orchWsId);
      for (const trainerSvcId of Object.keys(m.trainers ?? {})) {
        const tWsId = parseWorkerServiceId(trainerSvcId);
        if (tWsId) needed.add(tWsId);
      }
    }
    // Filter to workers we haven't resolved (or are not currently resolving)
    const toResolve = [...needed].filter(id => !workerInfoMap[id]);
    if (toResolve.length === 0) return;

    // Mark as loading immediately so concurrent renders don't double-fetch.
    setWorkerInfoMap(prev => {
      const next = { ...prev };
      for (const id of toResolve) {
        if (!next[id]) next[id] = { loading: true, reachable: false };
      }
      return next;
    });

    // Group by workspace so we hit listServices once per workspace.
    const byWorkspace: Record<string, string[]> = {};
    for (const id of toResolve) {
      const ws = id.slice(0, id.indexOf('/'));
      if (!byWorkspace[ws]) byWorkspace[ws] = [];
      byWorkspace[ws].push(id);
    }

    const cancelRef = { current: false };
    const resolveWorkspace = async (ws: string, ids: string[]) => {
      // 1) Pull the worker name from the workspace's service list. The
      //    bioengine-worker service registers with its display name; that's
      //    the closest thing to a friendly site name we have.
      const nameByClient: Record<string, string> = {};
      try {
        const services = await listHyphaServices(ws, { timeoutMs: 12000 });
        const stripWs = (s: string) => s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
        for (const s of services) {
          if (!s?.id || typeof s.id !== 'string') continue;
          if (!s.id.endsWith(':bioengine-worker') || s.id.includes('rtc')) continue;
          const clientId = stripWs(s.id).split(':')[0];
          if (clientId && s.name) nameByClient[clientId] = s.name;
        }
      } catch {
        // Workspace might be unreachable for this user — keep going, the
        // get_status fallback below may still work.
      }
      if (cancelRef.current) return;

      // 2) For each worker, call get_status to fetch geo_location.
      await Promise.all(ids.map(async workerSvcId => {
        const clientId = workerSvcId.slice(ws.length + 1).split(':')[0];
        let geo: any = null;
        try {
          const status = await callHyphaService<any>(workerSvcId, 'get_status', {}, { timeoutMs: 12000 });
          geo = status?.geo_location ?? null;
        } catch {
          geo = null;
        }
        if (cancelRef.current) return;
        setWorkerInfoMap(prev => ({
          ...prev,
          [workerSvcId]: {
            loading: false,
            reachable: geo !== null || !!nameByClient[clientId],
            name: nameByClient[clientId],
            region: geo?.region,
            country_name: geo?.country_name,
            country_code: geo?.country_code,
          },
        }));
      }));
    };

    (async () => {
      for (const [ws, ids] of Object.entries(byWorkspace)) {
        await resolveWorkspace(ws, ids);
      }
    })();

    return () => { cancelRef.current = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, server]);

  // Confirmed delete: removes the run artifact (and its files) from
  // chiron-training-runs. Published global weights and trainer models live
  // in their own collections and stay untouched.
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !artifactManager) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await artifactManager.delete({
        artifact_id: pendingDelete.id,
        delete_files: true,
        recursive: true,
        _rkwargs: true,
      });
      setRuns(prev => prev.filter(r => r.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (e: any) {
      setDeleteError(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }, [artifactManager, pendingDelete]);

  const requestDelete = useCallback((run: RunArtifact) => {
    setDeleteError(null);
    setPendingDelete(run);
  }, []);

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
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50 active:scale-[0.97]"
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
                {runningRuns.map(r => <RunCard key={r.id} run={r} defaultOpen onDelete={requestDelete} workerInfoMap={workerInfoMap} />)}
              </div>
            </div>
          )}
          {otherRuns.length > 0 && (
            <div>
              {runningRuns.length > 0 && <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 mt-4 px-1">History</p>}
              <div className="space-y-3">
                {otherRuns.map(r => <RunCard key={r.id} run={r} onDelete={requestDelete} workerInfoMap={workerInfoMap} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation modal. Rendered at the page root so it overlays
          whichever RunCard the user clicked into. Esc / backdrop click cancels
          unless a delete is already in flight. */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => { if (!deleting) setPendingDelete(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-run-title"
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <FaTrash size={14} className="text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="delete-run-title" className="text-base font-semibold text-gray-900">
                  Delete training run?
                </h2>
                <p className="text-sm text-gray-600 mt-1 break-words">
                  <span className="font-medium text-gray-800">{pendingDelete.manifest.name}</span>
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  This action cannot be undone. The run record and any files attached to it will be permanently removed.
                  Published global weights and saved trainer models live in their own collections and are not affected.
                </p>
                {pendingDelete.liveStatus === 'running' && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5 mt-2">
                    This run is still active. Consider stopping it from the Training tab first.
                  </p>
                )}
              </div>
            </div>
            {deleteError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {deleteError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-xl transition-colors disabled:opacity-50 active:scale-[0.97]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors disabled:opacity-60 active:scale-[0.97]"
              >
                {deleting && <BiLoaderAlt className="animate-spin" size={14} />}
                {deleting ? 'Deleting…' : 'Delete run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Runs;
