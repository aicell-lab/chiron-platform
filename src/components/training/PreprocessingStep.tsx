import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import DistributionChart from './DistributionChart';
import {
  PreprocessingRecipe,
  PreprocessingSchema,
  PreprocessingStatus,
  PreprocessingTarget,
  adjustableParams,
  changedParams,
  submittedParams,
  defaultValues,
  federationAgreement,
  fixedParams,
  keptFraction,
  paramErrors,
} from '../../config/preprocessing';

export interface PreprocessingStepProps {
  /** One entry per site and dataset joining this run. */
  targets: PreprocessingTarget[];
  /** The model every selected site is running, when they agree on one. */
  modelFamily?: string;
  /** Display name for that model. */
  modelLabel?: string;
  callManager: (
    managerId: string,
    method: string,
    args: Record<string, any>,
    options?: { timeoutMs?: number }
  ) => Promise<any>;
  /** Open the variability or embedding dialog for one prepared dataset. */
  onOpenVariability?: (managerId: string, datasetId: string) => void;
  onOpenUmap?: (managerId: string, datasetId: string) => void;
}

/** Which distributions to draw, and which parameter cuts each one.
 *
 *  `param` is matched as a SUFFIX of the applied parameter's name, because
 *  every model names the same filter after itself. */
const CHARTS: Array<{
  key: string;
  title: string;
  unit: string;
  param?: string;
  caption?: string;
  describe: (value: number) => string;
}> = [
  {
    key: 'detected_per_cell',
    title: 'Detected genes per cell',
    unit: 'cells',
    param: 'min_genes_per_cell',
    describe: v => `Cells below ${v.toLocaleString()} detected genes are excluded.`,
  },
  {
    key: 'cells_per_gene',
    title: 'Cells each gene is detected in',
    unit: 'genes',
    param: 'min_cells_per_gene',
    describe: v =>
      `Genes detected in fewer than ${v.toLocaleString()} cells are excluded.`,
  },
  {
    key: 'ranked_per_cell',
    title: 'Genes ranked per cell',
    unit: 'cells',
    param: 'min_genes_per_cell',
    caption: "How long each cell's input sequence will be.",
    describe: v => `Cells below ${v.toLocaleString()} detected genes contribute nothing.`,
  },
];

type StatusMap = Record<string, PreprocessingStatus>;
const keyOf = (t: PreprocessingTarget) => `${t.managerId}::${t.datasetId}`;

/**
 * Step 3: set the preprocessing, apply it to every selected site, review it.
 *
 * This step exists because preprocessing is a federation-level decision that
 * used to be a per-site accident. Every site has to filter its data the same
 * way, or FedAvg averages weights from models trained on differently filtered
 * data, which produces no error anywhere and a quietly wrong model. Applying
 * one parameter set to every selected site from one button is what makes them
 * agree by construction rather than by everyone remembering.
 *
 * It sits after site selection and before training so the result can be
 * reviewed in place. Reviewing it used to mean leaving the training flow for
 * the worker dialog and coming back.
 *
 * Nothing shown here is a per-cell number. Counts, fractions and binned
 * distributions only, which is what lets an organiser see what their threshold
 * did to a site's data without the site disclosing anything about any one cell.
 */
