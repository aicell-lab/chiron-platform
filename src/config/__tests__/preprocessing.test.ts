import {
  PreprocessingRecipe,
  PreprocessingStatus,
  adjustableParams,
  changedParams,
  defaultValues,
  federationAgreement,
  fixedParams,
  keptFraction,
  paramError,
  paramErrors,
  preprocessingTargets,
  submittedParams,
  summariseDataset,
  thresholdBin,
} from '../preprocessing';

const param = (over: Partial<PreprocessingRecipe['params'][0]> = {}) => ({
  name: 'min_cells_per_gene',
  default: 250,
  label: 'Minimum cells per gene',
  description: 'A gene detected in fewer cells than this is excluded.',
  unit: 'cells',
  minimum: 0,
  maximum: 1_000_000,
  integer: true,
  adjustable: true,
  ...over,
});

const recipe = (): PreprocessingRecipe => ({
  model_family: 'tabula',
  version: 1,
  label: 'Tabula',
  description: '',
  stages: [],
  params: [
    param(),
    param({ name: 'min_genes_per_cell', label: 'Minimum detected genes per cell' }),
    param({
      name: 'n_hvg',
      label: 'Genes the model reads',
      default: 1200,
      adjustable: false,
      description: "The model's input width.",
    }),
  ],
  defaults: { min_cells_per_gene: 250, min_genes_per_cell: 250, n_hvg: 1200 },
});

describe('which parameters the form may offer', () => {
  it('separates adjustable from fixed', () => {
    expect(adjustableParams(recipe()).map(p => p.name)).toEqual([
      'min_cells_per_gene',
      'min_genes_per_cell',
    ]);
    expect(fixedParams(recipe()).map(p => p.name)).toEqual(['n_hvg']);
  });

  it('says nothing when there is no recipe, rather than guessing', () => {
    expect(adjustableParams(undefined)).toEqual([]);
    expect(fixedParams(null)).toEqual([]);
    expect(defaultValues(undefined)).toEqual({});
  });

  it('seeds the form from the recipe, not from a local copy', () => {
    expect(defaultValues(recipe())).toEqual({
      min_cells_per_gene: 250,
      min_genes_per_cell: 250,
      n_hvg: 1200,
    });
  });
});

describe('validating what an operator types', () => {
  it('accepts a value inside the range', () => {
    expect(paramError(param(), 100)).toBeUndefined();
    expect(paramError(param(), '100')).toBeUndefined();
  });

  it.each([
    ['', 'needs a value'],
    [null, 'needs a value'],
    ['abc', 'must be a number'],
    ['12.5', 'must be a whole number'],
    [-1, 'cannot be below'],
    [2_000_000, 'cannot be above'],
  ])('rejects %p', (value, expected) => {
    expect(paramError(param(), value as any)).toContain(expected as string);
  });

  it('allows a fraction when the parameter is not an integer', () => {
    expect(paramError(param({ integer: false }), '12.5')).toBeUndefined();
  });

  it('reports every bad field at once, so one fix does not reveal the next', () => {
    const errors = paramErrors(recipe(), {
      min_cells_per_gene: -5,
      min_genes_per_cell: 'abc',
    });
    expect(Object.keys(errors).sort()).toEqual([
      'min_cells_per_gene',
      'min_genes_per_cell',
    ]);
  });

  it('never validates a fixed parameter, which the form cannot change', () => {
    expect(paramErrors(recipe(), { n_hvg: 999999999 } as any)).toEqual({
      min_cells_per_gene: expect.any(String),
      min_genes_per_cell: expect.any(String),
    });
  });
});

describe('what gets sent', () => {
  it('sends only what the operator actually changed', () => {
    expect(
      changedParams(recipe(), {
        min_cells_per_gene: 100,
        min_genes_per_cell: 250,
        n_hvg: 1200,
      })
    ).toEqual({ min_cells_per_gene: 100 });
  });

  it('sends nothing when nothing moved', () => {
    expect(changedParams(recipe(), defaultValues(recipe()))).toEqual({});
  });

  it('never sends a fixed parameter, even if something put one in the form', () => {
    expect(changedParams(recipe(), { n_hvg: 900 } as any)).toEqual({});
  });

  it('treats a string the same as the number it spells', () => {
    expect(changedParams(recipe(), { min_cells_per_gene: '100' })).toEqual({
      min_cells_per_gene: 100,
    });
  });
});

