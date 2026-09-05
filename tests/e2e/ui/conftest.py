"""Options and fixtures for the UI end-to-end suite.

The suite is not hermetic and does not pretend to be: it drives the deployed
frontend against a real BioEngine worker and a real Hypha workspace. The knobs
here are the ones that change between a laptop, a dev tunnel and CI.
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import session as session_mod  # noqa: E402
from models import SLUGS  # noqa: E402


def pytest_addoption(parser):
    group = parser.getgroup("chiron")
    group.addoption("--base-url", default=None,
                    help="frontend under test, default http://localhost:3000 "
                         "or $CHIRON_URL")
    group.addoption("--models", default=",".join(SLUGS),
                    help="comma-separated model slugs to run, in order")
    group.addoption("--rounds", type=int, default=2,
                    help="federated rounds per model. Two is enough to produce "
                         "a loss curve and a per-round checkpoint.")
    group.addoption("--transport", default=None, choices=["webrtc", "websocket"],
                    help="force the weight transport, instead of the operator's "
                         "persisted choice")
    group.addoption("--skip-worker-swap", action="store_true",
                    help="do not touch docker. Use when the worker for the "
                         "model under test is already running.")
    group.addoption("--headed", action="store_true", help="show the browser")
    group.addoption("--keep-shots", action="store_true",
                    help="add to the existing screenshots instead of clearing "
                         "the model's directory first")


@pytest.fixture(scope="session", autouse=True)
def base_url(pytestconfig):
    chosen = pytestconfig.getoption("--base-url")
    if chosen:
        session_mod.BASE_URL = chosen
    print(f"\n[suite] driving {session_mod.BASE_URL}", flush=True)
    return session_mod.BASE_URL


@pytest.fixture(scope="session")
def token():
    return session_mod.ui_token()


@pytest.fixture(scope="session")
def selected_models(pytestconfig):
    wanted = [s.strip() for s in pytestconfig.getoption("--models").split(",") if s.strip()]
    unknown = [s for s in wanted if s not in SLUGS]
    if unknown:
        raise pytest.UsageError(f"unknown model slug(s): {unknown}. Known: {SLUGS}")
    return wanted


def pytest_collection_modifyitems(config, items):
    """Run the model legs in the order the operator asked for.

    Order matters here in a way it does not in a normal suite: each leg swaps
    the single GPU worker to its own image, so two legs cannot overlap and the
    sequence is the whole point.
    """
    wanted = [s.strip() for s in config.getoption("--models").split(",") if s.strip()]
    rank = {slug: i for i, slug in enumerate(wanted)}

    def key(item):
        for slug, position in rank.items():
            if f"[{slug}]" in item.name:
                return position
        return len(rank)

    items.sort(key=key)
