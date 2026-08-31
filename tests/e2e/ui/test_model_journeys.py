"""One end-to-end journey per model, run in sequence.

Each journey is a single test because the stages share state that cannot be
rebuilt cheaply: a deployed orchestrator, a deployed trainer, a registered
pairing and a finished run. Splitting them into separate tests would mean
either redoing a fifteen-minute federated run per assertion or leaking state
between tests through the worker, and both are worse than one long test that
reports where it stopped.

The models run one after another rather than in parallel: they share a single
GPU worker, and the worker's image is what decides which trainer it may host.

    pytest tests/e2e/ui -x -s
    pytest tests/e2e/ui -x -s --models scgpt --rounds 1 --skip-worker-swap
    pytest tests/e2e/ui -x -s --base-url https://chiron.aicell.io

`-s` is not optional in practice. The journey prints what it clicked, what it
skipped and what the orchestrator said, and that log is the only record of a
run that took twenty minutes.
"""
import pathlib
import sys

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import tour  # noqa: E402
import training  # noqa: E402
import worker as worker_mod  # noqa: E402
from models import MODELS, SLUGS  # noqa: E402
from session import open_session  # noqa: E402


@pytest.mark.parametrize("model", MODELS, ids=[m["slug"] for m in MODELS])
def test_model_journey(model, pytestconfig, token, selected_models, base_url):
    if model["slug"] not in selected_models:
        pytest.skip(f"{model['slug']} not in --models")

    rounds = pytestconfig.getoption("--rounds")
    transport = pytestconfig.getoption("--transport")
    print(f"\n{'=' * 70}\n[{model['slug']}] starting journey "
          f"({rounds} round{'s' if rounds != 1 else ''})\n{'=' * 70}", flush=True)

    if not pytestconfig.getoption("--skip-worker-swap"):
        worker_mod.swap_to(model["slug"], SLUGS)

    with sync_playwright() as playwright:
        session = open_session(
            playwright, model["slug"], token,
            fresh=not pytestconfig.getoption("--keep-shots"),
            headed=pytestconfig.getoption("--headed"),
        )
        try:
            # --- the pages a visitor sees before they own anything ---------
            tour.landing(session)
            tour.models_hub(session)
            tour.account_menu(session)
            broken = tour.my_models(session)
            assert not broken, f"images failed to render on My Models: {broken}"
            tour.runs_page(session)

            # --- setting a worker up ---------------------------------------
            tour.worker_guide(session, model)
            tour.worker_instances(session)
            tour.worker_dashboard(session)

            # --- the federated run ------------------------------------------
            training.open_wizard(session)
            training.ensure_orchestrator(session)
            training.ensure_trainer(session, model)
            training.register_trainer(session)
            training.configure(session, model, rounds, transport=transport)
            training.run(session, rounds)
            training.inspect_history(session)
            training.save_weights(session)

            # --- the one path that must work when everything else did not ---
            tour.report_issue_dialog(session)
        except Exception:
            # A screenshot of the failure is worth more than the traceback,
            # because most failures here are "a control was not where the
            # suite looked" and the page shows why.
            try:
                session.shot("FAILURE")
                from session import dump_controls
                dump_controls(session.page, f"{model['slug']} failure")
            except Exception:
                pass
            raise
        finally:
            session.browser.close()

    print(f"[{model['slug']}] journey complete, screenshots in {session.outdir}",
          flush=True)
