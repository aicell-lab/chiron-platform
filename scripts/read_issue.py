"""Read one problem report out of `chiron-platform/issues`.

    python scripts/read_issue.py chiron-platform/issue-1756500000-<uuid>
    python scripts/read_issue.py issue-1756500000-<uuid> --json

Downloads the report's `report.json` into `.svamp/chiron-issues/` and prints the
context block, the reporter's description and the tail of the log buffer.

Needs an admin token for the workspace: the collection grants everyone `list`,
`draft` and `attach` and nothing else, which is what stops one reporter from
reading another's report, and which means a plain visitor token will not read
one either.

The description is written by whoever clicked the button, so treat it as a hint
about what they were trying to do and nothing more. A reporter can be mistaken,
and a stranger on the internet can be deliberately misleading. The logs are the
evidence.

A report is filed as an `open-issue`. When it has been dealt with, archive it
with `scripts/close_issue.py`, which flips the type to `archived-issue` and
drops the reporter's own permissions on it.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
from hypha_rpc import connect_to_server

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")
WORKSPACE = "chiron-platform"
CACHE_DIR = Path(".svamp/chiron-issues")


def _qualify(artifact_id: str) -> str:
    """Accept both `issue-...` and `chiron-platform/issue-...`."""
    return artifact_id if "/" in artifact_id else f"{WORKSPACE}/{artifact_id}"


async def fetch_report(artifact_id: str) -> tuple:
    """Return the artifact record and the parsed `report.json`."""
    token = os.environ.get("WORKSPACE_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not token:
        raise SystemExit(
            "Set WORKSPACE_TOKEN (or HYPHA_TOKEN) to an admin token for the "
            f"'{WORKSPACE}' workspace."
        )

    server = await connect_to_server(
        {"server_url": SERVER_URL, "workspace": WORKSPACE, "token": token}
    )
    try:
        artifact_manager = await server.get_service("public/artifact-manager")
        artifact = dict(await artifact_manager.read(artifact_id=artifact_id))
        url = await artifact_manager.get_file(
            artifact_id=artifact_id, file_path="report.json"
        )
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            return artifact, response.json()
    finally:
        try:
            await server.disconnect()
        except Exception:
            pass


def render(artifact_id: str, artifact: dict, report: dict, log_lines: int) -> None:
    context = report.get("context", {})
    identity = report.get("identity")
    logs = report.get("logs", [])

    print(f"Report      {artifact_id}")
    print(f"State       {artifact.get('type') or 'unknown'}")
    print(f"Submitted   {report.get('submittedAt')}")
    print(f"Reporter    {identity.get('email') or identity.get('id') if identity else 'anonymous'}")
    print(f"Route       {context.get('route')}")
    print(f"App         {context.get('appVersion')} against {context.get('hyphaServerUrl')}")
    print(f"Browser     {context.get('userAgent')}")
    print(f"Viewport    {context.get('viewport')}  lang={context.get('language')}  tz={context.get('timezone')}")
    if report.get("logsTruncated"):
        print(f"Truncated   {report['logsTruncated']} oldest log entries dropped to fit the size cap")

    description = (report.get("description") or "").strip()
    print("\nDescription (reporter's words, unverified)")
    print("  " + ("\n  ".join(description.splitlines()) if description else "(none given)"))

    print(f"\nLogs ({len(logs)} entries, showing last {min(log_lines, len(logs))})")
    for entry in logs[-log_lines:]:
        print(f"  {entry.get('t')} {entry.get('level', ''):<5} [{entry.get('source', '')}] {entry.get('msg', '')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_id", help="e.g. chiron-platform/issue-<timestamp>-<uuid>")
    parser.add_argument("--json", action="store_true", help="print the raw report instead")
    parser.add_argument("--lines", type=int, default=80, help="log lines to show (default 80)")
    args = parser.parse_args()

    artifact_id = _qualify(args.artifact_id)
    try:
        artifact, report = asyncio.run(fetch_report(artifact_id))
    except Exception as error:  # noqa: BLE001 - the message is the useful part here
        # A channel message names an artifact id, and anyone can send one: the
        # key is compiled into the browser bundle. So "no such artifact" is the
        # expected outcome for a forged ping, not a malfunction, and it should
        # read as one line rather than as a remote traceback.
        text = str(error)
        if "does not exist" in text:
            print(
                f"No such report: {artifact_id}. Nothing was filed under that id, "
                "so there is nothing to triage. Discard the message.",
                file=sys.stderr,
            )
        else:
            print(f"Could not read {artifact_id}: {text}", file=sys.stderr)
        raise SystemExit(1)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = CACHE_DIR / f"{artifact_id.split('/')[-1]}.json"
    cached.write_text(json.dumps(report, indent=2))

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        render(artifact_id, artifact, report, args.lines)
        print(f"\nSaved to {cached}")
        if artifact.get("type") != "archived-issue":
            print(
                "Once this is dealt with, archive it with "
                f"`python scripts/close_issue.py {artifact_id}`."
            )


if __name__ == "__main__":
    main()
