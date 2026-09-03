# Chiron runtime patches

`apply_runtime_patches.py` edits two installed third-party packages, `hypha_rpc`
and `bioengine`, inside the Chiron model images. It runs as the last build step
of each per-model Dockerfile, below the bioengine install, so a `BIOENGINE_REF`
bump re-applies everything against the fresh source.

There is one copy of this directory, here, and `chiron-base` stages it at
`/opt/chiron/patches/` without running it (the base installs neither package to
patch). Every model image, including `chiron-tabula` built in the tabula
repository, runs that baked copy. The tabula repo carries no patch files of its
own, because the script only rewrites site-packages and has no coupling to
either repository, so a second copy would only drift.

## Why patch in the image

`bioengine` is read-only from the Chiron side: bugs get surfaced upstream, not
edited in a Chiron repository. But a demo that cannot run is not a useful bug report, and
the same applies to `hypha_rpc`, which is a third repository again. Patching in
the image layer keeps the changes visible, versioned next to the Dockerfiles,
and removable one at a time.

Two properties are deliberate:

- **Exact-string anchors, not unified diffs.** A `patch(1)` hunk applied with
  fuzz can land in the wrong place after an upstream bump. An exact anchor
  either matches or it does not.
- **A missing anchor fails the build.** The failure mode worth engineering
  against is a version bump silently dropping a patch, with the original symptom
  resurfacing weeks later in a federated run. A red build is cheaper.

Each entry is idempotent via `applied_marker`, so re-running the script or
rebuilding is safe.

## How to review one

Every entry carries `kind`, `reason` and `remove_when`.

- `kind: fix` means we believe this is the correct change and would upstream it as
  written.
- `kind: workaround` means it buys a working demo, upstream should solve it
  differently.

To drop a patch, delete its entry and rebuild. To check whether upstream has
landed the real fix, read `remove_when`.
## The eight patches

In the order the script applies them. Each name links to its own section below,
which carries the symptom, the mechanism, the change and a `remove when`.

| # | Patch | Kind | Package | One line |
|---|-------|------|---------|----------|
| 1 | `hypha-rpc-webrtc-chunked-context` | fix | hypha_rpc | A chunked WebRTC message loses its `user` context and raises `KeyError: 'user'`. |
| 2 | `hypha-rpc-webrtc-identity` | fix | hypha_rpc | A peer call arrives with `user=None`, so the app cannot tell who is calling. |
| 3 | `hypha-rpc-webrtc-peer-builtin` | fix | hypha_rpc | The peer connection clobbers its own `built-in` service, silently downgrading to WebSocket. |
| 4 | `hypha-rpc-webrtc-method-timeout` | workaround | hypha_rpc | The 10 s default method timeout is shorter than a weight transfer. |
| 5 | `bioengine-proxy-health-check-window` | workaround | bioengine | Ray's outer 5 s window fires before `check_health` runs, restarting a live replica. |
| 6 | `bioengine-proxy-health-lookup-tolerance` | workaround | bioengine | One failed service lookup marks the replica unhealthy. |
| 7 | `bioengine-proxy-health-lookup-reset` | workaround | bioengine | The lookup failure counter never resets after a recovery. |
| 8 | `bioengine-pin-installed-version` | fix | bioengine | `runtime_env` rewrites `>=` to `==`, so Ray installs an older, unpatched `hypha_rpc` into every app venv and shadows the image copy. |

Patches 1 to 4 and 8 are what make WebRTC work at all. Patch 8 is the one that
made the others reachable: until it landed, every app venv silently ran an
unpatched `hypha_rpc`.

Patches 5 to 7 are about the same underlying disagreement, whether a busy
application counts as a dead replica. They are reported upstream as issues #164
and #165.

### Dropped patches

`bioengine-proxy-entry-health-tolerance` was dropped at the 0.16.1 bump. It gave
the entry-deployment health check a longer timeout and a consecutive-failure
tolerance so a saturated app was not deregistered on one 3 s miss. Upstream
issue #152 removed the blocking call entirely: `check_health` now reads each
sibling deployment's RUNNING replica count out of the Serve controller, so a
busy app neither blocks nor fails the probe. That is the patch's own
`remove_when`, so it went.

`hypha-rpc-webrtc-peer-workspace-answer` and
`hypha-rpc-webrtc-peer-workspace-use` were dropped at the `hypha_rpc` 0.21.47
pin. They were two halves of one change and only useful together. A WebRTC call
between two clients in different workspaces used to connect and then go silent
forever, because `get_rtc_service` addressed the peer in the caller's own
workspace while the answering peer had built its side of the channel in its own.
In Chiron that was every WebRTC run: the orchestrator connects with the
operator's token, so it sits in `ws-user-<id>` while the trainers sit in the
worker's workspace, and a run stayed in "Preparing" until the operator switched
to `websocket`. The patches read the workspace out of the answer payload, which
`_create_offer` already returned and the caller already received. Reported as
`hypha_rpc` issue #166 and fixed upstream in 0.21.47, which sets the answerer's
workspace immediately before `setRemoteDescription` and carries
`test_rtc_service_cross_workspace` as a regression test. That is the patches'
own `remove_when`, and `HYPHA_RPC_PIN` in `docker/versions.env` holds the floor
so a rebuild cannot resolve back below it.

