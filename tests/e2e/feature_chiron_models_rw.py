"""Targeted test for chiron-platform/chiron-models being readable AND writable
by any authenticated user.

Verifies that the collection's `config.permissions` is `{"*": "rw+"}` (or
equivalent) so that a user-scoped token without chiron-platform workspace
membership can publish a model artifact into the Chiron Model Hub. This is
the permission posture needed for orchestrator save_global_weights and
trainer save_model_weights to succeed when those apps run with the user's
own token (rather than a chiron-platform service-account token).

Test creates a tiny throwaway artifact inside chiron-models, uploads a
placeholder file, commits, reads it back, and deletes it.

Usage:
    python tests/e2e/feature_chiron_models_rw.py
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import httpx
from hypha_rpc import connect_to_server

HYPHA_BASE = "https://hypha.aicell.io"
COLLECTION = "chiron-platform/chiron-models"

ENV_PATH = Path(__file__).resolve().parent.parent.parent.parent / "tabula" / ".env"


def load_token() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"Cannot find token file at {ENV_PATH}")
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith("PERSONAL_HYPHA_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit(f"PERSONAL_HYPHA_TOKEN= not found in {ENV_PATH}")


TOKEN = load_token()
FAILURES = []


def check(ok, msg, fail_msg):
    if ok:
        print(f"   ✓ {msg}")
    else:
        print(f"   ✗ FAIL: {fail_msg}")
        FAILURES.append(fail_msg)


async def main():
    server = await connect_to_server({"server_url": HYPHA_BASE, "token": TOKEN})
    user = server.config.user or {}
    user_id = user.get("id") or ""
    user_email = user.get("email") or ""
    print(f"caller user_id={user_id!r} email={user_email!r}")
    print(f"caller workspace = {server.config.workspace}")

    am = await server.get_service("public/artifact-manager")

    # 1) Check the collection's permissions
    coll = await am.read(COLLECTION)
    perms = (coll.get("config") or {}).get("permissions")
    print(f"   {COLLECTION} permissions = {perms}")
    flat = perms or {}
    star = flat.get("*") if isinstance(flat, dict) else None
    check(star in ("rw+", "rw", "admin"),
          f"chiron-models config.permissions['*'] grants write (got {star!r})",
          f"chiron-models config.permissions['*'] = {star!r}, expected 'rw+' / 'rw' / 'admin'")

    # 2) Try to create a throwaway artifact as the user
    alias = f"e2e-rw-probe-{int(time.time())}"
    artifact_id = None
    try:
        info = await am.create(
            type="model",
            parent_id=COLLECTION,
            alias=alias,
            manifest={
                "name": f"E2E rw+ probe {alias}",
                "description": "throwaway artifact, will be deleted",
            },
            stage=True,
        )
        artifact_id = info["id"]
        print(f"   ✓ created {artifact_id} as user")
    except Exception as e:
        check(False, "user can create artifact in chiron-models",
              f"create raised: {str(e)[:200]}")

    # 3) Upload a tiny placeholder file
    if artifact_id:
        try:
            put_url = await am.put_file(artifact_id=artifact_id, file_path="probe.txt")
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.put(put_url, content=b"probe\n")
                r.raise_for_status()
            await am.commit(artifact_id=artifact_id)
            print(f"   ✓ uploaded + committed probe.txt")
        except Exception as e:
            check(False, "user can upload + commit probe.txt",
                  f"upload/commit raised: {str(e)[:200]}")

    # 4) Read it back
    if artifact_id:
        try:
            art = await am.read(artifact_id=artifact_id)
            cb = art.get("created_by")
            print(f"   ✓ artifact created_by = {cb!r}")
        except Exception as e:
            check(False, "user can read artifact back",
                  f"read raised: {str(e)[:200]}")

    # 5) Cleanup
    if artifact_id:
        try:
            await am.delete(artifact_id=artifact_id, delete_files=True)
            print(f"   ✓ deleted {artifact_id}")
        except Exception as e:
            print(f"   ✗ cleanup delete failed: {str(e)[:200]}")

    await server.disconnect()

    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)} failure(s):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("✓ all checks passed (chiron-models is rw+ for the user)")


if __name__ == "__main__":
    asyncio.run(main())
