# Demo screenshots

One directory per model, written by the Playwright demo driver as it walks the
training flow: worker list, orchestrator launch, trainer launch, registration,
training config, training run, checkpoint save.

Files are numbered per run, not per stage, so a run that hits a retry produces a
different numbering than a clean one. Read the log alongside them.

Override the destination with `CHIRON_SHOTS`.