const PreprocessingStep: React.FC<PreprocessingStepProps> = ({
  targets,
  modelFamily,
  modelLabel,
  callManager,
  onOpenVariability,
  onOpenUmap,
}) => {
  const [schema, setSchema] = useState<PreprocessingSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [touched, setTouched] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  // Sites whose last status poll failed. Distinct from applyErrors: this one
  // means "we do not know", not "it went wrong", and the two read differently.
  const [unreachable, setUnreachable] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [polling, setPolling] = useState(false);

  const recipe: PreprocessingRecipe | undefined = useMemo(
    () => (modelFamily ? schema?.recipes?.[modelFamily] : undefined),
    [schema, modelFamily]
  );

  // The schema comes from a site rather than from this build, so that the form
  // can only ever offer parameters that site's data server accepts. Any site
  // will do: they are asked for the same model and a federation whose sites
  // disagree about the recipe has a problem the form cannot paper over.
  const firstManager = targets[0]?.managerId;
  useEffect(() => {
    let cancelled = false;
    if (!firstManager) return;
    (async () => {
      try {
        const result: PreprocessingSchema = await callManager(
          firstManager,
          'get_preprocessing_schema',
          {},
          { timeoutMs: 20000 }
        );
        if (cancelled) return;
        setSchema(result);
        setSchemaError(
          result?.available === false
            ? result?.reason || 'this site cannot report what it can prepare'
            : null
        );
      } catch (e: any) {
        if (cancelled) return;
        setSchemaError(
          'This site is running a worker image that predates configurable ' +
            `preprocessing, so there is nothing to set here (${e?.message || e}).`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstManager, callManager]);

  // Seed the form from the recipe once it arrives, and never again, so a value
  // the operator typed survives the polling that refreshes everything else.
  useEffect(() => {
    if (recipe && !touched) setValues(defaultValues(recipe));
  }, [recipe, touched]);

  const errors = useMemo(() => paramErrors(recipe, values), [recipe, values]);
  const hasErrors = Object.keys(errors).length > 0;
  const overrides = useMemo(() => changedParams(recipe, values), [recipe, values]);
  // Every adjustable value, not only the moved ones. See submittedParams.
  const submitted = useMemo(() => submittedParams(recipe, values), [recipe, values]);

  const refreshStatus = useCallback(async () => {
    if (!modelFamily || targets.length === 0) return;
    const next: StatusMap = {};
    const failures: Record<string, string> = {};
    await Promise.all(
      targets.map(async target => {
        try {
          next[keyOf(target)] = (await callManager(
            target.managerId,
            'get_preprocessing_status',
            { dataset_id: target.datasetId, model_family: modelFamily },
            { timeoutMs: 20000 }
          )) as PreprocessingStatus;
        } catch (e: any) {
          // A dropped poll must not make a prepared dataset look unprepared,
          // so the previous answer is kept by the merge below rather than
          // overwritten. But it must not look like silence either: a site
          // nobody can reach is reported as unreachable, with the reason,
          // instead of rendering as the same grey "Not prepared" badge a site
          // that was never asked gets.
          failures[keyOf(target)] = e?.message || String(e);
        }
      })
    );
    setStatuses(prev => ({ ...prev, ...next }));
    setUnreachable(failures);
  }, [targets, modelFamily, callManager]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Poll while anything is still working. Stopping once everything settles
  // keeps an idle Prepare step off the network entirely.
  const anyPending = useMemo(
    () =>
      targets.some(t => {
        const state = statuses[keyOf(t)]?.state;
        return state === undefined || state === 'pending';
      }),
    [targets, statuses]
  );
  useEffect(() => {
    if (!polling && !anyPending) return;
    const timer = setTimeout(() => {
      refreshStatus();
      if (!anyPending) setPolling(false);
    }, 8000);
    return () => clearTimeout(timer);
    // Deliberately NOT depending on `statuses`. This effect refreshes them, so
    // depending on them would reschedule the timer on every answer rather than
    // every eight seconds. `anyPending` is derived from them and is the only
    // part of them this decision turns on.
  }, [polling, anyPending, refreshStatus]);

  const apply = async () => {
    if (!modelFamily || hasErrors) return;
    setApplying(true);
    setApplyErrors({});
    const failures: Record<string, string> = {};
    await Promise.all(
      targets.map(async target => {
        try {
          await callManager(
            target.managerId,
            'apply_preprocessing',
            {
              dataset_id: target.datasetId,
              model_family: modelFamily,
              params: submitted,
            },
            { timeoutMs: 60000 }
          );
        } catch (e: any) {
          failures[keyOf(target)] = e?.message || String(e);
        }
      })
    );
    setApplyErrors(failures);
    setApplying(false);
    setPolling(true);
    // Marked as recomputing rather than cleared.
    //
    // Clearing looked right: a site that is recomputing should not keep
    // showing numbers from before the thresholds moved. But it also threw away
    // the only thing protecting a prepared dataset from a dropped poll, and
    // the poll most likely to drop is the one issued while every site is busy
    // preparing. The stale numbers are hidden by the pending state instead,
    // and the last good answer stays underneath them.
    setStatuses(prev => {
      const next: StatusMap = { ...prev };
      for (const target of targets) {
        const key = keyOf(target);
        if (next[key]) next[key] = { ...next[key], state: 'pending' };
      }
      return next;
    });
    refreshStatus();
  };

  const agreement = useMemo(
    () => federationAgreement(targets.map(t => statuses[keyOf(t)])),
    [targets, statuses]
  );

  if (targets.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900">Prepare the data</h3>
        <p className="text-sm text-gray-500 mt-1">
          No site has joined this training yet. Pick the sites and datasets on
          the previous step, and their preprocessing settings appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              Prepare the data
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {modelLabel || modelFamily
                ? `${modelLabel || modelFamily} reads its own preparation of ` +
                  'the raw counts. These settings are applied to every ' +
                  'selected site, so all of them filter their data the same way.'
                : 'Each model reads its own preparation of the raw counts, and ' +
                  'every site in a federation has to prepare its data the ' +
                  'same way.'}
            </p>
          </div>
          <span className="shrink-0 text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1">
            {targets.length} dataset{targets.length === 1 ? '' : 's'} across{' '}
            {new Set(targets.map(t => t.managerId)).size} site
            {new Set(targets.map(t => t.managerId)).size === 1 ? '' : 's'}
          </span>
        </div>

        {schemaError && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <p className="text-xs text-amber-800">{schemaError}</p>
          </div>
        )}

        {/* Everything below is inside `recipe &&`, so without one this panel
            renders a heading and nothing else. Two ways to get there and both
            are reachable: a model this site has no recipe for, and a
            federation whose sites run different models, where the page cannot
            name one model to prepare for. Say which. */}
        {!recipe && !schemaError && schema && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <p className="text-xs text-amber-800">
              {!modelFamily
                ? 'The selected sites are not all running the same model, so ' +
                  'there is no single preparation to apply. Training a ' +
                  'federation whose sites run different models is not ' +
                  'supported, so go back and pick sites that agree.'
                : `This site has no preprocessing recipe for ${
                    modelLabel || modelFamily
                  }. It can prepare: ${
                    Object.keys(schema.recipes || {}).join(', ') || 'nothing'
                  }. The run will use whatever preparation the data already ` +
                  'carries.'}
            </p>
          </div>
        )}
        {!schema && !schemaError && (
          <p className="text-xs text-gray-500 mt-4">
            Asking this site what it can prepare...
          </p>
        )}

        {recipe && (
          <>
            <p className="text-xs text-gray-500 mt-4">{recipe.description}</p>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {adjustableParams(recipe).map(param => (
                <div key={param.name}>
                  <label
                    className="block text-xs font-medium text-gray-700"
                    htmlFor={`prep-${param.name}`}
                  >
                    {param.label}
                    {param.unit ? (
                      <span className="text-gray-400 font-normal"> ({param.unit})</span>
                    ) : null}
                  </label>
                  <input
                    id={`prep-${param.name}`}
                    type="number"
                    value={values[param.name] ?? ''}
                    min={param.minimum ?? undefined}
                    max={param.maximum ?? undefined}
                    onChange={e => {
                      setTouched(true);
                      setValues(prev => ({ ...prev, [param.name]: e.target.value }));
                    }}
                    className={`mt-1 w-full rounded-lg border px-3 py-1.5 text-sm ${
                      errors[param.name]
                        ? 'border-red-300 bg-red-50'
                        : 'border-gray-300'
                    }`}
                  />
                  <p className="text-[11px] text-gray-500 mt-1">{param.description}</p>
                  {errors[param.name] && (
                    <p className="text-[11px] text-red-600 mt-1">{errors[param.name]}</p>
                  )}
                  {values[param.name] !== undefined &&
                    Number(values[param.name]) !== param.default &&
                    !errors[param.name] && (
                      <p className="text-[11px] text-blue-600 mt-1">
                        Published value: {param.default.toLocaleString()}
                      </p>
                    )}
                </div>
              ))}
            </div>

            {fixedParams(recipe).length > 0 && (
              <div className="mt-4 bg-gray-50 rounded-xl p-3">
                <p className="text-xs font-medium text-gray-500 mb-1.5">
                  Fixed by the checkpoint
                </p>
                <dl className="space-y-1.5">
                  {fixedParams(recipe).map(param => (
                    <div key={param.name} className="text-[11px]">
                      <dt className="text-gray-700 inline font-medium">
                        {param.label}: {param.default.toLocaleString()}
                        {param.unit ? ` ${param.unit}` : ''}
                      </dt>
                      <dd className="text-gray-500 inline"> {param.description}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={apply}
                disabled={applying || hasErrors}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-[transform,background-color] duration-150 ease-out active:scale-[0.98]"
              >
                {applying && <ArrowPathIcon className="w-4 h-4 animate-spin" />}
                {applying
                  ? 'Applying to every site...'
                  : `Apply to all ${targets.length} dataset${
                      targets.length === 1 ? '' : 's'
                    }`}
              </button>
              <p className="text-xs text-gray-500">
                {Object.keys(overrides).length === 0
                  ? 'Using the published values.'
                  : `Changing ${Object.keys(overrides).join(', ')}.`}
              </p>
            </div>
          </>
        )}
      </div>

      {!agreement.agreed && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-amber-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-900">
              The sites did not all prepare their data the same way
            </p>
            <p className="text-xs text-amber-800 mt-1">
              Averaging weights from models trained on differently filtered data
              produces no error and a model that is quietly wrong. Apply the
              settings above to every site before training, or find out why one
              of them was prepared separately.
            </p>
            <p className="text-xs text-amber-800 mt-1">
              {agreement.groups
                .map(g => `${g.sites} site${g.sites === 1 ? '' : 's'} on ${g.fingerprint}`)
                .join(', ')}
              {agreement.pending
                ? `, and ${agreement.pending} still preparing or not yet reporting`
                : ''}
              .
            </p>
          </div>
        </div>
      )}

      {targets.map(target => {
        const status = statuses[keyOf(target)];
        // An Apply that timed out may still have been written: the RPC bounds
        // the wait, not the work. So the failure is dropped once the site has
        // reported something better, rather than overriding a live "done" with
        // a stale red badge forever.
        const applyFailure = applyErrors[keyOf(target)];
        const failure =
          status?.state === 'done' || status?.state === 'pending'
            ? undefined
            : applyFailure;
        const cannotReach = unreachable[keyOf(target)];
        const totals = status?.totals || {};
        const distributions = status?.distributions || {};
        // The first PREPARED store, not the first store. `stores` is the raw
        // zarr list in directory order and an unprepared one carries no
        // params, so reading index 0 blindly loses the applied thresholds, and
        // with them every threshold marker, for a dataset that is otherwise
        // fully prepared.
        const applied = (status?.stores || []).reduce<
          Record<string, number> | undefined
        >(
          (found, store) =>
            found || (store?.preprocessing?.params as Record<string, number>),
          undefined
        );

        return (
          <div
            key={keyOf(target)}
            className="bg-white rounded-2xl border border-gray-200 p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  {target.datasetId}
                </p>
                <p className="text-xs text-gray-500">
                  {target.siteLabel}
                  {status?.n_files
                    ? ` · ${status.n_files} file${status.n_files === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
              <StateBadge state={failure ? 'error' : status?.state} />
            </div>

            {cannotReach && !failure && (
              <p className="text-xs text-amber-800 mt-2 bg-amber-50 rounded-lg p-2">
                This site did not answer, so anything shown below may be out of
                date: {cannotReach}
              </p>
            )}
            {failure && (
              <p className="text-xs text-red-700 mt-2 bg-red-50 rounded-lg p-2">
                {failure}
              </p>
            )}
            {status?.error && (
              <p className="text-xs text-red-700 mt-2 bg-red-50 rounded-lg p-2">
                {status.error}
              </p>
            )}
            {status?.state === 'done' && status?.complete === false && (
              <p className="text-xs text-amber-800 mt-2 bg-amber-50 rounded-lg p-2">
                Some steps did not finish on this site, so the numbers below
                cover only part of the dataset.
              </p>
            )}
            {status?.partial_errors?.map(problem => (
              <p
                key={problem}
                className="text-xs text-amber-800 mt-2 bg-amber-50 rounded-lg p-2"
              >
                One file of this dataset could not be prepared: {problem}
              </p>
            ))}
            {status?.reasons?.map(reason => (
              <p
                key={reason}
                className="text-xs text-amber-800 mt-2 bg-amber-50 rounded-lg p-2"
              >
                {reason}
              </p>
            ))}

            {status?.state === 'done' && (
              <>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat
                    label="Cells kept"
                    value={
                      keptFraction(totals.n_cells_kept, totals.n_cells_total) ||
                      (totals.n_samples ? totals.n_samples.toLocaleString() : '-')
                    }
                    detail={
                      totals.n_cells_total
                        ? `${(totals.n_cells_kept || 0).toLocaleString()} of ${totals.n_cells_total.toLocaleString()}`
                        : undefined
                    }
                  />
                  <Stat
                    label="Genes kept"
                    value={
                      keptFraction(totals.n_genes_kept, totals.n_genes_total) || '-'
                    }
                    detail={
                      totals.n_genes_total
                        ? `${(totals.n_genes_kept || 0).toLocaleString()} of ${totals.n_genes_total.toLocaleString()}`
                        : undefined
                    }
                  />
                  <Stat
                    label="Cells in this dataset"
                    value={(totals.n_samples || 0).toLocaleString()}
                  />
                  <Stat
                    label="Genes in the panel"
                    value={(totals.n_vars || 0).toLocaleString()}
                  />
                </div>

                {applied && Object.keys(applied).length > 0 && (
                  <p className="text-[11px] text-gray-500 mt-2">
                    Applied:{' '}
                    {Object.entries(applied)
                      .map(([k, v]) => `${k} = ${Number(v).toLocaleString()}`)
                      .join(', ')}
                  </p>
                )}

                <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {CHARTS.map(chart => {
                    const dist = distributions[chart.key];
                    if (!dist) return null;
                    // The threshold is matched by SUFFIX, not by an exact
                    // name. Tabula calls its cell filter min_genes_per_cell
                    // and Geneformer calls the same thing
                    // geneformer_min_genes_per_cell, so a hardcoded lookup
                    // drew no marker at all for Geneformer's one adjustable
                    // parameter. Suffix matching means a model that adds a
                    // filter gets its marker without this file changing.
                    const name = Object.keys(applied || {}).find(
                      k => chart.param && k.endsWith(chart.param)
                    );
                    const threshold = name ? applied?.[name] : undefined;
                    return (
                      <DistributionChart
                        key={chart.key}
                        title={chart.title}
                        unit={chart.unit}
                        counts={dist.counts}
                        edges={dist.edges}
                        zero={dist.zero}
                        partial={dist.partial}
                        fromStore={dist.from_store}
                        ofFiles={dist.of_files}
                        threshold={threshold}
                        thresholdLabel={
                          threshold
                            ? chart.describe(Number(threshold))
                            : undefined
                        }
                        caption={chart.caption}
                      />
                    );
                  })}
                </div>

                {(onOpenVariability || onOpenUmap) && (
                  <div className="mt-3 flex gap-2">
                    {onOpenVariability && (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenVariability(target.managerId, target.datasetId)
                        }
                        className="px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-[transform,background-color] duration-150 ease-out active:scale-[0.97]"
                      >
                        Gene variability
                      </button>
                    )}
                    {onOpenUmap && (
                      <button
                        type="button"
                        onClick={() => onOpenUmap(target.managerId, target.datasetId)}
                        className="px-2.5 py-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-[transform,background-color] duration-150 ease-out active:scale-[0.97]"
                      >
                        Embedding
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; detail?: string }> = ({
  label,
  value,
  detail,
}) => (
  <div className="bg-gray-50 rounded-xl p-3">
    <p className="text-[11px] font-medium text-gray-500">{label}</p>
    <p className="text-sm font-semibold text-gray-900 mt-0.5">{value}</p>
    {detail && <p className="text-[10px] text-gray-400">{detail}</p>}
  </div>
);

const StateBadge: React.FC<{ state?: string }> = ({ state }) => {
  const styles: Record<string, string> = {
    done: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    pending: 'text-blue-700 bg-blue-50 border-blue-200',
    error: 'text-red-700 bg-red-50 border-red-200',
    unknown: 'text-gray-500 bg-gray-50 border-gray-200',
  };
  const labels: Record<string, string> = {
    done: 'Prepared',
    pending: 'Preparing',
    error: 'Failed',
    unknown: 'Not prepared',
  };
  const key = state && styles[state] ? state : 'unknown';
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-lg border ${styles[key]}`}
    >
      {key === 'done' && <CheckCircleIcon className="w-3.5 h-3.5" />}
      {key === 'pending' && <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />}
      {labels[key]}
    </span>
  );
};

export default PreprocessingStep;
