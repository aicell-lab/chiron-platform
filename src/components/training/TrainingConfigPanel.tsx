import React, { useState, useEffect, useCallback } from 'react';
import { FaChevronDown, FaChevronRight } from 'react-icons/fa';
import { DEFAULT_MODEL_FAMILY, getChironModel } from '../../config/chironModels';
import InfoPopover from '../BioEngine/InfoPopover';
import {
  WeightTransport,
  WEIGHT_TRANSPORT_LABELS,
  readWeightTransport,
  storeWeightTransport,
} from '../../config/federation';
import { promptReportIssue } from '../../utils/reportIssuePrompt';
import { useDraftField } from '../../store/trainingConfigStore';

// Stable identities for the object and array fallbacks handed to
// useDraftField. A fresh literal per render would give every consumer a new
// reference and defeat the guards that compare them.
const EMPTY_VALUES: Record<string, any> = {};
const EMPTY_KEYS: string[] = [];

// The next or previous power of two, never below 1. Batch size is the one
// field where a step of one is useless: memory use roughly doubles with it and
// the values anyone picks are 8, 16, 32 and so on. A value that is not a power
// of two steps to the nearest one in the chosen direction, so 20 goes up to 32
// and down to 16.
const stepPowerOfTwo = (value: number | null, direction: 1 | -1): number => {
  if (value === null || !Number.isFinite(value) || value < 1) return 1;
  const exponent = Math.log2(value);
  const next = direction > 0 ? Math.floor(exponent) + 1 : Math.ceil(exponent) - 1;
  return Math.max(1, 2 ** next);
};

// The two advanced fields that belong to the platform rather than to a model.
// Every Chiron trainer takes them, because the scaffold owns them as reserved
// Lightning arguments, so they read as boilerplate next to the settings that
// are actually specific to the model in front of you. The orchestrator hands
// them over in whatever order it built the dict, which for Tabula puts
// limit_train_batches above the five parameters the model declares. Keep them
// at the bottom of Advanced Parameters so the model's own settings come first.
const TRAILING_ADVANCED_PARAMS = ['limit_train_batches', 'limit_val_batches'];

// The outline and the ruled header that mark off one run phase's parameters
// from the next. Shared so the two sections cannot drift apart.
const SECTION_BOX = 'mb-5 rounded-xl border border-gray-200 p-4';
const SECTION_HEADING =
  'text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3 pb-2 ' +
  'border-b border-gray-100';

// Declaration order otherwise, so a trainer stays in charge of how its own
// parameters are grouped on screen.
const orderAdvanced = (
  advanced: Record<string, ParamConfig>
): [string, ParamConfig][] => {
  const entries = Object.entries(advanced);
  const rank = (key: string) => {
    const index = TRAILING_ADVANCED_PARAMS.indexOf(key);
    return index === -1 ? 0 : index + 1;
  };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
};

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
  /**
   * Which model the parameters above belong to, reported by chiron-orchestrator
   * 0.3.17 from the registered trainer's own properties. Absent when an older
   * orchestrator answers, in which case the panel simply names no model rather
   * than assuming one.
   */
  model?: {
    family: string;
    display_name: string;
    /** Prose description of the federated subset of the state dict, e.g.
     *  "the shared transformer trunk". Written by the trainer, not by a table
     *  in the frontend. */
    shared_weight_scope: string;
  };
  /**
   * What batch size each registered trainer will actually use, reported by
   * chiron-orchestrator 0.3.31 from the properties it cached when the trainer
   * registered. Absent when an older orchestrator answers, in which case the
   * batch size field stays uncapped, exactly as it was before.
   *
   * `max` is the largest ceiling in the federation. Asking for more than that
   * is clamped at every site, so it is the point past which the field stops
   * meaning anything.
   */
  batch_size_limits?: {
    max: number | null;
    min: number | null;
    trainers: {
      service_id: string;
      client_name: string;
      /** null when the trainer did not report one, which is not the same as
       *  having no limit. Rendered as unknown rather than as unlimited. */
      max_batch_size: number | null;
    }[];
  };
  /**
   * False when the orchestrator could not read the registered trainer's
   * properties, reported by chiron-orchestrator 0.4.2. The fit and evaluate
   * sections then carry only the two scaffold parameters and no batch size
   * default, which looks exactly like a model that declares nothing. Absent
   * when an older orchestrator answers, so only an explicit `false` is
   * treated as degraded.
   */
  hyperparameters_available?: boolean;
}

