#!/usr/bin/env python3
"""Run every model journey in sequence and print one summary at the end.

pytest can do this on its own. What it cannot do on its own is keep going after
a leg fails, which is what you want on a four-model pass: one model's worker
failing to deploy should not cost you the other three legs' screenshots.

    python tests/e2e/ui/run_all.py
    python tests/e2e/ui/run_all.py --models scgpt,geneformer --rounds 1
    python tests/e2e/ui/run_all.py --base-url https://chiron.aicell.io --stop-workers
"""
import argparse
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from models import SLUGS  # noqa: E402
import worker as worker_mod  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", default=",".join(SLUGS))
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--base-url")
    parser.add_argument("--transport", choices=["webrtc", "websocket"])
    parser.add_argument("--skip-worker-swap", action="store_true")
    parser.add_argument("--keep-shots", action="store_true")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--stop-workers", action="store_true",
                        help="stop every model worker when the pass finishes")
    args = parser.parse_args()

    wanted = [s.strip() for s in args.models.split(",") if s.strip()]
    results = {}
    for slug in wanted:
        command = [sys.executable, "-m", "pytest", str(HERE), "-x", "-s",
                   "--models", slug, "--rounds", str(args.rounds)]
        if args.base_url:
            command += ["--base-url", args.base_url]
        if args.transport:
            command += ["--transport", args.transport]
        if args.skip_worker_swap:
            command.append("--skip-worker-swap")
        if args.keep_shots:
            command.append("--keep-shots")
        if args.headed:
            command.append("--headed")

        print(f"\n{'#' * 70}\n# {slug}\n{'#' * 70}", flush=True)
        started = time.monotonic()
        code = subprocess.run(command, cwd=HERE.parents[2]).returncode
        results[slug] = (code, time.monotonic() - started)

    print(f"\n{'=' * 70}\nsummary\n{'=' * 70}", flush=True)
    for slug, (code, seconds) in results.items():
        verdict = "pass" if code == 0 else f"FAIL (exit {code})"
        print(f"  {slug:<14} {verdict:<16} {seconds / 60:.1f} min", flush=True)

    if args.stop_workers and not args.skip_worker_swap:
        worker_mod.stop_all(SLUGS)

    return 0 if all(code == 0 for code, _ in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
