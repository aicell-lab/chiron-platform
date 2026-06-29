"""Targeted test for bioengine PR #133 — BioEngineDatasets stale-URL recovery.

PR #133 added transport-error recovery to the public data-path methods on
BioEngineDatasets (list_datasets, ping_data_server, list_files, get_file
non-zarr). On ConnectError / RemoteProtocolError / ReadError / ConnectTimeout
/ ReadTimeout the client now calls self.refresh() (re-reads the discovery
file) and retries once. 4xx/5xx HTTP errors are not caught (they mean the
server is reachable but unhappy).

This test runs entirely against the new tabula image's pip-installed bioengine
(d6b80ba = bioengine 0.11.16), without involving a live data-server or worker.
It just inspects the source to confirm the recovery wrapper exists and that
refresh() is a real method. The functional test (data-server moves, client
recovers) is the BioEngine team's own behavioural test on PR #133.

Usage:
    docker run --rm --entrypoint python ghcr.io/aicell-lab/tabula:0.6.1 \
        /path/to/feature_bioengine_stale_url_recovery.py
"""
from __future__ import annotations

import inspect
import sys

try:
    import bioengine
    from bioengine.datasets.datasets import BioEngineDatasets
except Exception as e:
    print(f"FAIL: cannot import bioengine: {e}")
    sys.exit(1)


def main() -> int:
    print(f"bioengine.__version__ = {bioengine.__version__}")
    ver_ok = bioengine.__version__ in ("0.11.16", "0.11.17", "0.11.18", "0.11.19", "0.11.20")
    if not ver_ok and not bioengine.__version__.startswith("0.11."):
        print(f"  ✗ FAIL: bioengine version {bioengine.__version__} is unexpected — expected >= 0.11.16")
        return 1
    if bioengine.__version__ < "0.11.16":
        print(f"  ✗ FAIL: bioengine version {bioengine.__version__} is below 0.11.16 (PR #133)")
        return 1
    print(f"  ✓ bioengine >= 0.11.16")

    if not hasattr(BioEngineDatasets, "refresh"):
        print("  ✗ FAIL: BioEngineDatasets.refresh is missing")
        return 1
    print("  ✓ BioEngineDatasets.refresh exists")

    # The recovery wrapper is one of these patterns: an internal helper
    # (_with_url_recovery / _retry_on_transport_error) or inline try/except
    # in each public method.
    cls_src = inspect.getsource(BioEngineDatasets)
    recovery_helper = any(name in cls_src for name in
                          ("_with_url_recovery", "_retry_on_transport_error",
                           "_with_retry_on_transport", "_retry_after_refresh"))
    list_datasets_src = inspect.getsource(BioEngineDatasets.list_datasets)
    inline_recovery = (
        "ConnectError" in list_datasets_src
        or "refresh()" in list_datasets_src
        or "_with_url_recovery" in list_datasets_src
    )
    if not (recovery_helper or inline_recovery):
        print("  ✗ FAIL: list_datasets has no transport-error recovery wrapper")
        print("    --- list_datasets source ---")
        print(list_datasets_src[:1200])
        return 1
    print("  ✓ list_datasets references a transport-error recovery path")

    ping_src = inspect.getsource(BioEngineDatasets.ping_data_server)
    ping_recovery = (
        "ConnectError" in ping_src
        or "refresh()" in ping_src
        or "_with_url_recovery" in ping_src
    )
    if not (recovery_helper or ping_recovery):
        print("  ✗ FAIL: ping_data_server has no transport-error recovery wrapper")
        return 1
    print("  ✓ ping_data_server references a transport-error recovery path")

    print()
    print("✓ all checks passed (bioengine PR #133 fix present in image)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
