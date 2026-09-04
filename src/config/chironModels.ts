/**
 * The models Chiron can federate, and the facts the UI needs about them before
 * any worker exists.
 *
 * A worker runs one model, decided by the container image it was started on.
 * The image declares that identity in environment variables which the manager
 * reports back as `worker_info.chiron_image` (see docker/README.md in the
 * tabula repo, "The image identity contract"). That reported value is the live
 * truth and always wins.
 *
 * This registry only covers what the UI has to show *before* it can ask a
 * worker: which image the setup wizard should suggest for each model, the
 * display name to put on a badge, and reference GPU memory for the launch
 * dialog. Adding a fifth model means adding an entry here plus its image and
 * trainer artifact. Nothing else in the frontend changes.
 */

import { CURRENT_IMAGE_VERSION } from './chironVersions';

export type ChironModelFamily =
  | 'tabula'
  | 'scgpt'
  | 'geneformer'
  | 'scfoundation';

export interface ChironModel {
  /** Slug shared by the image's CHIRON_MODEL_FAMILY, the trainer manifest's
   *  `model_family`, and the adapter's `model_family` ClassVar. */
  family: ChironModelFamily;
  displayName: string;
  /** One-line description, shown next to the model in the setup wizard. */
  summary: string;
  /** Whether the platform supports training this model today. A `coming-soon`
   *  model is still listed everywhere, because hiding it would make the
   *  roadmap invisible, but the setup wizard will not start a worker on it.
   *  Mirrors `chiron.status` on the model's card in
   *  `chiron-platform/chiron-architectures`, and the two are changed together
   *  when a model becomes available. */
  status: 'available' | 'coming-soon';
  /** Image repository, without a tag. The version comes from
   *  `src/config/chironVersions.ts`, so an image reference is always a
   *  repository this file knows plus a version that file offers. */
  imageRepository: string;
  /** Image the setup wizard suggests at the current version. A running worker
   *  reports its own. */
  image: string;
  /** Trainer this model's image hosts. Shown as wizard copy only, the value
   *  actually deployed comes from the worker's CHIRON_TRAINER_ARTIFACT. */
  trainerArtifactId: string;
  /** Readable phrase for the subset FedAvg averages, for the Save Weights
   *  cards. The orchestrator reports the authoritative prefix list as
   *  `shared_weight_scope` ("token_emb.+pos_emb.+encoder."), which is exact
   *  but is not something to put on a card. This is the same set in prose,
   *  and the raw label stays the fallback for a family this build of the UI
   *  does not know. */
  sharedWeights: string;
  /** Readable phrase for what FedAvg never touches, and which therefore
   *  exists only in a trainer's own full export. Every model has one: none of
   *  them federates its whole state_dict, so a global artifact is never a
   *  substitute for a local one. */
  localWeights: string;
  /** Alias of the published foundation checkpoint to surface first in the
   *  checkpoint picker, if one exists for this model yet. */
  foundationAlias?: string;
  /** Column under `var/` this model needs in order to find its gene panel in
   *  a prepared dataset. Three of the four models match genes by name, and
   *  they disagree on which name: HGNC symbols in `feature_name` for scGPT
   *  and scFoundation, Ensembl ids in `feature_id` for Geneformer. Tabula
   *  reads the binned layer positionally and needs neither, so it leaves this
   *  undefined, which reads as "any prepared dataset will do".
   *
   *  The platform compares this against the `var_columns` a worker reports
   *  per zarr store, so it can say before a deploy that a dataset and a model
   *  do not fit. Without it the mismatch only surfaces inside the trainer,
   *  minutes after the operator picked the dataset. */
  requiredVarColumn?: string;
  /** Measured GPU memory at a given batch size, above the trainer's idle
   *  baseline. Reference for the launch dialog's max-batch-size field. */
  referenceMemory: { batchSize: number; gb: number }[];
  /** Tailwind classes for the model's badge. One hue per model, so a glance
   *  at a badge is enough to tell two workers apart without reading the
   *  label. Kept next to the display name so a new model gets its colour in
   *  the same edit that gives it a name. */
  badgeClass: string;
  /** Host RAM in GB the setup guide puts in `--head-memory-in-gb` for a
   *  worker on this model's image. See WORKER_RAM_GB for how it is derived. */
  workerMemoryGb: number;
  /** Cover image under public/assets/. Undefined where none exists yet. */
  coverUrl?: string;
}

/** Repository for a model's image, without a tag. */
export const imageRepository = (family: string) =>
  `ghcr.io/aicell-lab/chiron-${family}`;

/**
 * Full image reference at a given version. The version list and the minimum
 * supported version live in `chironVersions.ts`, which is the single file a
 * release edits.
 */
export const imageRef = (family: string, version: string) =>
  `${imageRepository(family)}:${version}`;

const image = (family: string) => imageRef(family, CURRENT_IMAGE_VERSION);

