# Federation tests

Everything the platform promises about federated training is a promise about more than one
site: that the same model reaches all of them, that their updates are combined by sample
share, that a slow or broken site does not take the round down with it. None of that can be
checked with a single trainer, and standing up a second real one needs a second GPU, because
a Chiron trainer claims a whole GPU by design.

These tests get around that with mock trainers. `mock_trainer.py` registers Hypha services
that speak the real trainer API and return fixed answers, so an arbitrary number of sites fit
on one machine and the expected aggregate is a closed-form weighted mean rather than something
that has to be measured. Two of the tests put a real trainer in the federation alongside the
mocks, which is what proves the mocks are speaking the same protocol as the real thing.

## Running them

Every test needs `HYPHA_TOKEN` set to a chiron-platform workspace admin token, and a **live
orchestrator with no trainers registered**, so the sites the test registers are the whole
federation. Each test leaves the orchestrator as it found it and deletes the run artifact it
produced, so they do not accumulate synthetic runs in the platform's run list.

```bash
export HYPHA_TOKEN=...        # chiron-platform workspace admin

# mocks only, no GPU needed
python tests/federation/test_fedavg_multisite.py      --orchestrator <app>
python tests/federation/test_partial_failure.py       --orchestrator <app>
python tests/federation/test_nan_containment.py       --orchestrator <app>

# these two also need a deployed, running trainer
python tests/federation/test_hybrid_real_and_mock.py  --orchestrator <app> --trainer <app>
python tests/federation/test_trainer_divergence_guard.py --orchestrator <app> --trainer <app>
```

`<app>` is the deployment name the manager gave the app, for example `little-salad-4379`, not
a full service id. Each script prints one line per check and exits non-zero if any fails.

## What each one covers

| Test | Sites | Covers |
|---|---|---|
| `test_fedavg_multisite.py` | 3 mock | Every site gets the same model, the aggregate is the sample-weighted mean and not the plain one, round 2 waits for the slowest site in round 1, and a per-trainer config override reaches exactly one site. |
| `test_partial_failure.py` | 3 mock | A site that fails, a site that is merely slow, and a site that ignores the cancel. In each case the round completes with the rest, and a counterfactual confirms the aggregate would have been different had the roster decision gone the other way. |
| `test_nan_containment.py` | 3 mock | A site returning non-finite weights is dropped from the aggregate, the history and the evaluate roster, rather than poisoning the round for the other two. Its 600 samples are the largest share of the three, because nothing about the containment should depend on how much data a site has. |
| `test_hybrid_real_and_mock.py` | 1 real + 2 mock | The real trainer and the mocks are in the same federation. The mocks return half the model they were sent, which makes the aggregate a straight line through the real site's contribution, so one projection recovers the real site's sample share and tells correct FedAvg apart from a dropped site, an unweighted mean, or ignored mocks. |
| `test_trainer_divergence_guard.py` | 1 real | The site half of the same problem. A broken global model is refused before it is applied, a round that diverges rolls the site back instead of keeping the result, and the site trains normally again afterwards. Only a real trainer holding a real model can show this, because what it protects is the site-local modules a broadcast never touches. |

The last two are the slow ones: each real fit is a couple of minutes even at
`limit_train_batches=2`.

## A caution about losses

Chiron's train and validation losses are means over randomly corrupted batches, with roughly
10% run-to-run spread even at a fixed seed. No test here treats a loss value as a pass
criterion. The mock tests assert on losses only where the value is one the mock itself
declared, and the two real-trainer tests only ever ask whether a loss is finite or in the same
order of magnitude as another.
