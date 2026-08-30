"""Close a problem report once it has been dealt with.

    python scripts/close_issue.py chiron-platform/issue-20260830-221113-k3n9zq
    python scripts/close_issue.py issue-20260830-221113-k3n9zq --note "fixed in #2"
    python scripts/close_issue.py --list

Closing does two things to the artifact:

1. Sets its type from `open-issue` to `archived-issue`. The daily sweep only
   looks at open reports, so an archived one never comes back around as new
   work even if the watermark file is lost.
2. Clears its permission map. A report is created by whoever clicked the
   button, and Hypha grants an artifact's creator `*` on it. An anonymous
   reporter's identity expires with their websocket connection, but a
   signed-in reporter keeps a stable id and could otherwise still edit the
   evidence after we have started acting on it. Emptying the map leaves the
   workspace owner as the only party who can touch it.

Both edits are staged and then committed. A bare `edit` merges the parent
collection's permissions back into the child, which would hand `list`, `draft`
and `attach` on the archived report to everyone. Staging stores the config
verbatim and commit applies it verbatim, so the empty map survives.

Needs an admin token for the workspace.
"""

import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv
from hypha_rpc import connect_to_server

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")
WORKSPACE = "chiron-platform"
COLLECTION_ID = f"{WORKSPACE}/issues"
OPEN = "open-issue"
ARCHIVED = "archived-issue"


def _qualify(artifact_id: str) -> str:
    """Accept both `issue-...` and `chiron-platform/issue-...`."""
    return artifact_id if "/" in artifact_id else f"{WORKSPACE}/{artifact_id}"


def _token() -> str:
    token = os.environ.get("WORKSPACE_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not token:
        raise SystemExit(
            "Set WORKSPACE_TOKEN (or HYPHA_TOKEN) to an admin token for the "
            f"'{WORKSPACE}' workspace."
        )
    return token


async def _connect():
    return await connect_to_server(
        {"server_url": SERVER_URL, "workspace": WORKSPACE, "token": _token()}
    )


async def list_open() -> list:
    server = await _connect()
    try:
        artifact_manager = await server.get_service("public/artifact-manager")
        children = await artifact_manager.list(
            parent_id=COLLECTION_ID, limit=1000, order_by="-created_at"
        )
        return [dict(child) for child in children]
    finally:
        try:
            await server.disconnect()
        except Exception:
            pass


async def close(artifact_id: str, note: str | None) -> dict:
    server = await _connect()
    try:
        artifact_manager = await server.get_service("public/artifact-manager")
        before = dict(await artifact_manager.read(artifact_id=artifact_id))

        # Archiving ends in a commit, and a commit applies whatever is staged.
        # A signed-in reporter still holds `*` on their own report right up
        # until this runs, so they could have staged a manifest edit or an
        # extra file that our commit would then publish for them. Drop any
        # pending staging first, so the only thing this commit carries is what
        # this script staged.
        try:
            await artifact_manager.discard(artifact_id=artifact_id)
        except Exception:
            # Nothing staged is the normal case and raises here.
            pass

        manifest = dict(before.get("manifest") or {})
        if note:
            manifest["resolution"] = note

        config = dict(before.get("config") or {})
        config["permissions"] = {}

        await artifact_manager.edit(
            artifact_id=artifact_id,
            type=ARCHIVED,
            manifest=manifest,
            config=config,
            stage=True,
        )
        await artifact_manager.commit(artifact_id=artifact_id)
        return dict(await artifact_manager.read(artifact_id=artifact_id))
    finally:
        try:
            await server.disconnect()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "artifact_id",
        nargs="?",
        help="e.g. chiron-platform/issue-<timestamp>-<uuid>",
    )
    parser.add_argument("--note", help="one line on how it was resolved")
    parser.add_argument(
        "--list",
        action="store_true",
        dest="list_only",
        help="show every report and its state, then exit",
    )
    args = parser.parse_args()

    if args.list_only:
        for report in asyncio.run(list_open()):
            print(f"{report.get('type', '?'):<15} {report.get('id')}")
        return

    if not args.artifact_id:
        parser.error("give an artifact id, or --list")

    artifact_id = _qualify(args.artifact_id)
    try:
        after = asyncio.run(close(artifact_id, args.note))
    except Exception as error:  # noqa: BLE001 - the message is the useful part here
        text = str(error)
        if "does not exist" in text:
            print(f"No such report: {artifact_id}.", file=sys.stderr)
        else:
            print(f"Could not close {artifact_id}: {text}", file=sys.stderr)
        raise SystemExit(1)

    permissions = (after.get("config") or {}).get("permissions") or {}
    print(f"Closed  {artifact_id}")
    print(f"Type    {after.get('type')}")
    print(f"Grants  {permissions if permissions else 'none, workspace owner only'}")
    if permissions:
        print(
            "Warning: the permission map is not empty, so somebody other than "
            "the workspace owner still has rights on this report.",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