/**
 * Host RAM a worker needs, per model.
 *
 * Ray admits an application only when its declared `memory` still fits in the
 * head node's budget, so `--head-memory-in-gb` is a hard gate on what a worker
 * can deploy, not a hint. The budget has to cover every app the worker hosts
 * at once:
 *
 *   chiron-manager       1 GiB   always running
 *   chiron-orchestrator  8 GiB   on the site that coordinates the round
 *   the trainer         16-32 GiB, declared per model in its `@bioengine.app`
 *
 * The trainer figure is the one that moves: 16 GiB for Tabula and scGPT, 24
 * for Geneformer, 32 for scFoundation. Summed with the other two and rounded
 * up for Ray's own overhead, that gives the numbers below. A worker set to
 * less than its model's figure comes up fine and then refuses the trainer with
 * "Insufficient resources", which is why this is a per-model default rather
 * than one number for all four.
 */
const WORKER_RAM_GB: Record<ChironModelFamily, number> = {
  tabula: 30,
  scgpt: 30,
  geneformer: 40,
  scfoundation: 48,
};

export const CHIRON_MODELS: Record<ChironModelFamily, ChironModel> = {
  tabula: {
    family: 'tabula',
    displayName: 'Tabula',
    summary:
      'Tabular transformer over genes, trained by masked value reconstruction. The model Chiron was built around.',
    status: 'available',
    imageRepository: imageRepository('tabula'),
    image: image('tabula'),
    trainerArtifactId: 'chiron-platform/tabula-trainer',
    workerMemoryGb: WORKER_RAM_GB.tabula,
    // Tabula is the one model whose local part is input-side: the feature
    // tokenizer and the reconstruction head are both sized by the gene
    // panel, which is what makes a Tabula checkpoint dataset-specific.
    sharedWeights: 'transformer trunk',
    localWeights: 'tissue-specific embedder, batch norm and heads',
    foundationAlias: 'tabula-foundation',
    // No requiredVarColumn. Tabula reads the binned layer by position, so it
    // trains on any store the data server has prepared, whatever var/ holds.

    // Measured on a 24 GB RTX 3090 with the demo blood dataset. Scaling is
    // super-linear, so the in-between sizes are not extrapolated.
    referenceMemory: [
      { batchSize: 8, gb: 2 },
      { batchSize: 16, gb: 6 },
      { batchSize: 32, gb: 20 },
    ],
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    coverUrl: '/assets/tabula.png',
  },
  scgpt: {
    family: 'scgpt',
    displayName: 'scGPT',
    summary:
      'Generative transformer over gene tokens and binned expression values, trained by masked value prediction.',
    status: 'coming-soon',
    imageRepository: imageRepository('scgpt'),
    image: image('scgpt'),
    trainerArtifactId: 'chiron-platform/scgpt-trainer',
    workerMemoryGb: WORKER_RAM_GB.scgpt,
    sharedWeights: 'gene embedding, value encoder and transformer',
    localWeights: 'expression decoder head',
    requiredVarColumn: 'feature_name',
    // Only the batch size validated on a 24 GB RTX 3090 so far. The memory
    // curve is not measured yet, so no other sizes are quoted.
    referenceMemory: [{ batchSize: 32, gb: 0 }],
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  geneformer: {
    family: 'geneformer',
    displayName: 'Geneformer',
    summary:
      'BERT over rank-value-encoded gene tokens, trained by masked language modelling.',
    status: 'coming-soon',
    imageRepository: imageRepository('geneformer'),
    image: image('geneformer'),
    trainerArtifactId: 'chiron-platform/geneformer-trainer',
    workerMemoryGb: WORKER_RAM_GB.geneformer,
    sharedWeights: 'token embedding and encoder stack',
    localWeights: 'masked-LM head',
    requiredVarColumn: 'feature_id',
    referenceMemory: [{ batchSize: 16, gb: 0 }],
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  scfoundation: {
    family: 'scfoundation',
    displayName: 'scFoundation',
    summary:
      "Read-depth-aware transformer over a cell's expressed genes, trained by masked value regression. Its checkpoint is fetched at runtime under each site's own licence grant.",
    status: 'coming-soon',
    imageRepository: imageRepository('scfoundation'),
    image: image('scfoundation'),
    trainerArtifactId: 'chiron-platform/scfoundation-trainer',
    workerMemoryGb: WORKER_RAM_GB.scfoundation,
    sharedWeights: 'value embedding, gene position embedding and encoder',
    localWeights: 'value-regression head',
    requiredVarColumn: 'feature_name',
    referenceMemory: [{ batchSize: 8, gb: 0 }],
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
  },
};

/** Registry order, for selectors and tables. Tabula first, it is the default. */
export const CHIRON_MODEL_FAMILIES: ChironModelFamily[] = [
  'tabula',
  'scgpt',
  'geneformer',
  'scfoundation',
];

export const DEFAULT_MODEL_FAMILY: ChironModelFamily = 'tabula';

/**
 * What a worker reports about the image it is running, or undefined on an
 * image built before per-model support existed.
 */
export interface ChironImageIdentity {
  model_family: string;
  model_name: string;
  trainer_artifact: string;
  image_ref: string;
}

/**
 * Look up a family reported by a worker. Returns undefined for a family this
 * build of the UI does not know, which is what a worker running a newer image
 * than the frontend looks like. Callers fall back to the worker's own reported
 * strings in that case rather than showing nothing.
 */
export const getChironModel = (
  family: string | undefined | null
): ChironModel | undefined =>
  family ? CHIRON_MODELS[family as ChironModelFamily] : undefined;

/**
 * Display name for a worker's model: the registry's name when the family is
 * known, otherwise whatever the image itself said.
 */
export const modelDisplayName = (
  identity: ChironImageIdentity | undefined | null
): string | undefined => {
  if (!identity) return undefined;
  return (
    getChironModel(identity.model_family)?.displayName ||
    identity.model_name ||
    identity.model_family
  );
};

/**
 * Badge colours for a worker's model. A family this build does not know gets
 * a neutral grey rather than borrowing another model's hue, so an unfamiliar
 * badge reads as "unrecognised" instead of as the wrong model.
 */
export const modelBadgeClass = (
  family: string | undefined | null
): string =>
  getChironModel(family)?.badgeClass ||
  'bg-gray-100 text-gray-600 border-gray-200';

/**
 * Reference memory line for the launch dialog, e.g. "8 ≈ 2 GB · 16 ≈ 6 GB".
 * Entries with an unmeasured figure (gb <= 0) are rendered as a validated
 * batch size without a memory claim.
 */
export const referenceMemoryEntries = (
  family: string | undefined | null
): { batchSize: number; gb: number }[] =>
  getChironModel(family)?.referenceMemory || [];

/**
 * Prose description of what FedAvg averages for a model, for the Save Weights
 * cards. Falls back to the orchestrator's raw `shared_weight_scope` label when
 * the family is one this build does not know, so a worker on a newer image
 * still says something truthful rather than nothing at all.
 */
export const sharedWeightsLabel = (
  family: string | undefined | null,
  rawScope?: string | null
): string | undefined =>
  getChironModel(family)?.sharedWeights || rawScope || undefined;

/**
 * Prose description of the part that stays on the worker and therefore only
 * exists in that trainer's own full export. Undefined for an unknown family,
 * where the UI has nothing truthful to say and so says nothing.
 */
export const localWeightsLabel = (
  family: string | undefined | null
): string | undefined => getChironModel(family)?.localWeights;

/**
 * One zarr store as a worker reports it, reduced to the fields this file
 * reasons about. The manager sends more (cell and gene counts, HVG and binning
 * versions), and the rest of the UI reads those from the same objects.
 */
export interface ZarrStoreInfo {
  name?: string;
  /** Column names present under `var/`. Absent on a manager older than
   *  0.2.14, which is the case this helper treats as "unknown". */
  var_columns?: string[];
}

/**
 * Why the selected model cannot train on a dataset, or undefined when it can,
 * or when there is not enough information to say.
 *
 * A dataset is a directory of zarr stores and a trainer reads all of them, so
 * one store without the model's gene-panel column is enough to fail the run.
 * The failure happens inside the trainer, roughly two minutes after the
 * operator picked the dataset and pressed the button, which is far too late to
 * be useful. This is the same fact, stated while the dataset is still being
 * chosen.
 *
 * Silent in three cases, all deliberate, and all following the rule
 * `chironVersions.ts` sets for version floors: unknown is never treated as
 * incompatible.
 *
 *   - The model needs no named column (Tabula).
 *   - The worker sent no `zarr_files` at all, so nothing is known about the
 *     dataset's contents.
 *   - No store reports `var_columns`, which is what a manager below 0.2.14
 *     looks like. Blocking there would lock an operator out of a dataset the
 *     trainer can read perfectly well, on no evidence.
 *
 * A worker that reports some stores with the column list and some without is
 * judged on the ones it did report. That is the shape a partially readable
 * data directory takes, and the stores it could read are the honest evidence.
 */
export const datasetIncompatibleReason = (
  family: string | undefined | null,
  zarrFiles: ZarrStoreInfo[] | undefined | null
): string | undefined => {
  const model = getChironModel(family);
  const column = model?.requiredVarColumn;
  if (!model || !column) return undefined;
  if (!Array.isArray(zarrFiles) || zarrFiles.length === 0) return undefined;

  const known = zarrFiles.filter(f => Array.isArray(f?.var_columns));
  if (known.length === 0) return undefined;

  const missing = known.filter(f => !f.var_columns!.includes(column));
  if (missing.length === 0) return undefined;

  // "This dataset" only when every store in it was reported and every one is
  // missing the column. A store that reported nothing might well carry it, and
  // a blanket claim about the dataset would be a guess presented as a fact.
  const where =
    missing.length === zarrFiles.length
      ? 'this dataset does not carry it'
      : `${missing.map(f => f.name || 'one store').join(', ')} ${
          missing.length === 1 ? 'does' : 'do'
        } not carry it`;
  return (
    `${model.displayName} matches genes by name and reads them from ` +
    `var/${column}, and ${where}. Prepare the dataset with that column, or ` +
    `train it with a model that does not need one.`
  );
};
