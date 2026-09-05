import { create } from 'zustand';
import { WeightTransport } from '../config/federation';

/**
 * The operator-owned half of the training configuration.
 *
 * It lives in a store rather than in TrainingConfigPanel's own state because
 * the panel is unmounted by things that have nothing to do with the operator:
 * a parameter refresh that flips the loading flag, the card being collapsed,
 * a route change back and forth. Every one of those used to drop a
 * half-filled form back to the schema defaults with no warning, which is the
 * opposite of what a config screen should do.
 *
 * Drafts are kept per orchestrator, because the parameter schema, the
 * checkpoint list and the sensible round count all belong to one federation.
 * Switching orchestrators shows that orchestrator's draft, not the last one
 * touched.
 */
export interface TrainingConfigDraft {
  numRounds: number;
  perRoundTimeoutMinutes: number;
  transport: WeightTransport;
  usePretrainedWeights: boolean;
  selectedArtifactId: string;
  selectedFilePath: string;
  fitValues: Record<string, any>;
  evalValues: Record<string, any>;
  /** Keys the operator has typed into. A parameter refresh reloads defaults
   *  for everything else and leaves these alone. */
  editedFitKeys: string[];
  editedEvalKeys: string[];
  /** The model family the stored values were entered against. A genuine
   *  switch to another model invalidates them, but the panel must be able to
   *  tell that switch apart from the parameter schema simply being absent for
   *  a moment, which happens routinely between runs. */
  lastModelFamily: string;
  fitAdvancedExpanded: boolean;
  evalAdvancedExpanded: boolean;
}

/** Shape of `run_config` as chiron-orchestrator 0.3.32 reports it on
 *  get_training_status. Every field is optional: an older orchestrator sends
 *  no run_config at all, and a run started before a field existed sends it
 *  without that key. */
export interface RunConfig {
  num_rounds?: number;
  fit_config?: Record<string, any>;
  eval_config?: Record<string, any>;
  per_round_timeout?: number;
  transport?: string;
  initial_weights?: { artifact_id?: string; file_path?: string } | null;
}

interface TrainingConfigState {
  drafts: Record<string, Partial<TrainingConfigDraft>>;
  /** run_id each scope's draft was last seeded from, so a run is restored
   *  once and the operator's later edits are never overwritten by a poll. */
  seededRunIds: Record<string, string>;
  setField: <K extends keyof TrainingConfigDraft>(
    scope: string,
    field: K,
    value: TrainingConfigDraft[K],
  ) => void;
  seedFromRun: (scope: string, runId: string, config: RunConfig) => void;
  clearScope: (scope: string) => void;
}

export const useTrainingConfigStore = create<TrainingConfigState>((set, get) => ({
  drafts: {},
  seededRunIds: {},

  setField: (scope, field, value) =>
    set(state => ({
      drafts: {
        ...state.drafts,
        [scope]: { ...state.drafts[scope], [field]: value },
      },
    })),

  seedFromRun: (scope, runId, config) => {
    if (!runId) return;
    // Once per run. A run's configuration cannot change while it runs, so a
    // second seed could only ever undo something the operator typed.
    if (get().seededRunIds[scope] === runId) return;

    const draft: Partial<TrainingConfigDraft> = {};
    if (typeof config.num_rounds === 'number') draft.numRounds = config.num_rounds;
    if (typeof config.per_round_timeout === 'number') {
      draft.perRoundTimeoutMinutes = Math.max(1, Math.round(config.per_round_timeout / 60));
    }
    if (config.transport === 'websocket' || config.transport === 'webrtc') {
      draft.transport = config.transport;
    }
    if (config.fit_config && Object.keys(config.fit_config).length > 0) {
      draft.fitValues = { ...config.fit_config };
      // The run's own values are not defaults, so mark them as operator input.
      // Without this the next parameter refresh would merge the schema
      // defaults straight over the values the run is actually using.
      draft.editedFitKeys = Object.keys(config.fit_config);
    }
    if (config.eval_config && Object.keys(config.eval_config).length > 0) {
      draft.evalValues = { ...config.eval_config };
      draft.editedEvalKeys = Object.keys(config.eval_config);
    }
    const weights = config.initial_weights;
    if (weights && weights.artifact_id) {
      draft.usePretrainedWeights = true;
      draft.selectedArtifactId = weights.artifact_id;
      draft.selectedFilePath = weights.file_path || '';
    } else if (weights === null) {
      draft.usePretrainedWeights = false;
    }

    set(state => ({
      drafts: { ...state.drafts, [scope]: { ...state.drafts[scope], ...draft } },
      seededRunIds: { ...state.seededRunIds, [scope]: runId },
    }));
  },

  clearScope: scope =>
    set(state => {
      const drafts = { ...state.drafts };
      const seededRunIds = { ...state.seededRunIds };
      delete drafts[scope];
      delete seededRunIds[scope];
      return { drafts, seededRunIds };
    }),
}));

/**
 * `useState` with the value parked in the draft store instead of in the
 * component. Same call shape, including the updater form, so a field can be
 * moved across by changing only the hook name.
 *
 * Pass a module-level constant for object and array fallbacks. A fresh `{}`
 * on every render would hand every consumer a new identity and defeat the
 * effect guards that read these values.
 */
export function useDraftField<K extends keyof TrainingConfigDraft>(
  scope: string,
  field: K,
  fallback: TrainingConfigDraft[K],
): [TrainingConfigDraft[K], (value: TrainingConfigDraft[K] | ((prev: TrainingConfigDraft[K]) => TrainingConfigDraft[K])) => void] {
  const stored = useTrainingConfigStore(state => state.drafts[scope]?.[field]);
  const value = (stored === undefined ? fallback : stored) as TrainingConfigDraft[K];

  const setValue = (next: TrainingConfigDraft[K] | ((prev: TrainingConfigDraft[K]) => TrainingConfigDraft[K])) => {
    const state = useTrainingConfigStore.getState();
    // Read through getState rather than closing over `value`, so two setters
    // called in the same event handler both see the first one's write.
    const current = state.drafts[scope]?.[field];
    const prev = (current === undefined ? fallback : current) as TrainingConfigDraft[K];
    const resolved = typeof next === 'function'
      ? (next as (p: TrainingConfigDraft[K]) => TrainingConfigDraft[K])(prev)
      : next;
    state.setField(scope, field, resolved);
  };

  return [value, setValue];
}