---

## hypha-rpc-webrtc-chunked-context (fix)

`hypha_rpc/rpc.py`, `RPC._process_message`

**Symptom.** Every chunked message over a WebRTC data channel dies with
`KeyError: 'user'`.

**Mechanism.** `hypha_rpc` switches from an inline send to `_send_chunks` when
the packed message exceeds `_long_message_chunk_size + 1024`, which is
256 KB + 1024 B = 263168 B. The chunked path routes through the peer's
`built-in` `message_cache` service, and `_process_message` rebuilds the message
envelope from the transport context with an unconditional `context["user"]`.
`webrtc_client._setup_rpc` builds a default context holding only
`connection_type` and `ws`, so the key is never there.

**Evidence.** Measured on europa with both peers in one container:

```
    size                  webrtc               websocket
   256KB         ok True   0.05s         ok True   0.01s
   257KB     TimeoutError  26.0s         ok True   0.02s
   512KB     TimeoutError  25.1s         ok True   0.03s
```

The cliff sits exactly on the chunk boundary. WebSocket succeeds at every size
because the Hypha server injects `ctx` there.

**The change.** Fall back to the RPC's own `default_context` per field. That
preserves the trust property the original line exists for: envelope fields must
come from the local transport context, never from the peer-controlled packed
payload.

**Remove when** `hypha_rpc` ships a WebRTC context carrying `user`, or makes the
lookup tolerant upstream.

---

## hypha-rpc-webrtc-identity (fix)

`hypha_rpc/webrtc_client.py`, `_setup_rpc`

**Symptom.** None visible. This is the companion to the patch above.

**Mechanism.** With only the first patch, a chunked WebRTC message reassembles
with `user=None`, so anything downstream that authorizes on the caller sees an
anonymous request. The first patch would be a crash fix that quietly degrades
identity.

**The change.** Thread the authenticated user from the parent Hypha connection
into the peer RPC's default context, so a chunked WebRTC call carries the same
user a WebSocket call would.

**Remove when** `hypha_rpc` populates the WebRTC default context from the parent
connection itself.

---

## hypha-rpc-webrtc-peer-builtin (fix)

`hypha_rpc/webrtc_client.py`, `_create_offer.on_datachannel`

**Symptom.** Large **arguments** fail over WebRTC with
`AssertionError: Context is required` at `rpc.py:1274`. This is a different
defect from the two above, which cover large **return values**. Upload of 200 KB
succeeds, 512 KB fails 100 % of the time.

**Mechanism.** The answering peer does `rpc._services = server.rpc._services` to
expose the parent's services over the data channel. That also replaces the peer
RPC's own `built-in` service, so a chunked call resolves `message_cache` to the
WebSocket RPC's bound methods. Two things then break:

1. `_method_annotations` is per-RPC-instance and keyed by function object. Those
   bound methods carry no annotation on the peer RPC, so `require_context` reads
   as `False`, `_handle_method` never injects `kwargs["context"]`, and
   `_process_message` asserts on `context is None`.
2. Even with a context supplied, the message would reassemble into the WebSocket
   RPC's cache and fire there, so the reply to a WebRTC call would leave over the
   WebSocket.

Point 2 matters more than the crash for Chiron. The orchestrator deliberately has
no WebSocket fallback in `webrtc` mode, because silently degrading the transport
breaks the peer-to-peer guarantee the mode exists for.

There is a third, quieter consequence: any user service registered with
`require_context: True` currently receives no context at all over WebRTC. Same
root cause, one layer out.

**The change.** Keep the peer RPC's own `built-in`, re-point
`_object_store["services"]` at the new table (it is bound to the original dict at
construction, so rebinding `_services` alone desyncs method lookup from service
lookup), and copy the parent's method annotations so shared services keep
`require_context` and `run_in_executor`.

**Trade-off.** `_services` is copied rather than aliased, so services registered
on the parent *after* the data channel opens are not visible over that channel.
Aliasing is not available here: writing `built-in` back into a shared dict would
break the parent's own RPC. Chiron registers its services before the RTC service,
so this is not currently observable, but it is a real behaviour change.

**Remove when** `hypha_rpc` shares the parent's services with the peer RPC
without clobbering its `built-in` service and its method annotations.

---

## hypha-rpc-webrtc-method-timeout (workaround)

