/**
 * Preprocessing: the shapes the data server publishes, and the arithmetic the
 * Prepare-data step does with them.
 *
 * The schema is NOT defined here. It is published by each site's data server
 * and read through the manager, because the two are versioned and deployed
 * separately: a copy in the frontend would eventually offer fields the server
 * rejects, and it would reject them after the organiser had already applied to
 * every site in the federation. What lives here are the types that describe
 * what arrives, and the pure functions that turn it into something to render.
 *
 * Everything in this file is deliberately free of React and of Hypha, so the
 * parts that decide what an operator is allowed to type, and what the numbers
 * mean once they come back, can be tested without either.
 */

/** One number a recipe exposes, as the data server describes it. */
export interface PreprocessingParam {
  name: string;
  default: number;
  label: string;
  description: string;
  unit?: string;
  minimum?: number | null;
  maximum?: number | null;
  integer?: boolean;
  /** False for a number that is a property of the pretrained checkpoint. The
   *  form shows it, greyed, because "why can I not change this" is a question
   *  worth answering in place rather than by its absence. */
  adjustable?: boolean;
}

export interface PreprocessingStage {
  name: string;
  version: number;
  label: string;
  description: string;
  requires: string[];
  outputs?: string[];
  params: PreprocessingParam[];
}

export interface PreprocessingRecipe {
  model_family: string;
  version: number;
  label: string;
  description: string;
  stages: PreprocessingStage[];
  params: PreprocessingParam[];
  defaults: Record<string, number>;
}

export interface PreprocessingSchema {
  available: boolean;
  recipes: Record<string, PreprocessingRecipe>;
  /** Why there is no form, when there is none. */
  reason?: string;
}

/** One merged histogram, as the manager sends it. */
export interface PreprocessingDistribution {
  counts: number[];
  edges: number[];
  zero?: number;
  /** Set when some of the dataset's files could not be merged in. */
  partial?: boolean;
  /** Set when the figure is one store's rather than the dataset's. The
   *  per-gene distribution cannot be summed across files without counting
   *  each gene once per file, so the manager sends one store's and names it,
   *  and the chart has to say so rather than label it with the dataset. */
  from_store?: string;
  of_files?: number;
}

/** One site's answer about one dataset, from `get_preprocessing_status`. */
export interface PreprocessingStatus {
  dataset_id: string;
  model_family: string;
  state: 'unknown' | 'pending' | 'done' | 'error';
  error?: string;
  /** Per-store failures on a dataset that otherwise reports done. */
  partial_errors?: string[];
  reasons?: string[];
  fingerprint?: string | null;
  fingerprints_disagree?: string[];
  complete?: boolean;
  n_files?: number;
  totals?: Record<string, number>;
  distributions?: Record<string, PreprocessingDistribution>;
  stores?: Array<{ name?: string; n_samples?: number; n_vars?: number; preprocessing?: any }>;
}

/** One thing the Apply button has to do: one dataset, on one site. */
export interface PreprocessingTarget {
  managerId: string;
  datasetId: string;
  modelFamily: string;
  /** For display. A site is a worker, and an operator thinks in places. */
  siteLabel: string;
}

/** The parameters an operator may actually change. */
export const adjustableParams = (
  recipe: PreprocessingRecipe | undefined | null
): PreprocessingParam[] =>
  (recipe?.params || []).filter(p => p.adjustable !== false);

/** The parameters the checkpoint fixes, shown but not editable. */
export const fixedParams = (
  recipe: PreprocessingRecipe | undefined | null
): PreprocessingParam[] =>
  (recipe?.params || []).filter(p => p.adjustable === false);

/**
 * Why a typed value is not acceptable for this parameter, or undefined.
 *
 * Checked here as well as at the manager and at the data server. That is three
 * places, and it is not redundant: this one is the only one that can answer
 * before the organiser presses a button that fans out to every site.
 */
export const paramError = (
  param: PreprocessingParam,
  raw: string | number | undefined | null
): string | undefined => {
  if (raw === '' || raw === null || raw === undefined) {
    return `${param.label} needs a value`;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return `${param.label} must be a number`;
  }
  if (param.integer !== false && !Number.isInteger(value)) {
    return `${param.label} must be a whole number`;
  }
  if (param.minimum !== null && param.minimum !== undefined && value < param.minimum) {
    return `${param.label} cannot be below ${param.minimum.toLocaleString()}`;
  }
  if (param.maximum !== null && param.maximum !== undefined && value > param.maximum) {
    return `${param.label} cannot be above ${param.maximum.toLocaleString()}`;
  }
  return undefined;
};

