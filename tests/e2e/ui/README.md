# UI end-to-end suite

Drives the Chiron frontend through a complete journey for each of the four
supported models, pressing the controls a user presses: the model hub, the
worker setup guide, the instance list, a worker dashboard, the three-step
training wizard, a real federated run, and the save-weights panel.

It is not hermetic. It talks to a deployed frontend, a real Hypha workspace and
a real BioEngine worker, and a pass takes roughly twenty minutes per model at
two rounds. That is the point: everything this suite has ever caught was an
interaction between the browser and a live federation, and none of it is
reachable from a mocked page.

## What it covers

| Stage | What it presses |
|---|---|
| Landing | navbar links, the AI-agent popover |
| Model hub | search, a model card, the detail route |
| Account menu | the avatar dropdown and its connection status |
| My Models | every cover image is checked for a failed load |
| Runs | the run list and its Refresh |
| Worker guide | Human/AI Agent tabs, the model selector, both container runtimes, all five info popovers, the three disclosures, the manifest builder and its download, Advanced Options, a Copy button |
| Worker instances | Refresh, the Chiron-workers-only switch, add and remove an observed workspace, copy a service id, View Dashboard |
| Worker dashboard | the three copy buttons, Load app cache, Refresh, and a scroll through the cluster resource cards |
| Training wizard | the stepper, the launch dialog for both app kinds, the dataset picker, the batch-size stepper, trainer registration, the parameter form, the advanced sections, the transport switch, Start Training |
| Run | the live round counter, with the orchestrator as the tiebreak when the browser loses the run |
| After the run | Training History refresh, the checkpoint pills, Save to worker |
| Report Issue | the footer dialog, its payload preview and Cancel |

Three controls are deliberately checked for presence and never pressed, because
pressing them has consequences outside the test:

- **Upload Model** stages a real artifact in the user's workspace.
- **Clear Training History** throws away the loss curves the run just produced.
- **Stop Training** would end the run the leg exists to complete.

The Report Issue dialog is filled in and cancelled, never submitted. A submit
writes an artifact into `chiron-platform/issues`, and a suite that runs four
legs a pass would bury the collection in its own noise.

## Prerequisites

```bash
pip install pytest playwright
playwright install chromium
```

A **workspace admin token** for `chiron-platform`. The UI mints a child token
for every app it launches (`server.generateToken` in `Training.tsx`), and Hypha
only lets an admin-scoped token do that, so a personal `read_write` token fails
at the first deploy. The suite reads `CHIRON_UI_TOKEN`, then `HYPHA_TOKEN` from
the dotenv file named by `CHIRON_ENV_FILE`.

A **BioEngine worker** built from the image of the model under test. A worker
can only host the trainer its image was built for.

## Running

```bash
# every model, against a local dev server
pytest tests/e2e/ui -x -s

# one model, one round, against a worker that is already up
pytest tests/e2e/ui -x -s --models scgpt --rounds 1 --skip-worker-swap

# all four, keeping going if one leg fails, with a summary at the end
python tests/e2e/ui/run_all.py --base-url https://chiron.aicell.io
```

`-s` is not optional in practice. The journey prints what it clicked, what it
skipped and what the orchestrator reported, and on a twenty-minute leg that log
is the only record of what happened.

## Environment

| Variable | Meaning |
|---|---|
| `CHIRON_URL` | frontend under test. Default `http://localhost:3000`, overridden by `--base-url`. |
| `CHIRON_UI_TOKEN` | the token the browser logs in with. Falls back to `HYPHA_TOKEN` from the dotenv file. |
| `CHIRON_ENV_FILE` | dotenv file to read the token from. |
| `CHIRON_SHOTS` | screenshot root. Default `tests/e2e/screenshots`. |
| `CHIRON_WORKER_COMPOSE_DIR` | compose stack that owns the four per-model worker services. Unset means the suite never touches docker and assumes the right worker is up. |
| `CHIRON_WORKER_CONTAINER` | container name to tail while waiting for `chiron-manager`. |

The compose stack is deliberately outside the repository: it names a GPU index,
a host data directory and a host uid, none of which belong in a checked-in file.

## Screenshots

Each leg clears `tests/e2e/screenshots/<model>/` and writes a numbered sequence
in stage order, so the directory reads as a walkthrough of that model's run.
`--keep-shots` adds to what is there instead.

## Reading a failure

The suite screenshots the page as `FAILURE.png` and then dumps every visible
button, select and input before re-raising. Most failures are a control that
moved rather than a defect, and that dump is what tells the two apart.

Two failure modes are worth knowing about because they look like bugs and are
not:

- **The browser lost a healthy run.** The UI leaves the training view when its
  status polls fail, which is indistinguishable from a finished run. The suite
  asks the orchestrator directly and follows the run to its end rather than
  failing.
- **A control is missing right after a step change.** Most of the wizard is
  rendered from state that a single failed poll empties. Every decision to
  deploy is taken after a grace period, never off one read.
