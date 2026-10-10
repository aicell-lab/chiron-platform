"""The browser drives preprocessing, and the store actually changes.

This is the proof the Prepare-data step works, and it is deliberately narrower
than `test_model_journeys.py`. That suite walks a whole federated run and takes
twenty minutes a model. This one answers a single question: when an organiser
types a threshold into the wizard and presses Apply, does the data on the
worker end up filtered by *that* number?

Answering it needs both halves, and neither alone is worth much:

  - the browser half, which proves the form, the RPC and the request channel
    are wired together, and
  - a read-back over Hypha, which proves the store on disk changed. A UI that
    reports success while the data is untouched is exactly the failure mode a
    screenshot cannot catch.

So the test types a value the defaults would never produce, applies it, waits
for every site to report Prepared, and then asks the manager what the store
actually holds. The assertion is on the store, not on the page.

Run it against a site whose worker image matches the model under test:

    pytest tests/e2e/ui/test_preprocessing.py -x -s --models tabula
    pytest tests/e2e/ui/test_preprocessing.py -x -s --models geneformer

The two legs are separate invocations because the worker's image decides which
trainer it may host, and therefore which recipe the step offers.
"""
import os
import pathlib
import sys
import time

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import training  # noqa: E402
from models import MODELS, SLUGS  # noqa: E402
from session import open_session  # noqa: E402

try:  # pragma: no cover - import guard, not logic
    import worker as worker_mod
except Exception:  # noqa: BLE001
    worker_mod = None


# What the organiser types. Every value is deliberately not the published
# default, so a store that still carries the default proves the form did not
# reach the data server rather than proving the two happen to agree.
NON_DEFAULT = {
    "tabula": {
        "labels": {
            "Minimum detected genes per cell": 200,
            "Minimum cells per gene": 60,
        },
        "expect": {"min_genes_per_cell": 200, "min_cells_per_gene": 60},
        # Fixed by the checkpoint. The form must not offer them, and the store
        # must still record them, because the rescan feeds its own record back
        # through parameter resolution.
        "expect_fixed": {"n_hvg": 1200, "n_bins": 50},
    },
    "geneformer": {
        "labels": {"Minimum detected genes per cell": 400},
        "expect": {"geneformer_min_genes_per_cell": 400},
        "expect_fixed": {"geneformer_max_ranks": 4096},
    },
}


def _manager_status(dataset_id, model_family):
    """Ask the worker what its store holds, over the same RPC the UI uses.

    Deliberately a second channel. Reading the page back to itself would pass
    whether or not anything was written.
    """
    import asyncio
    import concurrent.futures

    from hypha_rpc import connect_to_server

    token = os.environ.get("CHIRON_HYPHA_TOKEN") or os.environ.get("HYPHA_TOKEN")
    assert token, (
        "set CHIRON_HYPHA_TOKEN (or HYPHA_TOKEN) so the test can read the "
        "store back through the manager"
    )

    async def run():
        server = await connect_to_server(
            {
                "server_url": os.environ.get(
                    "CHIRON_SERVER_URL", "https://hypha.aicell.io"
                ),
                "token": token,
                "workspace": os.environ.get("CHIRON_WORKSPACE", "chiron-platform"),
            }
        )
        services = await server.list_services()
        managers = [s for s in services if s["id"].endswith(":chiron-manager")]
        assert managers, "no chiron-manager service is registered in the workspace"
        manager = await server.get_service(managers[0]["id"])
        return await manager.get_preprocessing_status(
            dataset_id=dataset_id, model_family=model_family
        )

    # On its own thread with its own loop. The test itself is synchronous, but
    # pytest-asyncio installs a running loop in this thread, and asyncio.run
    # refuses to start a second one inside it.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(run())).result(timeout=180)