describe('what is actually submitted', () => {
  it('sends every adjustable value, including the untouched ones', () => {
    // The opposite of what it looks like it should do, and deliberate. The
    // schema is fetched from ONE site, so omitting a default lets a site
    // running an older server fall back to a different one, and the two sites
    // prepare differently while the form shows one number. That is the exact
    // divergence this step exists to prevent.
    expect(
      submittedParams(recipe(), {
        min_cells_per_gene: 100,
        min_genes_per_cell: 250,
      })
    ).toEqual({ min_cells_per_gene: 100, min_genes_per_cell: 250 });
  });

  it('fills a blank field from the recipe default rather than omitting it', () => {
    expect(submittedParams(recipe(), { min_cells_per_gene: '' })).toEqual({
      min_cells_per_gene: 250,
      min_genes_per_cell: 250,
    });
  });

  it('never submits a fixed parameter', () => {
    expect(submittedParams(recipe(), { n_hvg: 900 } as any)).not.toHaveProperty(
      'n_hvg'
    );
  });
});

describe('what applying has to touch', () => {
  const familyFor = (id: string) =>
    ({ 'site-a': 'tabula', 'site-b': 'geneformer' } as Record<string, string>)[id];

  it('is one entry per site and dataset', () => {
    const targets = preprocessingTargets(
      [
        { managerId: 'site-a', datasets: { blood: {}, lung: {} }, siteLabel: 'Boston' },
        { managerId: 'site-b', datasets: { blood: {} }, siteLabel: 'Stockholm' },
      ],
      familyFor
    );
    expect(targets).toHaveLength(3);
    expect(targets[0]).toMatchObject({
      managerId: 'site-a',
      datasetId: 'blood',
      modelFamily: 'tabula',
      siteLabel: 'Boston',
    });
    expect(targets[2].modelFamily).toBe('geneformer');
  });

  it('collapses two trainers on one site reading the same dataset', () => {
    const targets = preprocessingTargets(
      [
        { managerId: 'site-a', datasets: { blood: {} } },
        { managerId: 'site-a', datasets: { blood: {} } },
      ],
      familyFor
    );
    expect(targets).toHaveLength(1);
  });

  it('skips a site whose model is unknown rather than guessing one', () => {
    expect(
      preprocessingTargets([{ managerId: 'mystery', datasets: { blood: {} } }], familyFor)
    ).toEqual([]);
  });

  it('skips a site with no datasets', () => {
    expect(preprocessingTargets([{ managerId: 'site-a' }], familyFor)).toEqual([]);
  });
});

describe('whether the federation agrees', () => {
  const status = (over: Partial<PreprocessingStatus>): PreprocessingStatus => ({
    dataset_id: 'blood',
    model_family: 'tabula',
    state: 'done',
    ...over,
  });

  it('says how the federation is split, not only that it is', () => {
    // The banner has to name the split. "The sites disagree" with no numbers
    // leaves the organiser reading per-card badges to work out which way.
    const result = federationAgreement([
      status({ fingerprint: 'abc' }),
      status({ fingerprint: 'abc' }),
      status({ fingerprint: 'xyz' }),
      status({ state: 'pending' }),
    ]);
    expect(result.agreed).toBe(false);
    expect(result.groups).toEqual([
      { fingerprint: 'abc', sites: 2 },
      { fingerprint: 'xyz', sites: 1 },
    ]);
    expect(result.pending).toBe(1);
  });

  it('agrees when every site reports the same fingerprint', () => {
    const result = federationAgreement([
      status({ fingerprint: 'abc' }),
      status({ fingerprint: 'abc' }),
    ]);
    expect(result.agreed).toBe(true);
    expect(result.fingerprints).toEqual(['abc']);
  });

  it('disagrees when two sites prepared differently', () => {
    const result = federationAgreement([
      status({ fingerprint: 'abc' }),
      status({ fingerprint: 'xyz' }),
    ]);
    expect(result.agreed).toBe(false);
    expect(result.fingerprints).toEqual(['abc', 'xyz']);
  });

  it('counts a site that has not reported as pending, not as disagreeing', () => {
    const result = federationAgreement([
      status({ fingerprint: 'abc' }),
      status({ state: 'pending' }),
      undefined,
    ]);
    expect(result.agreed).toBe(true);
    expect(result.pending).toBe(2);
  });

  it('surfaces a single site whose own stores disagree with each other', () => {
    const result = federationAgreement([
      status({ fingerprint: null, fingerprints_disagree: ['abc', 'xyz'] }),
    ]);
    expect(result.agreed).toBe(false);
    expect(result.fingerprints).toEqual(['abc', 'xyz']);
  });
});

