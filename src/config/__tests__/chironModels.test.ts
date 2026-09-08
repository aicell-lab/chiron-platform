import {
  CHIRON_MODELS,
  CHIRON_MODEL_FAMILIES,
  datasetIncompatibleReason,
  defaultMaxBatchSize,
} from '../chironModels';

/**
 * The var/ column lists below are what a live Chiron worker actually reported
 * for the three demo datasets through get_datasets_info, copied verbatim.
 * They are the reason this check exists: Skin Aging carries neither gene-panel
 * column, the other two carry both, and nothing in the UI could tell them
 * apart until a trainer had been deployed and had failed.
 */
const SKIN_AGING = [
  {
    name: 'filter_4.zarr',
    var_columns: [
      '_index', 'frac', 'gene_id', 'highly_variable', 'highly_variable_rank',
      'log_cv', 'log_m', 'means', 'nCells', 'nCounts', 'ntr',
      'pass_basic_filter', 'score', 'tabula_hvg_rank', 'tabula_hvg_score',
      'tabula_hvg_selected', 'use_for_dynamics', 'use_for_pca',
      'use_for_transition', 'variances', 'variances_norm',
    ],
  },
];

const THYMUS = [
  {
    name: 'filter_110.zarr',
    var_columns: [
      '_index', 'feature_id', 'feature_length', 'feature_name', 'gene_id',
      'highly_variable', 'highly_variable_rank', 'means', 'n_counts',
      'soma_joinid', 'tabula_hvg_rank', 'tabula_hvg_score',
      'tabula_hvg_selected', 'variances', 'variances_norm',
    ],
  },
];

describe('datasetIncompatibleReason', () => {
  test('Tabula reads any prepared dataset, including one with no gene names', () => {
    expect(datasetIncompatibleReason('tabula', SKIN_AGING)).toBeUndefined();
  });

  test('the three name-matching models cannot read a dataset without gene names', () => {
    for (const family of ['scgpt', 'geneformer', 'scfoundation']) {
      expect(datasetIncompatibleReason(family, SKIN_AGING)).toBeDefined();
    }
  });

  test('the reason names the column the model actually looks for', () => {
    expect(datasetIncompatibleReason('scgpt', SKIN_AGING)).toContain('var/feature_name');
    expect(datasetIncompatibleReason('geneformer', SKIN_AGING)).toContain('var/feature_id');
    expect(datasetIncompatibleReason('scfoundation', SKIN_AGING)).toContain('var/feature_name');
  });

  test('the reason names the identifier that column has to hold', () => {
    // Naming the column is not enough on its own. A store can carry
    // feature_id full of symbols, and the operator reading this needs to be
    // told what has to be in there, not only where it goes. Geneformer is
    // the reason the message stopped saying "by name": it never sees one.
    expect(datasetIncompatibleReason('geneformer', SKIN_AGING))
      .toContain('Ensembl gene ID');
    expect(datasetIncompatibleReason('geneformer', SKIN_AGING))
      .not.toContain('by name');
    expect(datasetIncompatibleReason('scgpt', SKIN_AGING))
      .toContain('HGNC gene symbol');
  });

  test('a dataset carrying both columns is readable by every model', () => {
    for (const family of ['tabula', 'scgpt', 'geneformer', 'scfoundation']) {
      expect(datasetIncompatibleReason(family, THYMUS)).toBeUndefined();
    }
  });

  test('one unreadable store in a dataset is enough, and the message names it', () => {
    const mixed = [...THYMUS, ...SKIN_AGING];
    const reason = datasetIncompatibleReason('scgpt', mixed);
    expect(reason).toContain('filter_4.zarr');
    expect(reason).not.toContain('filter_110.zarr');
  });

  // The three silent cases. Each one is a place where blocking would lock an
  // operator out of a dataset on no evidence, which is the same rule the
  // version floors follow: unknown is never treated as a failure.
  test('says nothing when the worker reported no zarr stores', () => {
    expect(datasetIncompatibleReason('scgpt', [])).toBeUndefined();
    expect(datasetIncompatibleReason('scgpt', undefined)).toBeUndefined();
  });

  test('says nothing when no store reports its columns, as on an older manager', () => {
    expect(
      datasetIncompatibleReason('scgpt', [{ name: 'filter_4.zarr' }])
    ).toBeUndefined();
  });

  test('says nothing for a model family this build does not know', () => {
    expect(datasetIncompatibleReason('some-future-model', SKIN_AGING)).toBeUndefined();
    expect(datasetIncompatibleReason(undefined, SKIN_AGING)).toBeUndefined();
  });

  test('judges a partially reporting worker on the stores it did report', () => {
    const partial = [{ name: 'unknown.zarr' }, ...SKIN_AGING];
    expect(datasetIncompatibleReason('scgpt', partial)).toContain('filter_4.zarr');
  });
});

describe('geneIdentifier', () => {
  test('every model that needs a var column says what belongs in it', () => {
    for (const family of CHIRON_MODEL_FAMILIES) {
      const model = CHIRON_MODELS[family];
      if (!model.requiredVarColumn) continue;
      expect(model.geneIdentifier).toBeTruthy();
    }
  });
});

describe('defaultMaxBatchSize', () => {
  test('every family in the registry declares one', () => {
    for (const family of CHIRON_MODEL_FAMILIES) {
      expect(CHIRON_MODELS[family].defaultMaxBatchSize).toBeGreaterThan(0);
    }
  });

  test('the default fits the largest batch the model was measured at', () => {
    // The point of the field. A default above what was measured to fit a
    // 24 GB card is an out-of-memory error handed to an operator who never
    // touched the setting, which is what a flat 32 was for Geneformer.
    for (const family of CHIRON_MODEL_FAMILIES) {
      const model = CHIRON_MODELS[family];
      const largest = Math.max(...model.referenceMemory.map(e => e.batchSize));
      expect(model.defaultMaxBatchSize).toBeLessThanOrEqual(largest);
    }
  });

  test('an unknown family gets the cautious default rather than Tabula-sized', () => {
    expect(defaultMaxBatchSize('some-future-model')).toBe(8);
    expect(defaultMaxBatchSize(undefined)).toBe(8);
  });

  test('Geneformer does not open at a batch size that will not fit', () => {
    expect(defaultMaxBatchSize('geneformer')).toBe(8);
    expect(defaultMaxBatchSize('tabula')).toBe(32);
  });
});