@pytest.mark.parametrize("model", MODELS, ids=[m["slug"] for m in MODELS])
def test_browser_triggers_custom_preprocessing(
    model, pytestconfig, token, selected_models, base_url
):
    slug = model["slug"]
    if slug not in selected_models:
        pytest.skip(f"{slug} not in --models")
    case = NON_DEFAULT.get(slug)
    if case is None:
        pytest.skip(f"no non-default parameter set defined for {slug}")

    family = model.get("model_family", slug)
    # The dataset row the launch dialog should tick. models.py names the demo
    # corpora the journey suite uses, which a bench site need not carry, so a
    # bench run names its own.
    if os.environ.get("CHIRON_E2E_DATASET_LABEL"):
        model = dict(model, dataset=os.environ["CHIRON_E2E_DATASET_LABEL"])
    print(f"\n{'=' * 70}\n[{slug}] preprocessing journey\n{'=' * 70}", flush=True)

    if not pytestconfig.getoption("--skip-worker-swap") and worker_mod is not None:
        worker_mod.swap_to(slug, SLUGS)

    with sync_playwright() as playwright:
        session = open_session(
            playwright,
            f"{slug}-prep",
            token,
            fresh=not pytestconfig.getoption("--keep-shots"),
            headed=pytestconfig.getoption("--headed"),
        )
        try:
            training.open_wizard(session)
            training.ensure_orchestrator(session)
            training.ensure_trainer(session, model)
            training.register_trainer(session)

            page = session.page
            page.get_by_role(
                "button", name=training.NEXT_FROM_SELECT
            ).click(timeout=30_000)
            page.wait_for_timeout(2000)

            # The step must render from the schema the data server published,
            # not from anything compiled into the bundle. If the fetch failed
            # the form has no fields and typing below would silently no-op.
            page.wait_for_selector("text=Prepare the data", timeout=60_000)
            for label in case["labels"]:
                # The same locator `set_number` uses. Asserting it here rather
                # than trusting that helper, which prints a warning and
                # returns False for a field it cannot find: a typed value that
                # never landed would otherwise apply the defaults while this
                # test believed it had set a threshold.
                field = page.locator(
                    f"div:has(> label:text-is('{label}')) > input"
                )
                assert field.count() > 0, (
                    f"the Prepare step offers no field {label!r}, so the "
                    "schema the data server published did not reach the form"
                )

            dataset_id = os.environ.get("CHIRON_E2E_DATASET")
            before = _manager_status(dataset_id, family) if dataset_id else None

            training.prepare(session, params=case["labels"], apply_timeout=900)
            session.shot("prepared-custom")

            # --- the half that cannot be faked by the page ------------------
            if not dataset_id:
                pytest.skip(
                    "set CHIRON_E2E_DATASET to the dataset id so the test can "
                    "read the store back; the browser half passed"
                )

            # Poll rather than read once. The page can report every site
            # Prepared a beat before the manager's view of the store catches
            # up, and a single read then sees the previous recipe, which is
            # indistinguishable from the request never arriving.
            deadline = time.monotonic() + 900
            after = None
            while time.monotonic() < deadline:
                after = _manager_status(dataset_id, family)
                stores = [
                    s for s in after.get("stores", []) if s.get("preprocessing")
                ]
                settled = stores and all(
                    all(
                        s["preprocessing"]["params"].get(k) == v
                        for k, v in case["expect"].items()
                    )
                    for s in stores
                )
                if after["state"] == "error" or settled:
                    break
                time.sleep(10)

            assert after and after["state"] == "done", (
                f"the site reports {after['state'] if after else None!r} after "
                f"Apply: {after.get('error') if after else None}"
            )
            stores = [s for s in after.get("stores", []) if s.get("preprocessing")]
            assert stores, "no store on the site recorded a preprocessing block"

            for store in stores:
                recorded = store["preprocessing"]["params"]
                for key, value in case["expect"].items():
                    assert recorded.get(key) == value, (
                        f"{store['name']} recorded {key}={recorded.get(key)!r}, "
                        f"but the browser asked for {value!r}"
                    )
                for key, value in case["expect_fixed"].items():
                    assert recorded.get(key) == value, (
                        f"{store['name']} recorded a fixed parameter "
                        f"{key}={recorded.get(key)!r}, expected {value!r}"
                    )

            # Every site must agree, which is the reason the step applies one
            # parameter set to the whole federation rather than per site.
            prints = {s["preprocessing"].get("fingerprint") for s in stores}
            assert len(prints) == 1, (
                f"the site's own stores disagree on the recipe: {prints}"
            )

            # Only meaningful when the store did not already carry exactly
            # these thresholds. Re-applying the same recipe is correctly a
            # no-op, and demanding a moved fingerprint there would fail the
            # test for behaving properly.
            prior = [
                s["preprocessing"]["params"]
                for s in (before or {}).get("stores", [])
                if s.get("preprocessing")
            ]
            already_held = prior and all(
                all(p.get(k) == v for k, v in case["expect"].items())
                for p in prior
            )
            if before is not None and before.get("fingerprint") and not already_held:
                assert after["fingerprint"] != before["fingerprint"], (
                    "the recipe fingerprint did not move, so Apply changed "
                    "nothing even though the parameters differ from before"
                )

            print(
                f"  [{slug}] store recorded {case['expect']} "
                f"fingerprint={after['fingerprint']}",
                flush=True,
            )
        except Exception:
            # The page is the evidence. Most failures here are "a control was
            # not where the test looked", and a traceback does not show that.
            try:
                session.shot("FAILURE")
                from session import dump_controls

                dump_controls(session.page, f"{slug} preprocessing failure")
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            session.browser.close()
