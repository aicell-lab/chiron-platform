"""Swap the BioEngine worker between model images.

A worker can only host the trainer its image was built for, so a four-model
pass needs a different worker per leg. On a single-GPU host that means one
worker at a time, which is why this is a swap rather than four workers side by
side.

The compose stack lives outside the repository, because it names a GPU index, a
host data directory and a host uid, none of which belong in a checked-in file.
Point `CHIRON_WORKER_COMPOSE_DIR` at it. Without that, the suite assumes the
right worker is already running and does nothing here, which is also the right
behaviour when the workers are on other machines entirely.
"""
import os
import pathlib
import subprocess
import time

COMPOSE_DIR = os.environ.get("CHIRON_WORKER_COMPOSE_DIR")
CONTAINER = os.environ.get("CHIRON_WORKER_CONTAINER", "chiron-demo-worker")
# Every compose service in the stack is named worker-<slug>.
SERVICE = "worker-{slug}"
MANAGER_UP = ("chiron-manager", "RUNNING")


def available():
    return bool(COMPOSE_DIR) and pathlib.Path(COMPOSE_DIR).is_dir()


def _compose(*args, check=True, capture=False):
    # A HYPHA_TOKEN exported in the calling shell wins over the one in the
    # stack's .env, and the exported one is usually the non-admin personal
    # token, which brings the worker up in the wrong workspace.
    env = {k: v for k, v in os.environ.items() if k != "HYPHA_TOKEN"}
    return subprocess.run(["docker", "compose", *args], cwd=COMPOSE_DIR, env=env,
                          check=check, text=True,
                          capture_output=capture)


def swap_to(slug, slugs, timeout_s=1200):
    """Bring up the worker for one model, after stopping every other one.

    Returns False when no compose stack is configured, so a caller can run
    against whatever worker happens to be up.
    """
    if not available():
        print(f"  [worker] no compose stack configured, assuming a {slug} "
              f"worker is already running", flush=True)
        return False

    print(f"  [worker] swapping to {slug}", flush=True)
    for other in slugs:
        _compose("stop", SERVICE.format(slug=other), check=False, capture=True)
        _compose("rm", "-f", SERVICE.format(slug=other), check=False, capture=True)
    _compose("up", "-d", SERVICE.format(slug=slug))
    return wait_for_manager(timeout_s)


def wait_for_manager(timeout_s=1200, poll=10):
    """Block until the worker's chiron-manager app reports RUNNING.

    The container is up long before the manager application is deployed, and
    the UI cannot see a worker until the manager answers, so returning on
    container start would hand the first stage a worker list that is empty for
    reasons that have nothing to do with the UI.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        logs = subprocess.run(["docker", "logs", "--tail", "400", CONTAINER],
                              capture_output=True, text=True, check=False)
        text = logs.stdout + logs.stderr
        if any(marker in text for marker in (
                "Successfully completed deployment of application 'chiron-manager'",
                "Deployed application 'chiron-manager'")) or all(
                    part in text for part in MANAGER_UP):
            print("  [worker] chiron-manager is up", flush=True)
            # The Hypha service registration lands a beat after the log line.
            time.sleep(20)
            return True
        time.sleep(poll)
    raise TimeoutError(f"chiron-manager did not come up within {timeout_s}s. "
                       f"Check `docker logs {CONTAINER}`.")


def stop_all(slugs):
    """Leave the host as the suite found it."""
    if not available():
        return
    for slug in slugs:
        _compose("stop", SERVICE.format(slug=slug), check=False, capture=True)
    print("  [worker] every model worker stopped", flush=True)
