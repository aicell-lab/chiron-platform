"""Print the orchestrator's own training status as JSON, one line.

Run as a subprocess by session.orchestrator_status. hypha_rpc's sync wrapper
dies encoding nested callables ("'ObjectProxy' object is not callable") and its
async client cannot share a process with Playwright's sync API, so a subprocess
is the only clean way for the suite to read ground truth.

Exits 1 when no orchestrator in the workspace answers get_training_status.
"""
import asyncio
import json
import pathlib
import sys

from hypha_rpc import connect_to_server

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from session import ui_token  # noqa: E402

SERVER_URL = "https://hypha.aicell.io"
WORKSPACE = "chiron-platform"


async def main():
    server = await connect_to_server(
        {"server_url": SERVER_URL, "token": ui_token(), "workspace": WORKSPACE}
    )
    try:
        for entry in await server.list_services():
            service_id = entry["id"] if isinstance(entry, dict) else entry.id
            # -rtc is the same app's WebRTC face, and the manager is not a run.
            if service_id.endswith("-rtc") or "manager" in service_id:
                continue
            try:
                service = await server.get_service(service_id)
                status = await service.get_training_status()
            except Exception:
                continue
            if isinstance(status, dict) and "target_round" in status:
                print(json.dumps({"service_id": service_id, **status}, default=str))
                return 0
    finally:
        try:
            await server.disconnect()
        except Exception:
            pass
    return 1


sys.exit(asyncio.run(main()))