describe('folding a dataset into one row', () => {
  const files = [
    { name: 'a.zarr', n_samples: 1000, n_vars: 20000, hvg_histogram_counts: [1, 2] },
    { name: 'b.zarr', n_samples: 2500, n_vars: 20000, umap_version: 4 },
  ];

  it('sums cells and does not sum genes', () => {
    const summary = summariseDataset(files);
    expect(summary.nFiles).toBe(2);
    expect(summary.nSamples).toBe(3500);
    // Five stores of 20,000 genes is a 20,000-gene dataset.
    expect(summary.nVars).toBe(20000);
  });

  it('keeps the per-file counts', () => {
    expect(summariseDataset(files).files).toEqual([
      { name: 'a.zarr', n_samples: 1000, n_vars: 20000 },
      { name: 'b.zarr', n_samples: 2500, n_vars: 20000 },
    ]);
  });

  it('opens the dataset-card dialogs against the largest store', () => {
    expect(summariseDataset(files).representative?.name).toBe('b.zarr');
  });

  it('offers a view when any store has one', () => {
    const summary = summariseDataset(files);
    expect(summary.hasVariability).toBe(true);
    expect(summary.hasUmap).toBe(true);
  });

  it('offers nothing for a dataset with no prepared stores', () => {
    const summary = summariseDataset([{ name: 'a.zarr', n_samples: 10 }]);
    expect(summary.hasVariability).toBe(false);
    expect(summary.hasUmap).toBe(false);
  });

  it('survives a dataset the worker reported nothing about', () => {
    expect(summariseDataset(undefined)).toMatchObject({ nFiles: 0, nSamples: 0, nVars: 0 });
  });
});

describe('where a threshold cuts a distribution', () => {
  const edges = [1, 10, 100, 1000];

  it('finds the bin a threshold falls in', () => {
    expect(thresholdBin(edges, 1)).toBe(0);
    expect(thresholdBin(edges, 50)).toBe(1);
    expect(thresholdBin(edges, 999)).toBe(2);
  });

  it('marks nothing when the threshold is off the grid', () => {
    // A marker pinned to the edge would read as "it cuts here" when it cuts
    // nowhere, which is worse than no marker.
    expect(thresholdBin(edges, 0)).toBeUndefined();
    expect(thresholdBin(edges, 5000)).toBeUndefined();
  });

  it('marks nothing without a grid or a threshold', () => {
    expect(thresholdBin(undefined, 50)).toBeUndefined();
    expect(thresholdBin(edges, undefined)).toBeUndefined();
    expect(thresholdBin(edges, NaN)).toBeUndefined();
  });

  it('refuses a grid too short to describe a bin', () => {
    // Two edges is the minimum. One used to fall through to `length - 2`,
    // which is -1, and a negative index slices the chart from its end.
    expect(thresholdBin([5], 5)).toBeUndefined();
    expect(thresholdBin([], 5)).toBeUndefined();
  });
});

describe('kept fractions', () => {
  it('reads as a percentage', () => {
    expect(keptFraction(1357, 1500)).toBe('90.5%');
  });

  it('says nothing rather than dividing by zero', () => {
    expect(keptFraction(0, 0)).toBeUndefined();
    expect(keptFraction(undefined, 100)).toBeUndefined();
  });
});