interface ArtifactEntry {
  id: string;
  alias: string;
  /** True for the architecture card's base weights rather than a published
   *  checkpoint. The card is not a checkpoint: it names where the base weights
   *  live, and the trainer follows that pointer when the run starts. */
  isBaseWeights?: boolean;
  manifest: {
    name?: string;
    global_transformer?: boolean;
    tissue?: string;
    num_rounds?: number;
    datasets?: {name: string}[];
    /** Family the checkpoint belongs to. Written by the orchestrator since
     *  0.3.x. Checkpoints published before that are all Tabula. */
    model_family?: string;
  };
}

interface TrainingConfigPanelProps {
  params: TrainerParams | null;
  loading: boolean;
  error: string | null;
  artifactManager: any;
  onStart: (config: {
    num_rounds: number;
    fit_config: Record<string, any>;
    eval_config: Record<string, any>;
    per_round_timeout: number;
    initial_weights: { artifact_id: string; file_path: string } | null;
    /** Which transport carries the weight blobs for this run. Chosen per run,
     *  not per deployment: the same orchestrator and trainers serve both. */
    transport: WeightTransport;
  }) => void;
  isPreparingTraining: boolean;
  isTraining: boolean;
  /** True when the selected orchestrator already has training history.
   *  Pretrained-weights default flips OFF in that case (loading a new
   *  checkpoint would overwrite the in-memory FedAvg state). Enabling it
   *  anyway pops a confirmation dialog. */
  hasHistory?: boolean;
  onConfigChange?: (numRounds: number, perRoundTimeoutMinutes: number) => void;
  /** Which orchestrator this config belongs to. Used as the key the draft is
   *  filed under, so switching orchestrators shows that orchestrator's own
   *  half-filled form rather than the last one touched. */
  configScope?: string;
  /** Why this run cannot be started, when something about the deployment
   *  itself rules it out rather than anything the user typed. Today that is an
   *  app older than the platform's floor (see src/config/chironVersions.ts).
   *  The form stays visible and editable, because the fix is on the worker and
   *  the user should still be able to see what they had configured. */
  blockedReason?: { title: string; detail: string } | null;
}

const CHIRON_MODELS_COLLECTION = 'chiron-platform/chiron-models';

/**
 * Where a model's architecture card lives. The card carries
 * `chiron.base_weights`, which is the maintained answer to "what does this
 * model start from". It is read on every fetch rather than baked into this
 * build, so a checkpoint that moves upstream is a card edit and nothing has to
 * be released or restarted.
 */
const architectureCardId = (family: string) => `chiron-platform/${family}`;