/** Every invalid field of a form, keyed by parameter name. */
export const paramErrors = (
  recipe: PreprocessingRecipe | undefined | null,
  values: Record<string, string | number>
): Record<string, string> => {
  const errors: Record<string, string> = {};
  for (const param of adjustableParams(recipe)) {
    const message = paramError(param, values[param.name]);
    if (message) errors[param.name] = message;
  }
  return errors;
};

/**
 * Every adjustable value the form holds, as numbers, including the untouched
 * ones.
 *
 * Sending the defaults rather than omitting them, which is the opposite of
 * what it looks like it should do.
 *
 * Omitting them would let each site fall back to its own default, and that is
 * right for a single site and wrong for a federation. The schema is fetched
 * from ONE site, so if that site defaults the gene filter to 250 and another
 * runs an older server that defaults it to 200, leaving the field untouched
 * prepares the two sites differently while the form shows one number. That is
 * precisely the divergence this step exists to prevent, and the fingerprint
 * check would only catch it after every site had finished.
 *
 * So the form sends what it shows. What the organiser sees is what every site
 * gets.
 */
export const submittedParams = (
  recipe: PreprocessingRecipe | undefined | null,
  values: Record<string, string | number>
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const param of adjustableParams(recipe)) {
    const raw = values[param.name];
    const value = raw === '' || raw === null || raw === undefined
      ? param.default
      : Number(raw);
    if (Number.isFinite(value)) out[param.name] = value;
  }
  return out;
};

/** Just the values the operator moved, for the "Changing x, y" summary. */
export const changedParams = (
  recipe: PreprocessingRecipe | undefined | null,
  values: Record<string, string | number>
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(submittedParams(recipe, values))) {
    const param = (recipe?.params || []).find(p => p.name === name);
    if (param && value !== param.default) out[name] = value;
  }
  return out;
};

/** Every parameter at its default, as the form's initial state. */
export const defaultValues = (
  recipe: PreprocessingRecipe | undefined | null
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const param of recipe?.params || []) out[param.name] = param.default;
  return out;
};

/**
 * What applying preprocessing has to touch, given the sites joining this run.
 *
 * One entry per site and dataset. A site with three datasets in the run is
 * three entries, because the data server prepares a dataset at a time, and a
 * site training on two datasets has to have both prepared before it can start.
 *
 * Duplicates are collapsed. Two trainers on one site reading the same dataset
 * is one preparation, and sending it twice would have the second request look
 * like a change and recompute nothing while still costing a round trip.
 */
