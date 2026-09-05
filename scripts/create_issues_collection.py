"""Create the `chiron-platform/issues` collection that backs the Report Issue button.

One-time maintainer script. Run it once with an admin token for the
`chiron-platform` workspace, then never again unless the permission set changes.
It is not part of the build and is not run by CI.

Why the permission list is written out operation by operation instead of using
one of Hypha's short codes: no short code expands to exactly what we need. A
reporter must be able to create a child artifact and commit it, and must not be
able to read anybody else's report. The closest code, `lf+`, expands to
`["list", "list_files", "draft", "attach", "put_file"]`, and `list_files` on the
collection falls through to every child, which would leak the file listing of
every report. Hypha's `_expand_permission` passes a raw list through unchanged,
so we spell out the three operations we actually want.

    list    the collection is fetched with a `list` check before a child can be
            created under it, so this one cannot be withheld
    draft   create the child in staging
    attach  commit the staged child into the collection

Not granted, deliberately: `read` and `get_file` (a child falls back to its
parent for those two, so withholding them here is what keeps one reporter from
reading another's logs), `edit`, `commit` and `delete` on the collection itself,
and `put_file` (a reporter writes files to their own child, where they hold `*`
as its creator, never to the collection).

The consequence to be aware of: `list` is the same permission that enumerates
children together with their manifests, and it cannot be withheld. So a report's
manifest is deliberately content free and the whole payload lives in an attached
`report.json`, which is not readable. Keep it that way.
"""

import asyncio
import os

from dotenv import load_dotenv
from hypha_rpc import connect_to_server

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL", "https://hypha.aicell.io")
WORKSPACE = "chiron-platform"
COLLECTION_ALIAS = f"{WORKSPACE}/issues"

# Anyone, logged in or not, may file a report. Nobody but the workspace admins
# may read one back. See the module docstring for why this is a literal list.
REPORTER_PERMISSIONS = ["list", "draft", "attach"]


async def create_issues_collection() -> None:
    token = os.environ.get("WORKSPACE_TOKEN") or os.environ.get("HYPHA_TOKEN")
    if not token:
        raise SystemExit(
            "Set WORKSPACE_TOKEN (or HYPHA_TOKEN) to an admin token for the "
            f"'{WORKSPACE}' workspace before running this script."
        )

    server = await connect_to_server(
        {"server_url": SERVER_URL, "workspace": WORKSPACE, "token": token}
    )
    try:
        artifact_manager = await server.get_service("public/artifact-manager")

        collection = await artifact_manager.create(
            alias=COLLECTION_ALIAS,
            type="collection",
            manifest={
                "name": "Chiron Platform Issue Reports",
                "description": (
                    "Problem reports submitted from the Report Issue button in "
                    "the Chiron Platform web UI. Each child holds a redacted "
                    "browser log buffer and an optional free-text description."
                ),
            },
            config={"permissions": {"*": REPORTER_PERMISSIONS}},
            overwrite=True,
        )
        print(f"Collection created: {collection['id']}")
        print(f"Permissions: {collection['config'].get('permissions')}")
    finally:
        await server.disconnect()


if __name__ == "__main__":
    asyncio.run(create_issues_collection())