const TrainingConfigPanel: React.FC<TrainingConfigPanelProps> = ({
  params,
  loading,
  error,
  artifactManager,
  onStart,
  isPreparingTraining,
  isTraining,
  hasHistory,
  onConfigChange,
  configScope,
  blockedReason,
}) => {
  // Everything the operator sets is filed under this key. The panel is
  // unmounted by a parameter refresh, by collapsing the card and by leaving
  // the page, and none of those should discard a configuration.
  const scope = configScope || '__unscoped__';

  // A failed parameter fetch replaces the whole panel with a red banner and no
  // way forward, which is exactly the dead end the footer prompt exists for.
  // Keyed on the rendered banner rather than on the fetch, so a failure that
  // the caller recovers from before it reaches the screen stays silent.
  useEffect(() => {
    if (error) {
      promptReportIssue(`Failed to load training parameters: ${error}`);
    }
  }, [error]);

  // The model these parameters belong to. Everything model-specific in this
  // panel (its title, the checkpoint list, the wording of what gets federated)
  // reads from here rather than naming a model in the markup.
  const model = params?.model;
  const modelFamily = model?.family;

  // Top-level parameters
  const [numRounds, setNumRounds] = useDraftField(scope, 'numRounds', 5);
  const [perRoundTimeoutMinutes, setPerRoundTimeoutMinutes] = useDraftField(scope, 'perRoundTimeoutMinutes', 20);
  const [transport, setTransport] = useDraftField(scope, 'transport', readWeightTransport());

  // Pretrained weights — defaults ON for a fresh orchestrator, OFF when
  // history already exists (loading new pretrained weights would clobber
  // the previously trained shared transformer). The user can still flip it
  // back on; that path pops a confirmation dialog.
  const [usePretrainedWeights, setUsePretrainedWeights] = useDraftField(scope, 'usePretrainedWeights', !hasHistory);
  // Flip off when the parent first reports has-history (e.g. user just
  // selected an orchestrator that already has rounds). Only on the actual
  // transition: the draft's own fallback already covers the initial value, and
  // re-applying this on every mount would undo an operator who deliberately
  // turned pretrained weights back on.
  const prevHasHistory = React.useRef(hasHistory);
  useEffect(() => {
    if (hasHistory && !prevHasHistory.current) setUsePretrainedWeights(false);
    prevHasHistory.current = hasHistory;
  }, [hasHistory]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showOverwriteWarning, setShowOverwriteWarning] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useDraftField(scope, 'selectedArtifactId', '');
  const [isCheckpointDropdownOpen, setIsCheckpointDropdownOpen] = useState(false);
  const [weightFiles, setWeightFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useDraftField(scope, 'selectedFilePath', '');

  // Parameter values
  const [fitValues, setFitValues] = useDraftField(scope, 'fitValues', EMPTY_VALUES);
  const [evalValues, setEvalValues] = useDraftField(scope, 'evalValues', EMPTY_VALUES);

  // Accordion state
  const [fitAdvancedExpanded, setFitAdvancedExpanded] = useDraftField(scope, 'fitAdvancedExpanded', false);
  const [evalAdvancedExpanded, setEvalAdvancedExpanded] = useDraftField(scope, 'evalAdvancedExpanded', false);

  // Notify parent of config changes for header display
  useEffect(() => {
    onConfigChange?.(numRounds, perRoundTimeoutMinutes);
  }, [numRounds, perRoundTimeoutMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch every chiron-models checkpoint — at training start, the orchestrator
  // broadcasts the selected weights as the initial shared state to every
  // trainer. Both full models (global_transformer=false) and shared-weights
  // FedAvg saves (global_transformer=true) are valid here, as long as they
  // belong to the model this federation is training.
  const fetchArtifacts = useCallback(async () => {
    if (!artifactManager) return;
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const result = await artifactManager.list({
        parent_id: CHIRON_MODELS_COLLECTION,
        limit: 100,
        _rkwargs: true,
      });
      // A checkpoint only loads into the model it was trained for, so the list
      // is restricted to this federation's family. Checkpoints published
      // before the orchestrator wrote model_family are all Tabula, and an
      // orchestrator too old to report a model is training Tabula too.
      const family = modelFamily || DEFAULT_MODEL_FAMILY;
      const familyOf = (a: ArtifactEntry) =>
        a.manifest?.model_family || DEFAULT_MODEL_FAMILY;
      // Surface the model's foundation checkpoint (its generalist multi-tissue
      // release) first so it's the default Start-from-Pretrained-Weights
      // selection. Tissue-specific full models and shared-weights-only saves
      // come after, each group sorted alphabetically by manifest name for
      // predictability.
      // The architecture card's base weights, when it declares any. This is
      // the entry the platform maintains: the trainer resolves the card at
      // load time, so whatever the card points at today is what the run uses.
      let baseWeightsEntry: ArtifactEntry | null = null;
      try {
        const card = await artifactManager.read({
          artifact_id: architectureCardId(family),
          _rkwargs: true,
        });
        const declared = card?.manifest?.chiron?.base_weights;
        if (declared) {
          baseWeightsEntry = {
            id: card.id,
            alias: card.alias || family,
            isBaseWeights: true,
            manifest: {
              name:
                declared.label ||
                `${card.manifest?.name || family} base weights`,
              model_family: family,
            },
          };
        }
      } catch (e) {
        // No card, or the collection is unreachable. The foundation pin below
        // is the same weights by a less maintainable route, so the picker
        // degrades to what it offered before cards existed.
        console.warn('Could not read the architecture card for', family, e);
      }

      const foundationAlias = getChironModel(family)?.foundationAlias;
      const isFoundation = (a: ArtifactEntry) =>
        !!foundationAlias &&
        (a.alias || a.id.split('/').pop() || '').toLowerCase() === foundationAlias;
      const byName = (a: ArtifactEntry, b: ArtifactEntry) =>
        (a.manifest?.name || a.alias || a.id).localeCompare(b.manifest?.name || b.alias || b.id);
      const all = ((result || []) as ArtifactEntry[]).filter(a => familyOf(a) === family);
      // With a card in hand the foundation checkpoint is dropped from the
      // list: the card already points at it, and offering both would be two
      // entries for the same weights, only one of which follows an upstream
      // move.
      const foundation = baseWeightsEntry ? [] : all.filter(isFoundation);
      const others = all.filter(a => !isFoundation(a)).sort(byName);
      const checkpoints = [
        ...(baseWeightsEntry ? [baseWeightsEntry] : []),
        ...foundation,
        ...others,
      ];
      setArtifacts(checkpoints);
      // Default to the first entry, but keep a selection that is still in the
      // list. The list is refetched whenever the panel remounts, and re-picking
      // the default there would quietly swap the operator's checkpoint. Clear
      // it when the list is empty, otherwise a checkpoint picked for a
      // different model would still be sent to start_training.
      setSelectedArtifactId(prev =>
        checkpoints.length === 0
          ? ''
          : checkpoints.some(a => a.id === prev)
            ? prev
            : checkpoints[0].id
      );
    } catch (e: any) {
      console.error('Failed to load pretrained checkpoints:', e);
      setArtifactsError('Failed to load pretrained checkpoints');
    } finally {
      setArtifactsLoading(false);
    }
  }, [artifactManager, modelFamily]);

  useEffect(() => {
    if (usePretrainedWeights) fetchArtifacts();
  }, [usePretrainedWeights, modelFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global transformer weight artifacts always use model.pth — no file picker needed.

  // Fields the operator has typed into, so a params refresh can reload the
  // defaults for everything else without overwriting work in progress.
  //
  // The refresh used to be constant: `params` was republished by a 10s poll
  // and this effect reset every field on each one, so a config took longer to
  // fill in than the interval that wiped it. Training.tsx no longer republishes
  // an unchanged payload, which removes that loop, but a genuine change (the
  // operator selects a different orchestrator mid-edit) still lands here and
  // still must not silently discard typed values.
  //
  // Kept in the draft store alongside the values, not in a ref: a ref dies with
  // the component, and the whole point is that an unmount must not turn typed
  // values back into defaults on the next refresh.
  const [editedFitKeys, setEditedFitKeys] = useDraftField(scope, 'editedFitKeys', EMPTY_KEYS);
  const [editedEvalKeys, setEditedEvalKeys] = useDraftField(scope, 'editedEvalKeys', EMPTY_KEYS);

  // A different model means different parameters, so anything carried over
  // would be a value from another model's schema. Forget the edits and let the
  // new defaults through.
  //
  // Only a move between two *known* models counts. `params` is set to null
  // whenever the orchestrator reports no registered trainers, and it reports
  // none at the end of every round, so `modelFamily` drops to undefined and
  // comes back on its own. Reading that gap as a model change wiped the
  // record of what the operator had typed, and the next parameter refresh
  // then merged the schema defaults straight over their values. Configuring a
  // follow-on run from a previous checkpoint hits this every time, because
  // the round that produced the checkpoint is also what flushed the list.
  //
  // The last known family lives in the draft store rather than in a ref for
  // the same reason the values do: the panel is unmounted by a collapse or a
  // route change, and a ref would come back empty and defeat the comparison.
  const [lastModelFamily, setLastModelFamily] = useDraftField(scope, 'lastModelFamily', '');
  useEffect(() => {
    if (!modelFamily || modelFamily === lastModelFamily) return;
    if (lastModelFamily) {
      setEditedFitKeys(EMPTY_KEYS);
      setEditedEvalKeys(EMPTY_KEYS);
    }
    setLastModelFamily(modelFamily);
  }, [modelFamily, lastModelFamily]); // eslint-disable-line react-hooks/exhaustive-deps

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
    
    // The schema's batch size default is written per model, not per machine,
    // so on a small GPU it can already be above what the registered trainers
    // will accept. Bring it down to the cap here rather than showing a number
    // that the run would quietly reduce.
    const cap = params.batch_size_limits?.max;
    if (cap && typeof initialFitValues.batch_size === 'number' && initialFitValues.batch_size > cap) {
      initialFitValues.batch_size = cap;
    }
    if (cap && typeof initialEvalValues.batch_size === 'number' && initialEvalValues.batch_size > cap) {
      initialEvalValues.batch_size = cap;
    }

    // Defaults for untouched fields, the operator's own value for the rest.
    // A key the schema dropped disappears either way, because the merge starts
    // from the new defaults rather than from the previous values.
    const merge = (
      prev: Record<string, any>,
      defaults: Record<string, any>,
      edited: string[]
    ): Record<string, any> => {
      const next = { ...defaults };
      edited.forEach(key => {
        if (key in next && key in prev) next[key] = prev[key];
      });
      return next;
    };

    setFitValues(prev => merge(prev, initialFitValues, editedFitKeys));
    setEvalValues(prev => merge(prev, initialEvalValues, editedEvalKeys));
  }, [params, editedFitKeys, editedEvalKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // The federation-wide batch size ceiling, or null when the orchestrator is
  // too old to report one. Every trainer clamps a larger request down to its
  // own limit, so a value above the largest limit is reduced everywhere and
  // changes nothing. Capping the field there turns a silent reduction into a
  // visible bound.
  const batchSizeLimits = params?.batch_size_limits;
  const batchSizeCap = batchSizeLimits?.max ?? null;

  // Render input field based on parameter type
  const renderInput = (
    key: string,
    config: ParamConfig,
    value: any,
    onChange: (key: string, value: any) => void
  ) => {
    // Only `batch_size` is bounded, and only when the orchestrator reported a
    // ceiling. Every other field keeps the schema's own bounds.
    const cap = key === 'batch_size' ? batchSizeCap : null;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let newValue: any = e.target.value;

      // Type conversion based on parameter type
      if (config.type === 'integer') {
        newValue = newValue === '' ? null : parseInt(newValue, 10);
        if (cap !== null && typeof newValue === 'number' && newValue > cap) {
          newValue = cap;
        }
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

    // Batch size steps by doubling and halving rather than by one. Typing a
    // value by hand is unchanged, so anything off the power-of-two ladder is
    // still reachable.
    const powerOfTwoStepped = key === 'batch_size';
    const currentNumber = typeof value === 'number' ? value : null;
    const stepBy = (direction: 1 | -1) => {
      let next = stepPowerOfTwo(currentNumber ?? config.default ?? null, direction);
      if (cap !== null && next > cap) next = cap;
      onChange(key, next);
    };

    return (
      <div key={key} className="mb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <label className="block text-xs font-semibold text-gray-700">
            {key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
          </label>
          {cap !== null && batchSizeLimits && (
            <InfoPopover label="About the batch size limit">
              <p className="font-semibold text-gray-800 mb-1">Capped at {cap}</p>
              <p>
                One batch size goes to every trainer, but each one clamps it to what its own GPU
                can hold. Above {cap} the value is reduced at every site, so it stops meaning
                anything. Between the smallest and largest limit below, the smaller sites train in
                smaller batches while the larger ones use the value as given.
              </p>
              <p className="mt-2 font-medium text-gray-700">Per trainer</p>
              <ul className="mt-0.5 space-y-0.5">
                {batchSizeLimits.trainers.map(t => (
                  <li key={t.service_id} className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-gray-600">{t.client_name}</span>
                    <span className="flex-shrink-0 font-medium text-gray-800">
                      {t.max_batch_size ?? 'not reported'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-gray-400">
                Each trainer's limit is set when it is deployed, in the Launch Application dialog.
              </p>
            </InfoPopover>
          )}
        </div>
        <p className="text-xs text-gray-400 mb-1.5">{config.description}</p>

        {config.type === 'boolean' ? (
          <input
            type="checkbox"
            checked={value ?? config.default ?? false}
            onChange={handleChange}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          />
        ) : config.type === 'integer' && powerOfTwoStepped ? (
          <div className="flex items-stretch">
            <button
              type="button"
              aria-label="Halve to previous power of 2"
              onClick={() => stepBy(-1)}
              disabled={currentNumber !== null && currentNumber <= 1}
              className="px-3 text-sm font-semibold text-gray-600 bg-gray-50 border border-r-0 border-gray-200 rounded-l-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              −
            </button>
            <input
              type="number"
              step="1"
              value={inputValue}
              onChange={handleChange}
              onKeyDown={e => {
                // Match the +/- buttons on keyboard so arrow-stepping does not
                // drop back to the native step of one.
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                e.preventDefault();
                stepBy(e.key === 'ArrowUp' ? 1 : -1);
              }}
              max={cap ?? undefined}
              placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
              className="flex-1 min-w-0 px-3 py-2 text-sm text-center border-y border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:relative [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <button
              type="button"
              aria-label="Double to next power of 2"
              onClick={() => stepBy(1)}
              disabled={cap !== null && currentNumber !== null && currentNumber >= cap}
              className="px-3 text-sm font-semibold text-gray-600 bg-gray-50 border border-l-0 border-gray-200 rounded-r-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              +
            </button>
          </div>
        ) : config.type === 'integer' ? (
          <input
            type="number"
            step="1"
            value={inputValue}
            onChange={handleChange}
            max={cap ?? undefined}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : config.type === 'number' ? (
          <input
            type="number"
            step="any"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <input
            type="text"
            value={inputValue}
            onChange={handleChange}
            placeholder={config.default !== null && config.default !== undefined ? String(config.default) : 'Optional'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
    // Fit and Evaluate carry overlapping field names, batch size in both and a
    // limit in both, so two sections running together under faint headings read
    // as one long list with a repeat in the middle. Each gets its own outline
    // and its own ruled header, which is the panel's existing way of separating
    // a group, so which run phase a field belongs to is legible without
    // tracing back up to the last heading.
    if (!section) {
      return (
        <div className={SECTION_BOX}>
          <h4 className={SECTION_HEADING}>{title}</h4>
          <p className="text-xs text-gray-400 italic">No parameters to configure</p>
        </div>
      );
    }

    const hasStandard = section.standard && Object.keys(section.standard).length > 0;
    const hasAdvanced = section.advanced && Object.keys(section.advanced).length > 0;

    return (
      <div className={SECTION_BOX}>
        <h4 className={SECTION_HEADING}>{title}</h4>

        {hasStandard ? (
          <div className="mb-3">
            {Object.entries(section.standard).map(([key, config]) =>
              renderInput(key, config, values[key], onChange)
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-400 italic mb-3">No standard parameters to configure</p>
        )}

        {hasAdvanced && (
          <div className="border-t border-gray-100 pt-3">
            <button
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 mb-3 transition-colors"
            >
              {advancedExpanded ? <FaChevronDown size={10} /> : <FaChevronRight size={10} />}
              Advanced Parameters
            </button>

            {advancedExpanded && (
              <div className="ml-3 pl-3 border-l-2 border-gray-100">
                {orderAdvanced(section.advanced).map(([key, config]) =>
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
    setEditedFitKeys(prev => (prev.includes(key) ? prev : [...prev, key]));
    setFitValues(prev => ({ ...prev, [key]: value }));
  };

  const handleUpdateEvalValue = (key: string, value: any) => {
    setEditedEvalKeys(prev => (prev.includes(key) ? prev : [...prev, key]));
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
      per_round_timeout: perRoundTimeoutMinutes * 60,
      transport,
      initial_weights: usePretrainedWeights && selectedArtifactId
        ? { artifact_id: selectedArtifactId, file_path: 'model.pth' }
        : null,
    });
  };

  // Only while there is nothing to show. A refresh that arrives once the form
  // is on screen must not replace it with a spinner: swapping the whole panel
  // out mid-edit reads as the page reloading itself, and it costs the operator
  // their place in a form that takes longer to fill in than the poll interval.
  // The refresh is reported in the header instead, below.
  if (loading && !params) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading parameters...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <p className="text-red-800">Failed to load training parameters: {error}</p>
      </div>
    );
  }

  // Show message when no params are available (no trainers selected)
  if (!params) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
        <p className="text-blue-800">Please select at least one trainer to configure training parameters.</p>
      </div>
    );
  }

  return (
    <div>

      {/* A refresh in flight over a form that is already on screen. Reported
          here rather than by swapping the form for a spinner, so nothing the
          operator has typed leaves the screen. */}
      {loading && (
        <div className="mb-3 flex items-center gap-2 text-xs text-gray-400">
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-300" />
          <span>Refreshing parameters</span>
        </div>
      )}

      {/* Which model these parameters belong to. The lists below are read from
          the registered trainer's own schema, so without this line a user
          reading them has no way to tell whose parameters they are. */}
      {model && (
        <div className="mb-5 pb-4 border-b border-gray-100 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
            {model.display_name}
          </span>
          <p className="text-xs text-gray-400">
            Parameters below are declared by this federation's {model.display_name} trainer.
            Each round federates the weights under{' '}
            <code className="text-gray-500">{model.shared_weight_scope}</code>.
          </p>
        </div>
      )}

      {/* Top-level parameters */}
      <div className="mb-5 pb-5 border-b border-gray-100">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-0.5">Number of Rounds</label>
            <input
              type="number"
              min="1"
              step="1"
              value={numRounds}
              onChange={(e) => setNumRounds(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-400">All clients train locally, then the server aggregates (FedAvg).</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-0.5">Per Round Timeout (minutes)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={perRoundTimeoutMinutes}
              onChange={(e) => setPerRoundTimeoutMinutes(parseInt(e.target.value, 10) || 20)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-400">Maximum time for fit + evaluate per round. Aborts if exceeded.</p>
          </div>
        </div>

        {/* Weight transport. A run-level choice rather than a deployment one:
            the same orchestrator and trainers serve both, so switching costs a
            restart of the run and nothing else. Peer-to-peer is the normal
            path and covers restrictive networks through the TURN relay, so
            this switch exists for the residual case where even the relay is
            unreachable and the operator needs a way through without waiting
            for anyone.

            Presented as a single on/off switch rather than a pair of
            transport names. The operator's decision is whether weights
            should avoid the server, which is a privacy question they can
            answer; 'WebSocket vs WebRTC' asks them to translate that into
            protocol names first. The names still appear in the popover, so
            anyone matching this against a log or the orchestrator API can
            find them. */}
        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <label className="block text-xs font-semibold text-gray-700">Peer-to-Peer Weight Transfer</label>
              <InfoPopover label="About peer-to-peer weight transfer">
                <p className="font-semibold text-gray-800 mb-1">Peer-to-peer (WebRTC)</p>
                <p>{WEIGHT_TRANSPORT_LABELS.webrtc.hint}</p>
                <p className="mt-1">
                  A direct path is used where the network allows one. Where it does not, a TURN
                  relay forwards the encrypted packets without being able to read them, so a
                  relayed run is exactly as private as a direct one.
                </p>
                <p className="mt-1">
                  There is no automatic fallback to the server. If even the relay cannot connect,
                  the trainer sits out that round rather than quietly sending its weights through
                  the server. Turning this off is the way through a network that blocks all of it.
                </p>
                <p className="font-semibold text-gray-800 mt-3 mb-1">Off: through the server (WebSocket)</p>
                <p>{WEIGHT_TRANSPORT_LABELS.websocket.hint}</p>
                <p className="mt-3 text-gray-500">
                  Either way, only model weights and scalar metrics ever leave a site. Raw data
                  never does.
                </p>
              </InfoPopover>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {transport === 'webrtc'
                ? 'Weights travel encrypted between sites and no server can read them. Falls back to an encrypted relay where the network blocks a direct path.'
                : 'Weights pass through the Hypha server, which can read them. Use this only where peer-to-peer cannot connect at all.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={transport === 'webrtc'}
            aria-label="Peer-to-peer weight transfer"
            onClick={() => {
              const next: WeightTransport = transport === 'webrtc' ? 'websocket' : 'webrtc';
              setTransport(next);
              storeWeightTransport(next);
            }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${transport === 'webrtc' ? 'bg-emerald-500' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${transport === 'webrtc' ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {/* Pretrained weights */}
      <div className="mb-5 pb-5 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-1.5">
              <label className="block text-xs font-semibold text-gray-700">Start from Pretrained Weights</label>
              <InfoPopover label="About starting from pretrained weights">
                <p>
                  Broadcasts only the shared weights
                  {model?.shared_weight_scope && (
                    <> (<code className="text-gray-500">{model.shared_weight_scope}</code>)</>
                  )}{' '}from
                  the selected checkpoint to every trainer before round 1. Each
                  trainer's site-local components stay local: they are not
                  overwritten.
                </p>
                {hasHistory && (
                  <p className="mt-2">
                    This orchestrator already has training history. Enabling this
                    also resets that history, so the next run starts from scratch.
                  </p>
                )}
              </InfoPopover>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Initialise every trainer from a published checkpoint instead of
              starting from scratch.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              // Turning ON when history exists would overwrite the
              // already-trained transformer at the start of the next run;
              // surface a confirmation first.
              if (!usePretrainedWeights && hasHistory) {
                setShowOverwriteWarning(true);
                return;
              }
              setUsePretrainedWeights(v => !v);
            }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${usePretrainedWeights ? 'bg-emerald-500' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${usePretrainedWeights ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
        {usePretrainedWeights && (
          <div className="space-y-3 mt-3">
            {artifactsLoading ? (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-400" />
                Loading checkpoints…
              </div>
            ) : artifactsError ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-red-500">{artifactsError}</p>
                <button onClick={fetchArtifacts} className="text-xs text-blue-600 hover:underline">Retry</button>
              </div>
            ) : artifacts.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                No published {model?.display_name ? `${model.display_name} ` : ''}checkpoints in chiron-models yet
              </p>
            ) : (() => {
              const selected = artifacts.find(a => a.id === selectedArtifactId);
              const baseWeights = artifacts.filter(a => a.isBaseWeights);
              const fullModels = artifacts.filter(a => !a.isBaseWeights && a.manifest?.global_transformer !== true);
              const globalTransformers = artifacts.filter(a => !a.isBaseWeights && a.manifest?.global_transformer === true);
              const fmt = (a: ArtifactEntry) => {
                const datasets = a.manifest?.datasets?.map(d => d.name).join(', ') || '';
                const rounds = a.manifest?.num_rounds;
                return [rounds ? `${rounds} rounds` : '', datasets].filter(Boolean).join(' · ');
              };
              return (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Checkpoint</label>
                  <button
                    type="button"
                    onClick={() => setIsCheckpointDropdownOpen(o => !o)}
                    className="w-full text-left px-3 py-2 border border-gray-200 rounded-lg bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors relative"
                  >
                    {selected ? (
                      <div className="pr-5">
                        <p className="text-sm text-gray-800">{selected.manifest?.name || selected.alias || selected.id}</p>
                        {fmt(selected) && <p className="text-xs text-gray-500 mt-0.5">{fmt(selected)}</p>}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-500 pr-5">Select a checkpoint…</span>
                    )}
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">{isCheckpointDropdownOpen ? '▴' : '▾'}</span>
                  </button>
                  {isCheckpointDropdownOpen && (
                    <div className="mt-1 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="max-h-64 overflow-y-auto divide-y divide-gray-50" onWheel={e => e.stopPropagation()}>
                        {baseWeights.length > 0 && (
                          <>
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">Base Weights</div>
                            {baseWeights.map(a => (
                              <button key={a.id} type="button"
                                onClick={() => { setSelectedArtifactId(a.id); setIsCheckpointDropdownOpen(false); }}
                                className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedArtifactId === a.id ? 'bg-emerald-50' : ''}`}>
                                <p className="text-sm text-gray-800">{a.manifest?.name || a.alias}</p>
                                <p className="text-xs text-gray-500 mt-0.5">What this model starts from, before any federated training</p>
                              </button>
                            ))}
                          </>
                        )}
                        {fullModels.length > 0 && (
                          <>
                            {/* Named after whichever model this federation is
                                training. The list is already filtered to that
                                model's family, so a fixed "Tabula" here labelled
                                every other model's checkpoints as Tabula's. */}
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">
                              {model?.display_name ? `Full ${model.display_name} Models` : 'Full Models'}
                            </div>
                            {fullModels.map(a => {
                              const label = a.manifest?.name || a.alias || a.id;
                              const sub = fmt(a);
                              return (
                                <button key={a.id} type="button"
                                  onClick={() => { setSelectedArtifactId(a.id); setIsCheckpointDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedArtifactId === a.id ? 'bg-emerald-50' : ''}`}>
                                  <p className="text-sm text-gray-800">{label}</p>
                                  {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
                                </button>
                              );
                            })}
                          </>
                        )}
                        {globalTransformers.length > 0 && (
                          <>
                            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">Global Transformer Checkpoints</div>
                            {globalTransformers.map(a => {
                              const label = a.manifest?.name || a.alias || a.id;
                              const sub = fmt(a);
                              return (
                                <button key={a.id} type="button"
                                  onClick={() => { setSelectedArtifactId(a.id); setIsCheckpointDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedArtifactId === a.id ? 'bg-emerald-50' : ''}`}>
                                  <p className="text-sm text-gray-800">{label}</p>
                                  {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
                                </button>
                              );
                            })}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* The orchestrator caches each trainer's properties once, when the
          trainer registers, and a failed fetch there is only logged. The two
          sections below are still rendered because every field they do carry
          is valid and an omitted key falls back to the model's own default at
          the trainer. What is not acceptable is letting that form pass for the
          model's full set of parameters, which is what it looks like: same
          layout, same headings, just missing every knob the model declares. */}
      {params && params.hyperparameters_available === false && (
        <div className="mb-5 text-xs bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800">
          <p className="font-semibold mb-1">Showing partial parameters</p>
          <p>
            The orchestrator could not read this trainer's parameter list, so only the
            batch size and batch limits are offered below. Anything left blank uses the
            model's own default. Reselect the trainer to have the orchestrator read it
            again.
          </p>
        </div>
      )}

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

      {blockedReason && (
        <div className="text-xs bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800">
          <p className="font-semibold mb-1">{blockedReason.title}</p>
          <p>{blockedReason.detail}</p>
        </div>
      )}

      {/* Start button */}
      <button
        onClick={handleStartTraining}
        disabled={isPreparingTraining || isTraining || !!blockedReason}
        title={blockedReason ? blockedReason.title : undefined}
        className="w-full bg-emerald-600 text-white px-4 py-3 rounded-xl hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold text-sm shadow-sm transition-all"
      >
        {isPreparingTraining ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            Preparing Training...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            Start Training · {numRounds} round{numRounds !== 1 ? 's' : ''} · {perRoundTimeoutMinutes} min timeout
          </>
        )}
      </button>

      {showOverwriteWarning && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-amber-50 flex items-center gap-3">
              <svg className="w-6 h-6 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="font-semibold text-gray-900">Overwrite trained weights and reset history?</h3>
            </div>
            <div className="px-6 py-4 text-sm text-gray-600 space-y-2">
              <p>
                This orchestrator already has training history. Enabling
                "Start from Pretrained Weights" will:
              </p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>
                  Overwrite the previously trained shared weights with the
                  selected checkpoint before round 1.
                </li>
                <li>
                  Reset the orchestrator's training history (per-round
                  losses, round counter, run metadata) so the next run
                  starts from scratch.
                </li>
              </ul>
              <p>
                Each trainer's site-local components stay local. Only the
                shared weights
                {model?.shared_weight_scope && (
                  <> (<code className="text-gray-500">{model.shared_weight_scope}</code>)</>
                )}{' '}are
                replaced. Trainers' on-disk weight checkpoints are not
                touched either.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                onClick={() => setShowOverwriteWarning(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setUsePretrainedWeights(true); setShowOverwriteWarning(false); }}
                className="px-4 py-2 text-sm font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors"
              >
                Overwrite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TrainingConfigPanel;