`hypha_rpc/webrtc_client.py`, `_setup_rpc`

**Symptom.** Weight transfers that take longer than 10 s fail even when the data
channel is healthy.

**Mechanism.** The WebRTC RPC defaults `method_timeout` to 10.0 s, against 30 s
for WebSocket. At the measured 7.6 MB/s on europa, that caps a single call at
roughly 76 MB, well under a full parameter blob.

**The change.** Read the default from `CHIRON_RTC_METHOD_TIMEOUT`, defaulting to
300 s. It is an environment variable rather than a call-site argument because the
orchestrator and the bioengine proxy are separate processes that each construct
their RTC RPC independently, and both ends have to agree without either passing
it explicitly.

**Why this is a workaround.** A fixed timeout is the wrong shape for a transfer
whose duration scales with model size. The right fix upstream is a heartbeat that
keeps a long call alive while bytes are still moving, which is what the chunked
path already does over WebSocket.

**Remove when** `hypha_rpc` heartbeats long WebRTC calls, or the transport
timeout becomes proportional to payload size.

---

## bioengine-proxy-health-check-window (workaround)

`bioengine/apps/proxy_deployment.py`, the `@deployment` decorator

**Symptom.** A proxy replica is restarted mid-round while the application inside
it is running normally. The controller says only:

```
Didn't receive health check response for replica Replica(id='1w2ll1eo',
  deployment='ProxyDeployment', app='noisy-frost-1098') after 5.0s,
  marking it unhealthy.
```

The trainer proxy comes back under a new pid, the orchestrator's handle to it is
stale, and the round it was in the middle of is lost.

**Mechanism.** The decorator declares `health_check_period_s=10` and
`health_check_timeout_s=5`. The second number is not a timeout inside
`check_health`. It is Ray Serve's wait for the actor to *return* from it. If the
replica's event loop does not get scheduled within five seconds, the window
closes before the method body runs at all.

That distinction is why this had to be a separate patch.
`bioengine-proxy-entry-health-tolerance` adds tolerance inside `check_health`,
and none of it can help: the method never executes. Worse, the two were
incoherent together, because a 30 s inner `wait_for` cannot complete inside a 5 s
outer window. Widening the outer window is what makes the inner tolerance
reachable.

**What blocks the loop.** Measured on `chiron-scgpt:0.7.1` during a WebRTC
federated run. Host load was 3.02 across 16 cores, so blanket CPU starvation does
not explain it. The misses cluster instead in the window where a round's weights
move, and they alternate between the two proxies in sender-then-receiver order:

```
11:50:48  start_fit OK
11:51:12  miss  noisy-frost-1098    (trainer proxy, sends weights)
11:51:23  miss  solitary-sea-2114   (orchestrator proxy, receives them)
11:51:31  miss  noisy-frost-1098
11:51:32  miss  solitary-sea-2114
```

The working explanation is that aiortc's SCTP and DTLS processing of a large
parameter blob runs on the same asyncio loop that answers health checks, so the
transfer starves the check for exactly as long as it takes. This is consistent
with the timing and with which replica misses when, though the fit occupies the
same window, so it is not proof.

**The change.** Read both values from the environment,
`CHIRON_HEALTH_CHECK_PERIOD` defaulting to 30 s and
`CHIRON_HEALTH_CHECK_TIMEOUT` to 60 s. The decorator is evaluated at import time
in the Ray actor, and `os` is already imported at the top of the module, so an
environment variable is the only lever that reaches it. The timeout must stay
above `CHIRON_ENTRY_HEALTH_TIMEOUT` for the two patches to compose.

**Remove when** the bulk transfer stops sharing a loop with the liveness check,
either because hypha-rpc moves WebRTC data handling off the main loop or because
bioengine answers health checks from somewhere that application traffic cannot
block. This is filed as a workaround, not a fix, because it does not address why
the loop stalls. It buys enough headroom that a normal transfer no longer looks
like a dead actor, at the cost of detecting a genuinely dead replica in tens of
seconds rather than five.

---
## bioengine-proxy-health-lookup-tolerance (workaround)

`bioengine/apps/proxy_deployment.py`, health check

**Symptom.** Trainer proxy replicas restart mid-round, the orchestrator's handle
goes stale, and the round fails.

**Mechanism.** bioengine 0.11.19 intermittently 404s on a pinned service lookup,
`<workspace>/<client_id>:<service_id>@*`, while the client-agnostic form
`<workspace>/*:<service_id>` resolves fine. The health check resolves the
replica's own pinned id; on failure it nulls `websocket_service_id` and raises,
so Ray restarts the replica, it re-registers under a new client id, and every
handle held by the orchestrator points at a service that no longer exists.

The tell is the asymmetry: the ping immediately above tolerates
`_MAX_CONSECUTIVE_PING_FAILURES` before declaring the replica unhealthy. The
lookup right below it gets no tolerance at all.

