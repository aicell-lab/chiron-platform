# End-to-end screenshots

One directory per model, written by the UI suite in `tests/e2e/ui` as it walks a
complete journey: the landing page, the model hub, the account menu, My Models,
Runs, the worker setup guide, the instance list, a worker dashboard, the
three-step training wizard, a real federated run, the checkpoint panel and the
Report Issue dialog.

Files are numbered in stage order within a run, so a directory reads as a
walkthrough of that model's pass. A run that hits a retry numbers differently
from a clean one, so read the suite's log alongside them.

Regenerate with `python tests/e2e/ui/run_all.py`, or one model at a time with
`--models <slug>`. Override the destination with `CHIRON_SHOTS`.
