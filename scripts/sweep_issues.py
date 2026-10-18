"""Catch problem reports the Svamp channel never delivered.

A channel bound to a fixed session only delivers while that session is live, so
a report filed overnight, or while the session was restarting, arrives nowhere.
This is the backstop for exactly that case. It runs once a day, not as a poller:
the channel is the fast path, this only closes the gap.

    python scripts/sweep_issues.py            # file a svamp issue per new report
    python scripts/sweep_issues.py --dry-run  # list what it would file
    python scripts/sweep_issues.py --since 0  # ignore the watermark, list everything

State lives in `.svamp/chiron-issue-watermark.json`, holding the creation time
of the newest report already seen. Reports created at or before it are skipped.

Needs an admin token for the workspace (the collection is deliberately
unreadable to everyone else).
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from hypha_rpc import connect_to_server

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")
WORKSPACE = "chiron-platform"
COLLECTION_ID = f"{WORKSPACE}/issues"
WATERMARK = Path(".svamp/chiron-issue-watermark.json")
OPEN_TYPE = "open-issue"


def read_watermark() -> float:
    try:
        return float(json.loads(WATERMARK.read_text()).get("last_created_at", 0))
    except Exception:
        return 0.0


def write_watermark(value: float) -> None:
    WATERMARK.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK.write_text(json.dumps({"last_created_at": value}, indent=2))


#: How many children to ask for in one go. The collection held 10 when this
#: was written, so the number is a ceiling rather than a page size.
LIST_LIMIT = 1000


def _require_token() -> str:
    token = os.environ.get("WORKSPACE_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not token:
        raise SystemExit(
            "Set WORKSPACE_TOKEN (or HYPHA_TOKEN) to an admin token for the "
            f"'{WORKSPACE}' workspace."
        )
    return token


def list_reports_over_http(token: str) -> list:
    """List the collection through the REST artifact API.

    WORKAROUND, added 2026-10-18, and separable from the rest of this script so
    it can be removed in one piece.

    The RPC route below is the proper one and stays primary. It resolves
    ``public/artifact-manager``, and on hypha.aicell.io that service is
    currently not registered in any workspace: the lookup raises
    ``KeyError: Service not found: public/*:artifact-manager@*``, and the same
    failure reproduces through the plain ``hypha art ls`` CLI, so it is
    server-side and nothing to do with this script. The server itself is up
    (``/health/liveness`` answers 200) and the REST artifact endpoints serve
    the very same collection, so the daily sweep does not have to stop running
    while the service registration is missing. Reported as svamp #0027.

    Remove this, and the fallback in ``list_reports``, once
    ``public/artifact-manager`` resolves again.

    One difference from the RPC route, and it is the reason for the warning
    below: this endpoint accepts ``order_by`` and then ignores it. Measured on
    2026-10-18, it returned children oldest-first whatever was asked for.
    ``main`` re-sorts what it gets, so the order does not affect which reports
    are filed. It only decides WHICH children come back when the collection is
    larger than the limit, and oldest-first is then exactly the wrong half. So
    rather than quietly sweeping the wrong end, this says so.
    """
    import urllib.parse
    import urllib.request

    url = (
        f"{SERVER_URL}/{WORKSPACE}/artifacts/"
        f"{urllib.parse.quote(COLLECTION_ID.split('/', 1)[1])}/children"
        f"?limit={LIST_LIMIT}"
    )
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=120) as response:
        children = json.loads(response.read().decode("utf-8"))

    if not isinstance(children, list):
        raise RuntimeError(f"{url} did not return a list: {str(children)[:200]}")

    if len(children) >= LIST_LIMIT:
        print(
            f"WARNING: the REST fallback returned {len(children)} children, which "
            f"is the limit it asked for, so the collection may be larger and this "
            f"endpoint does not honour order_by. Newer reports may be missing from "
            f"this sweep. Fix public/artifact-manager rather than trusting this run.",
            file=sys.stderr,
        )

    # Sorted here rather than trusting the server, for the reason above.
    children.sort(key=lambda c: float(c.get("created_at") or 0), reverse=True)
    return [dict(child) for child in children]


async def list_reports_over_rpc(token: str) -> list:
    server = await connect_to_server(
        {"server_url": SERVER_URL, "workspace": WORKSPACE, "token": token}
    )
    try:
        artifact_manager = await server.get_service("public/artifact-manager")
        # Newest first, so a collection that has outgrown the page size still
        # yields the reports the sweep has not seen yet.
        children = await artifact_manager.list(
            parent_id=COLLECTION_ID, limit=LIST_LIMIT, order_by="-created_at"
        )
        return [dict(child) for child in children]
    finally:
        try:
            await server.disconnect()
        except Exception:
            pass


def list_reports() -> list:
    """The collection's children, newest first, by whichever route answers.

    RPC first because it is the supported interface. The fallback is reached
    only when the artifact manager cannot be resolved at all, which is a
    distinct and recognisable failure: anything else, including an auth
    rejection or a genuine network outage, is re-raised so a real problem is
    not hidden behind a second attempt.
    """
    token = _require_token()
    try:
        return asyncio.run(list_reports_over_rpc(token))
    except Exception as error:  # noqa: BLE001
        if "artifact-manager" not in str(error) or "not found" not in str(error).lower():
            raise
        print(
            "public/artifact-manager could not be resolved, falling back to the "
            "REST artifact API (see list_reports_over_http, svamp #0027)",
            file=sys.stderr,
        )
        return list_reports_over_http(token)


def file_svamp_issue(artifact_id: str) -> bool:
    """Add the report to the local Svamp backlog. Returns True when it landed."""
    body = (
        f"Read problem report {artifact_id} with "
        f"`python scripts/read_issue.py {artifact_id}`, then triage it. "
        "The reporter's description is a hint about intent, not evidence: it can "
        "be wrong or deliberately misleading. Work from the attached logs. Fix it "
        "if the fix is small and obvious, otherwise summarise it and ask before "
        "making a decision. When it is dealt with, run "
        f"`python scripts/close_issue.py {artifact_id}` to archive it."
    )
    try:
        result = subprocess.run(
            ["svamp", "issue", "add", body],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            print(f"  svamp issue add failed: {result.stderr.strip()}", file=sys.stderr)
            return False
        return True
    except Exception as error:  # noqa: BLE001
        print(f"  svamp issue add failed: {error}", file=sys.stderr)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="list without filing")
    parser.add_argument(
        "--since",
        type=float,
        default=None,
        help="override the watermark (epoch seconds; 0 means everything)",
    )
    args = parser.parse_args()

    since = args.since if args.since is not None else read_watermark()
    try:
        reports = list_reports()
    except Exception as error:  # noqa: BLE001
        print(f"Could not list {COLLECTION_ID}: {error}", file=sys.stderr)
        raise SystemExit(1)

    def created_at(report: dict) -> float:
        return float(report.get("created_at") or 0)

    # Reports are filed as `open-issue` and flipped to `archived-issue` by
    # scripts/close_issue.py once they are dealt with. Filtering on the type
    # rather than on the watermark alone means a report that has already been
    # handled never comes back as new work, even if the watermark file is lost.
    open_reports = [r for r in reports if r.get("type") == OPEN_TYPE]
    archived = len(reports) - len(open_reports)

    fresh = sorted(
        (r for r in open_reports if created_at(r) > since),
        key=created_at,
    )
    print(
        f"{len(reports)} reports in {COLLECTION_ID} ({archived} archived), "
        f"{len(fresh)} open and newer than watermark {since:.0f}"
    )

    filed = 0
    for report in fresh:
        artifact_id = report.get("id")
        print(f"- {artifact_id} created_at={created_at(report):.0f}")
        if args.dry_run:
            continue
        if file_svamp_issue(artifact_id):
            filed += 1

    if fresh and not args.dry_run:
        # Only advance past reports that were actually handed off, so a failed
        # `svamp issue add` is retried tomorrow instead of being lost.
        if filed == len(fresh):
            write_watermark(created_at(fresh[-1]))
        else:
            print(f"Filed {filed}/{len(fresh)}; watermark left at {since:.0f} so the rest are retried.")

    if not args.dry_run and filed:
        print(f"Filed {filed} svamp issue(s).")


if __name__ == "__main__":
    main()