export const preprocessingTargets = (
  participants: Array<{
    managerId: string;
    datasets?: Record<string, any> | null;
    siteLabel?: string;
  }>,
  familyFor: (managerId: string) => string | undefined
): PreprocessingTarget[] => {
  const seen = new Set<string>();
  const targets: PreprocessingTarget[] = [];
  for (const participant of participants) {
    const modelFamily = familyFor(participant.managerId);
    if (!modelFamily) continue;
    for (const datasetId of Object.keys(participant.datasets || {})) {
      const key = `${participant.managerId}::${datasetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        managerId: participant.managerId,
        datasetId,
        modelFamily,
        siteLabel: participant.siteLabel || participant.managerId,
      });
    }
  }
  return targets;
};

/**
 * Whether every site in a federation prepared its data the same way.
 *
 * The Prepare step applies one parameter set to every selected site, so this
 * should hold by construction. It is checked anyway, because the construction
 * only covers data prepared through this page: a site that was prepared out of
 * band, or that is still running an older request, disagrees silently, and
 * averaging models trained on differently filtered data produces no error
 * anywhere.
 *
 * A site that has not reported yet is not a disagreement. Unknown is never
 * treated as a failure, which is the rule the version floors already follow.
 */
export const federationAgreement = (
  statuses: Array<PreprocessingStatus | undefined | null>
): {
  agreed: boolean;
  fingerprints: string[];
  pending: number;
  /** How many sites reported each fingerprint, so the banner can say which
   *  way the federation is split rather than only that it is. */
  groups: Array<{ fingerprint: string; sites: number }>;
} => {
  const fingerprints = new Set<string>();
  const counts = new Map<string, number>();
  const seen = (f: string) => counts.set(f, (counts.get(f) || 0) + 1);
  let pending = 0;
  for (const status of statuses) {
    if (!status || status.state === 'unknown' || status.state === 'pending') {
      pending += 1;
      continue;
    }
    if (status.fingerprints_disagree?.length) {
      status.fingerprints_disagree.forEach(f => {
        fingerprints.add(f);
        seen(f);
      });
      continue;
    }
    if (status.fingerprint) {
      fingerprints.add(status.fingerprint);
      seen(status.fingerprint);
    }
  }
  return {
    agreed: fingerprints.size <= 1,
    fingerprints: Array.from(fingerprints).sort(),
    pending,
    groups: Array.from(counts.entries())
      .map(([fingerprint, sites]) => ({ fingerprint, sites }))
      .sort((a, b) => b.sites - a.sites || a.fingerprint.localeCompare(b.fingerprint)),
  };
};

/**
 * One dataset's stores folded into the single row the worker dialog shows.
 *
 * The dialog used to show a row per file, which made an operator add up the
 * numbers the platform already knows how to add, and repeated the variability
 * and embedding buttons once per file for a dataset the trainer reads as one
 * thing. Per-file cell and gene counts are kept, because a dataset being five
 * files of very different sizes is the kind of thing that explains a result
 * later.
 *
 * Genes are not summed. Five stores of 20,000 genes is a 20,000-gene dataset,
 * not a 100,000-gene one.
 */
export interface DatasetSummary {
  nFiles: number;
  nSamples: number;
  nVars: number;
  files: Array<{ name: string; n_samples?: number; n_vars?: number }>;
  /** The store the dataset-card dialogs open against: the largest, because a
   *  distribution drawn from the biggest file is the most representative one
   *  available without merging arrays the manager would have to fetch. */
  representative?: { name: string; n_samples?: number; n_vars?: number };
  hasVariability: boolean;
  hasUmap: boolean;
}

export const summariseDataset = (
  zarrFiles: Array<any> | undefined | null
): DatasetSummary => {
  const files = (zarrFiles || []).map(f => ({
    name: String(f?.name ?? ''),
    n_samples: typeof f?.n_samples === 'number' ? f.n_samples : undefined,
    n_vars: typeof f?.n_vars === 'number' ? f.n_vars : undefined,
  }));
  const nSamples = files.reduce((sum, f) => sum + (f.n_samples || 0), 0);
  const nVars = files.reduce((max, f) => Math.max(max, f.n_vars || 0), 0);

  let representative: DatasetSummary['representative'];
  let best = -1;
  (zarrFiles || []).forEach((f, i) => {
    const size = typeof f?.n_samples === 'number' ? f.n_samples : 0;
    if (size > best) {
      best = size;
      representative = files[i];
    }
  });

  return {
    nFiles: files.length,
    nSamples,
    nVars,
    files,
    representative,
    hasVariability: (zarrFiles || []).some(
      f => Array.isArray(f?.hvg_histogram_counts) && f.hvg_histogram_counts.length > 0
    ),
    hasUmap: (zarrFiles || []).some(f => !!f?.umap_version),
  };
};

/**
 * A distribution as a chart can draw it, with the threshold's position in it.
 *
 * The counts are already aggregate: one number per bin, never a number per
 * cell. The threshold's index is computed here rather than in the component so
 * that "where does my filter cut" is one testable function, and so that a
 * threshold outside the grid produces no marker rather than a marker at the
 * edge, which would read as "it cuts here" when it cuts nowhere.
 */
export const thresholdBin = (
  edges: number[] | undefined | null,
  threshold: number | undefined | null
): number | undefined => {
  // Two edges is the minimum that describes a bin. A shorter array cannot,
  // and the loop below would fall through to `edges.length - 2`, which is -1
  // and silently slices from the end of the chart.
  if (!edges || edges.length < 2) return undefined;
  if (threshold === undefined || threshold === null) return undefined;
  if (!Number.isFinite(threshold) || threshold <= 0) return undefined;
  if (threshold < edges[0] || threshold > edges[edges.length - 1]) return undefined;
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (threshold >= edges[i] && threshold < edges[i + 1]) return i;
  }
  return edges.length - 2;
};

/** `kept` of `total` as a percentage string, or undefined when unknown. */
export const keptFraction = (
  kept: number | undefined | null,
  total: number | undefined | null
): string | undefined => {
  if (typeof kept !== 'number' || typeof total !== 'number' || total <= 0) {
    return undefined;
  }
  return `${((kept / total) * 100).toFixed(1)}%`;
};
