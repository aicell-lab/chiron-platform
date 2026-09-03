#!/usr/bin/env python
"""Apply Chiron's local patches to installed third-party packages.

Why this exists
---------------
Chiron depends on `bioengine` and `hypha_rpc`, both of which are developed in
other repositories. CLAUDE.md marks the bioengine repo read-only from the
Chiron side: bugs get surfaced upstream, not edited in place. But a demo that
cannot run is not a useful bug report, so the fixes live here, in the image
layer, where they are visible, versioned and trivially removable.

Every patch below is an entry in PATCHES with a `reason` and a `remove_when`.
Read worker/docker/patches/README.md for the full write-up of each. The intent is
that these get reviewed one at a time and dropped as upstream lands the real
fix, so nothing here should ever become load-bearing without a note saying so.

Design notes
------------
Anchors are exact source strings rather than line numbers or unified diffs.
A `patch(1)` hunk with fuzz can apply to the wrong place after an upstream
bump; an exact anchor either matches or it does not. If an anchor is missing
this script FAILS THE BUILD rather than warning, because the failure mode we
care about is a version bump silently dropping a patch and the demo breaking
weeks later with the original symptom. `applied_marker` makes each patch
idempotent so a rebuild or a re-run is safe.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

# --------------------------------------------------------------------------
# Patch definitions
# --------------------------------------------------------------------------
# kind:
#   "fix"        : we believe this is the correct change and would upstream it
#   "workaround" : buys us a working demo, upstream should solve it differently

PATCHES = [
    {
        "id": "hypha-rpc-webrtc-chunked-context",
        "kind": "fix",
        "package": "hypha_rpc",
        "file": "rpc.py",
        "reason": (
            "Chunked messages fail over WebRTC with KeyError: 'user'. "
            "_process_message rebuilds the message envelope from the transport "
            "context and dereferences context['user'] unconditionally, but "
            "webrtc_client._setup_rpc builds a default context containing only "
            "connection_type and ws. Any payload over the 256 KB chunk "
            "threshold therefore dies on reassembly, which is every federated "
            "weight transfer. Measured: <=256 KB succeeds in 0.05 s, 257 KB "
            "and above fails 100% of the time, while WebSocket handles all "
            "sizes. Falling back to the LOCAL default context preserves the "
            "trust property the original line exists for (envelope fields must "
            "not come from the attacker-controlled packed payload)."
        ),
        "remove_when": (
            "hypha_rpc ships a WebRTC context carrying 'user', or makes this "
            "lookup tolerant upstream."
        ),
        "anchor": '''        main.update(
            {
                "from": context["from"],
                "to": context["to"],
                "ws": context["ws"],
                "user": context["user"],
            }
        )''',
        "replacement": '''        # CHIRON PATCH hypha-rpc-webrtc-chunked-context
        # These fields must come from the trusted transport context rather
        # than the packed payload, which the peer controls. The WebRTC
        # connection's default context has no 'user' key (see
        # webrtc_client._setup_rpc), so a strict lookup makes every chunked
        # message over a data channel fail with KeyError: 'user'. Fall back
        # to this RPC's own default_context, which is local and trusted, and
        # never to the unpacked payload.
        _trusted = dict(self.default_context or {})
        main.update(
            {
                "from": context.get("from", _trusted.get("from")),
                "to": context.get("to", _trusted.get("to")),
                "ws": context.get("ws", _trusted.get("ws")),
                "user": context.get("user", _trusted.get("user")),
            }
        )''',
        "applied_marker": "CHIRON PATCH hypha-rpc-webrtc-chunked-context",
    },
    {
        "id": "hypha-rpc-webrtc-identity",
        "kind": "fix",
        "package": "hypha_rpc",
        "file": "webrtc_client.py",
        "reason": (
            "Companion to hypha-rpc-webrtc-chunked-context. That patch stops "
            "the crash by falling back to default_context, but over WebRTC "
            "default_context has no user either, so the reassembled envelope "
            "carries user=None and anything downstream that authorizes on it "
            "sees an anonymous caller. The parent Hypha connection already "
            "holds the authenticated identity in server.config.user, so thread "
            "it into the peer RPC's default context. Without this the first "
            "patch is a crash fix that quietly degrades identity; with it, a "
            "chunked WebRTC call carries the same user a WebSocket call would."
        ),
        "remove_when": (
            "hypha_rpc populates the WebRTC default context from the parent "
            "connection itself."
        ),
        "anchor": '''    config["context"] = config.get("context") or {}
    config["context"]["connection_type"] = "webrtc"
    config["context"]["ws"] = config.get("workspace")''',
        "replacement": '''    config["context"] = config.get("context") or {}
    config["context"]["connection_type"] = "webrtc"
    config["context"]["ws"] = config.get("workspace")
    # CHIRON PATCH hypha-rpc-webrtc-identity
    # Carry the authenticated user from the parent Hypha connection onto the
    # peer RPC. Without it every chunked WebRTC message reassembles with
    # user=None (see the chunked-context patch, which falls back to exactly
    # this dict) and downstream authorization sees an anonymous caller.
    if config.get("user") is not None:
        config["context"].setdefault("user", config["user"])''',
        "applied_marker": "CHIRON PATCH hypha-rpc-webrtc-identity",
    },
    {
        "id": "hypha-rpc-webrtc-peer-builtin",
        "kind": "fix",
        "package": "hypha_rpc",
        "file": "webrtc_client.py",
        "reason": (
            "Large ARGUMENTS fail over WebRTC with AssertionError: Context is "
            "required, a different defect from the large-RETURN-VALUE one the "
            "chunked-context patch fixes. The answering peer does "
            "`rpc._services = server.rpc._services` to expose the parent's "
            "services over the data channel. That also replaces the peer RPC's "
            "own `built-in` service, so a chunked call resolves message_cache "
            "to the WEBSOCKET RPC's bound methods. Two things then break. "
            "First, _method_annotations is per-RPC-instance and keyed by "
            "function object, so those bound methods carry no annotation on "
            "the peer RPC, require_context is read as False, _handle_method "
            "never injects kwargs['context'], and _process_message asserts on "
            "context is None. Second, even with context supplied the message "
            "would reassemble into the websocket RPC's cache and fire there, "
            "so the reply to a WebRTC call would leave over the WebSocket. "
            "For Chiron that is worse than the crash: the orchestrator "
            "deliberately has no WebSocket fallback in webrtc mode, because "
            "silently degrading the transport breaks the peer-to-peer "
            "guarantee the mode exists for. Measured: upload of 200 KB "
            "succeeds, 512 KB fails 100% of the time. Keeping the peer RPC's "
            "own built-in fixes both. Copying the parent's method annotations "
            "is the same bug one layer out: any user service registered with "
            "require_context=True currently receives no context at all over "
            "WebRTC, silently."
        ),
        "remove_when": (
            "hypha_rpc shares the parent's services with the peer RPC without "
            "clobbering its built-in service and its method annotations."
        ),
        "anchor": '''            # Map all the local services to the webrtc client
            rpc._services = server.rpc._services''',
        "replacement": '''            # CHIRON PATCH hypha-rpc-webrtc-peer-builtin
            # Map all the local services to the webrtc client, but keep this
            # peer RPC's OWN `built-in` service. built-in owns the message
            # cache and the require_context annotations that chunked (>256 KB)
            # messages depend on, and _method_annotations is per-RPC-instance
            # and keyed by function object. Handing the peer the websocket
            # RPC's built-in therefore loses require_context (context is never
            # injected, _process_message asserts) and would reassemble the
            # payload on the wrong RPC, sending the reply back over the
            # WebSocket instead of the data channel.
            #
            # Note the trade-off: _services is copied rather than aliased, so
            # services registered on the parent AFTER the data channel opens
            # are not visible over this channel. Aliasing is not an option
            # here because writing built-in back into a shared dict would
            # break the parent's own RPC.
            _own_builtin = rpc._services.get("built-in")
            rpc._services = dict(server.rpc._services)
            if _own_builtin is not None:
                rpc._services["built-in"] = _own_builtin
            # _object_store["services"] is bound to the original dict at
            # construction, so rebinding _services alone desyncs method
            # lookup from service lookup.
            rpc._object_store["services"] = rpc._services
            # Annotations live on the parent RPC; without them every shared
            # service loses require_context and run_in_executor over WebRTC.
            rpc._method_annotations.update(server.rpc._method_annotations)''',
        "applied_marker": "CHIRON PATCH hypha-rpc-webrtc-peer-builtin",
    },
    {
        "id": "hypha-rpc-webrtc-method-timeout",
        "kind": "workaround",
        "package": "hypha_rpc",
        "file": "webrtc_client.py",
        "reason": (
            "The WebRTC RPC hardcodes a 10 s default method timeout while the "
            "WebSocket RPC uses 30 s. Weight transfer is the whole point of "
            "the RTC path and routinely exceeds 10 s once payloads reach "
            "model-shard size, so the default guarantees a mid-round timeout "
            "on any non-trivial model. Making it env-tunable rather than "
            "hardcoding a bigger number keeps the knob visible and lets the "
            "orchestrator and the bioengine proxy (which construct their RTC "
            "RPCs independently, in different processes) agree on one value "
            "without either passing it explicitly."
        ),
        "remove_when": (
            "The orchestrator and bioengine both pass method_timeout "
            "explicitly into their RTC configs, or hypha_rpc raises the "
            "default to match WebSocket."
        ),
        "anchor": '        method_timeout=config.get("method_timeout", 10.0),',
        "replacement": '''        # CHIRON PATCH hypha-rpc-webrtc-method-timeout
        # 10.0 upstream. Weight blobs legitimately outlive that, and both
        # peers must agree, so read a shared env default when the caller did
        # not pass one explicitly.
        method_timeout=config.get(
            "method_timeout",
            float(__import__("os").environ.get("CHIRON_RTC_METHOD_TIMEOUT", "300")),
        ),''',
        "applied_marker": "CHIRON PATCH hypha-rpc-webrtc-method-timeout",
    },
    {
        "id": "bioengine-proxy-health-check-window",
        "kind": "workaround",
        "package": "bioengine",
        "file": "apps/proxy_deployment.py",
        "reason": (
            "ProxyDeployment hardcodes health_check_period_s=10 and "
            "health_check_timeout_s=5. The 5s is Ray Serve's wait for "
            "check_health to RETURN, so it fires before anything inside the "
            "method runs and no amount of tolerance in the body can survive "
            "it. Measured on chiron-scgpt:0.7.1: during the round 0 to "
            "round 1 transition of a single-worker federated run, the "
            "trainer's fit and the orchestrator's weight aggregation "
            "saturated the container's CPUs and the controller logged "
            "\"Didn't receive health check response ... after 5.0s\" for "
            "BOTH proxy replicas four times in eleven seconds, restarting "
            "the trainer proxy mid-round. Two replicas failing in the same "
            "second is contention, not two coincident application faults. "
            "This patch is also what makes "
            "bioengine-proxy-entry-health-tolerance coherent: that entry "
            "timeout defaults to 30s, which cannot complete inside a 5s "
            "outer window."
        ),
        "remove_when": (
            "bioengine exposes the health check window per app, or sizes it "
            "from what the entry deployment does. A 0-CPU bridge fronting a "
            "GPU training job needs a different window from one fronting an "
            "inference endpoint, and only the app knows which it is."
        ),
        "anchor": '''    max_ongoing_requests=10,
    health_check_period_s=10,
    health_check_timeout_s=5,''',
        "replacement": '''    max_ongoing_requests=10,
    # CHIRON PATCH bioengine-proxy-health-check-window
    # Upstream: period 10s, timeout 5s. The timeout is Ray Serve's wait for
    # check_health to return, so under CPU contention it fires before the
    # method body executes and the replica is restarted while perfectly
    # alive. A federated trainer saturating the box is normal operation,
    # not a fault, and a restart there costs the orchestrator its handle
    # mid-round. Must stay above CHIRON_ENTRY_HEALTH_TIMEOUT (default 30s)
    # or the inner wait can never complete inside the outer window.
    # Trade-off: a genuinely dead replica is now detected in tens of
    # seconds rather than five.
    health_check_period_s=float(os.environ.get("CHIRON_HEALTH_CHECK_PERIOD", "30")),
    health_check_timeout_s=float(os.environ.get("CHIRON_HEALTH_CHECK_TIMEOUT", "60")),''',
        "applied_marker": "CHIRON PATCH bioengine-proxy-health-check-window",
    },
    {
        "id": "bioengine-proxy-health-lookup-tolerance",
        "kind": "workaround",
        "package": "bioengine",
        "file": "apps/proxy_deployment.py",
        "reason": (
            "A single failed service lookup restarts the replica, and on "
            "bioengine 0.11.19 that lookup fails intermittently for reasons "
            "outside this deployment's control: resolving the pinned form "
            "<client_id>:<service>@* returns 'Service not found' while the "
            "client-agnostic *:<service> form resolves fine with the same "
            "token (measured: curl 15/15 200 on the pinned URL from the shell "
            "while the replica's own lookup 404s). The health check reacts by "
            "nulling websocket_service_id and raising, so Ray Serve restarts "
            "the replica, it re-registers under a new client id, and every "
            "handle the orchestrator holds goes stale mid-round. "
            "The asymmetry is the tell: the ping immediately above this "
            "already tolerates _MAX_CONSECUTIVE_PING_FAILURES before "
            "concluding the socket is dead, with a comment about bridge tail "
            "latency. The service lookup travels the same transport and gets "
            "no tolerance at all. This applies the same policy to both."
        ),
        "remove_when": (
            "bioengine fixes the pinned-service-lookup failure upstream "
            "(issue filed), after which a single lookup failure is once again "
            "meaningful and the tolerance only delays a real restart."
        ),
        "anchor": '''        except Exception as e:
            logger.error(
                f"❌ WebSocket service connection failed for '{self.application_id}': {e}"
            )
            # Reset service ID to trigger re-registration on next call
            self.websocket_service_id = None
            raise RuntimeError("WebSocket service connection failed")''',
        "replacement": '''        except Exception as e:
            # CHIRON PATCH bioengine-proxy-health-lookup-tolerance
            # Upstream drops the replica on the FIRST failed lookup. The ping
            # above tolerates _MAX_CONSECUTIVE_PING_FAILURES over the same
            # transport; a lookup is no more trustworthy than a ping, and on
            # 0.11.19 the pinned-id lookup fails transiently while the service
            # is demonstrably alive. Restarting here costs the orchestrator
            # its handle mid-round, so require the same consecutive-failure
            # evidence before concluding the registration is gone.
            self._consecutive_lookup_failures = (
                getattr(self, "_consecutive_lookup_failures", 0) + 1
            )
            if self._consecutive_lookup_failures < _MAX_CONSECUTIVE_PING_FAILURES:
                logger.warning(
                    f"⚠️ WebSocket service lookup failed "
                    f"({self._consecutive_lookup_failures}/"
                    f"{_MAX_CONSECUTIVE_PING_FAILURES}) for "
                    f"'{self.application_id}', keeping replica healthy, "
                    f"will re-check next tick: {e}"
                )
                return
            logger.error(
                f"❌ WebSocket service connection failed for '{self.application_id}' "
                f"{self._consecutive_lookup_failures} times consecutively: {e}"
            )
            self._consecutive_lookup_failures = 0
            # Reset service ID to trigger re-registration on next call
            self.websocket_service_id = None
            raise RuntimeError("WebSocket service connection failed")''',
        "applied_marker": "CHIRON PATCH bioengine-proxy-health-lookup-tolerance",
    },
    {
        "id": "bioengine-proxy-health-lookup-reset",
        "kind": "workaround",
        "package": "bioengine",
        "file": "apps/proxy_deployment.py",
        "reason": (
            "Bookkeeping half of bioengine-proxy-health-lookup-tolerance. "
            "Without clearing the counter on success, transient failures "
            "accumulate across the deployment's whole lifetime and the Nth "
            "unrelated blip restarts the replica. The ping path clears its "
            "counter on recovery for the same reason."
        ),
        "remove_when": "Together with bioengine-proxy-health-lookup-tolerance.",
        "anchor": '''            logger.debug(f"WebSocket service '{self.websocket_service_id}' check passed.")''',
        "replacement": '''            logger.debug(f"WebSocket service '{self.websocket_service_id}' check passed.")
            # CHIRON PATCH bioengine-proxy-health-lookup-reset
            # Consecutive means consecutive. Clear on success so unrelated
            # blips hours apart never add up to a restart.
            if getattr(self, "_consecutive_lookup_failures", 0):
                logger.info(
                    f"✅ WebSocket service lookup recovered for "
                    f"'{self.application_id}' after "
                    f"{self._consecutive_lookup_failures} transient failure(s)."
                )
                self._consecutive_lookup_failures = 0''',
        "applied_marker": "CHIRON PATCH bioengine-proxy-health-lookup-reset",
    },
    {
        "id": "bioengine-pin-installed-version",
        "kind": "fix",
        "package": "bioengine",
        "file": "utils/requirements.py",
        "reason": (
            "Without this, none of the four hypha_rpc patches above reach the "
            "code that actually runs an app. bioengine declares "
            "'hypha-rpc>=0.21.40' and normalize_requirement rewrites '>=' to "
            "'==', so "
            "every app's runtime_env pip list carries 'hypha-rpc==0.21.40' "
            "regardless of what the worker has installed. The image ships "
            "0.21.46 (pip resolved the floor to the newest release), so Ray "
            "builds a virtualenv and pip-installs a private, unpatched 0.21.40 "
            "into it, which shadows the patched copy in system site-packages. "
            "Measured on chiron-scgpt:0.7.1: the venv installs hypha_rpc but "
            "NOT aiortc or pydantic, because those two are declared '==1.14.0' "
            "and '~=2.12.0' whose floors happen to equal the installed versions "
            "and are therefore already satisfied. The skew is not a design "
            "choice, it is an accident of which operator each dependency was "
            "declared with. normalize_requirement's own docstring states the "
            "intent plainly, to resolve 'to the same version the driver has'; "
            "reading the installed version is what actually achieves that. "
            "Symptom this produced: WebRTC weight transfer failed with "
            "'deployment_function() missing 1 required keyword-only argument: "
            "context', the exact bug hypha-rpc-webrtc-peer-builtin fixes, on an "
            "image where that patch was verified present in site-packages."
        ),
        "remove_when": (
            "bioengine resolves runtime_env pins from "
            "importlib.metadata.version() rather than from the declared "
            "specifier, or moves to the lock files its own TODO in "
            "utils/requirements.py already calls for."
        ),
        "anchor": '''    # Replace >=, <=, ~= with == for reproducibility
    requirement = requirement.replace(">=", "==")
    requirement = requirement.replace("<=", "==")
    requirement = requirement.replace("~=", "==")''',
        "replacement": '''    # CHIRON PATCH bioengine-pin-installed-version
    # Pin to the version this worker actually has, not to the lower bound
    # written in the specifier. Collapsing ">=X" to "==X" pins app venvs
    # to the floor, which differs from the installed version for every
    # dependency declared with ">=" that has a newer release available.
    # Ray then pip-installs that older copy into the app virtualenv,
    # where it shadows system site-packages (the venv is created with
    # system-site-packages on) and silently replaces any locally patched
    # module.
    #
    # Falls through to the original string rewrite when the distribution
    # is not installed, so a requirement naming something absent behaves
    # as before rather than raising during a deploy.
    name = split_re.split(requirement, maxsplit=1)[0].strip()
    base = name.split("[", 1)[0].strip()
    if base:
        try:
            return f"{name}=={md.version(base)}"
        except md.PackageNotFoundError:
            pass

    # Replace >=, <=, ~= with == for reproducibility
    requirement = requirement.replace(">=", "==")
    requirement = requirement.replace("<=", "==")
    requirement = requirement.replace("~=", "==")''',
        "applied_marker": "CHIRON PATCH bioengine-pin-installed-version",
    },
]


def package_dir(name: str) -> pathlib.Path:
    spec = importlib.util.find_spec(name)
    if spec is None or not spec.origin:
        raise SystemExit(f"FATAL: package '{name}' is not installed")
    return pathlib.Path(spec.origin).parent


def main() -> int:
    only = set(sys.argv[1:])
    applied, skipped = [], []

    for p in PATCHES:
        if only and p["id"] not in only:
            continue
        target = package_dir(p["package"]) / p["file"]
        if not target.exists():
            raise SystemExit(f"FATAL [{p['id']}]: {target} does not exist")

        src = target.read_text()

        if p["applied_marker"] in src:
            skipped.append(p["id"])
            print(f"  = {p['id']}: already applied")
            continue

        if p["anchor"] not in src:
            # Loud on purpose. A silently skipped patch means the demo breaks
            # later with the original symptom and no obvious cause.
            raise SystemExit(
                f"FATAL [{p['id']}]: anchor not found in {target}.\n"
                f"  The upstream source changed. Re-read the function and\n"
                f"  either update the anchor or drop the patch if the bug is\n"
                f"  fixed upstream.\n"
                f"  Reason this patch exists: {p['reason'][:200]}..."
            )

        if src.count(p["anchor"]) != 1:
            raise SystemExit(
                f"FATAL [{p['id']}]: anchor matches {src.count(p['anchor'])} "
                f"times in {target}; it must match exactly once."
            )

        target.write_text(src.replace(p["anchor"], p["replacement"]))
        applied.append(p["id"])
        print(f"  + {p['id']} ({p['kind']}) -> {p['package']}/{p['file']}")

    print(f"\nchiron runtime patches: {len(applied)} applied, "
          f"{len(skipped)} already present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