**The change.** Count consecutive lookup failures and stay healthy until the same
threshold the ping already uses.

**Why this is a workaround.** It hides an intermittent 404 rather than fixing it.
The real defect is in the lookup itself, tracked upstream.

**Remove when** the pinned lookup stops 404ing, or bioengine applies the ping's
tolerance policy to the lookup itself.

---

## bioengine-proxy-health-lookup-reset (workaround)

`bioengine/apps/proxy_deployment.py`, health check

Clears the counter introduced above on a successful check, so unrelated blips
hours apart never accumulate into a restart. Removes together with
`bioengine-proxy-health-lookup-tolerance`.

---

## bioengine-pin-installed-version (fix)

`bioengine/utils/requirements.py`, `normalize_requirement`

**Read this one first.** Without it none of the four `hypha_rpc` patches above
reach the code that actually runs an app, so they verify as present in the image
and still have no effect at runtime.

### Symptom

A federated round in `webrtc` mode fails on the first weight transfer:

```
WebRTC 'get_parameters' to '<workspace>/<client>:<trainer>' failed 3 times
RemoteError: ProxyDeployment._create_deployment_function.<locals>.deployment_function()
    missing 1 required keyword-only argument: 'context'
```

That is exactly the bug `hypha-rpc-webrtc-peer-builtin` fixes, observed on an
image where `grep -c "CHIRON PATCH"` confirmed the patch was present in
`/opt/conda/lib/python3.11/site-packages/hypha_rpc/webrtc_client.py`.

### Mechanism

The traceback does not point at the image's `site-packages`. It points into a
Ray `runtime_env` virtualenv:

```
/home/.bioengine/ray/session_.../runtime_resources/pip/<hash>/virtualenv/
    lib/python3.11/site-packages/hypha_rpc/rpc.py
```

bioengine declares `hypha-rpc>=0.21.40`. `normalize_requirement` rewrites `>=`
to `==`, so every app's `runtime_env.pip` list carries `hypha-rpc==0.21.40`.
The image resolved that floor to the newest release, 0.21.46. The two versions
differ, so Ray pip-installs a private, unpatched 0.21.40 into the app
virtualenv, and because the venv is created with `include-system-site-packages
= true` that private copy shadows the patched one.

The other two framework pins in the same list are unaffected purely by
coincidence:

| declared | floor | installed | installed into the venv |
|----------|-------|-----------|-------------------------|
| `hypha-rpc>=0.21.40` | 0.21.40 | 0.21.46 | yes, unpatched |
| `aiortc==1.14.0` | 1.14.0 | 1.14.0 | no |
| `pydantic~=2.12.0` | 2.12.0 | 2.12.0 | no |

So the version skew is not a design choice about isolation. It is an accident of
which operator each dependency happened to be declared with, and it silently
undoes any local patch to a `>=`-declared package.

`normalize_requirement`'s own docstring states the intent: resolve
"deterministically to the same version the driver has". Reading the specifier
does not do that. Reading `importlib.metadata.version()` does.

### The change

Resolve the pin from the installed distribution:

```python
name = split_re.split(requirement, maxsplit=1)[0].strip()
base = name.split("[", 1)[0].strip()
if base:
    try:
        return f"{name}=={md.version(base)}"
    except md.PackageNotFoundError:
        pass
```

It falls through to the original string rewrite when the distribution is not
installed, so a requirement naming something absent behaves as before rather
than raising during a deploy.

### Evidence it works

Before, the app venv held `hypha_rpc-0.21.40.dist-info` and nothing else beyond
pip and setuptools. After, the venv holds only pip and setuptools: every
framework pin is already satisfied by system site-packages, nothing is
installed, and the app imports the patched `hypha_rpc` 0.21.46. Cold-start also
gets cheaper, since Ray no longer builds and populates a venv per app.

### Remove when

bioengine resolves `runtime_env` pins from `importlib.metadata.version()` rather
than from the declared specifier, or moves to the lock files the `TODO` at the
top of `utils/requirements.py` already calls for.

### Scope note

This changes the pin for **every** dependency bioengine injects into an app's
`runtime_env`, not just `hypha_rpc`. That is the point (a locally patched
package of any name is now inherited by app venvs), but it does mean an app
whose author expected the declared floor now gets whatever the worker has. Given
the declarations are `>=`, that is the semantics they already asked for.

---

## What is not patched here

The pinned-lookup 404 also has a caller-side half in Chiron itself:
`FlowerClientProxy._rtc_service_id` derives from the pinned cid, the form that
404s, while `_ws_lookup_id` correctly uses `_client_agnostic_service_id()`. That
is Chiron code and belongs in `apps/chiron_orchestrator/`, not in a third-party
patch.
