"""Browser session, screenshots and ground truth for the UI end-to-end suite.

The suite drives the real platform against a real BioEngine worker, so the
helpers here are shaped by what actually goes wrong in that setting rather than
by what a mocked page would need:

* the UI logs itself in from localStorage, so seeding the token before the
  first paint skips an interactive OAuth flow a headless run cannot complete
* a failed poll empties a list the page derives its buttons from, so "not there
  yet" and "not there at all" have to be told apart by waiting rather than by a
  single read
* the browser is not a reliable witness to what the federation did, so the
  orchestrator's own counters are queried directly when the two disagree
"""
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import time

# A forwarded X11 display hangs headless screenshots.
os.environ.pop("DISPLAY", None)

BASE_URL = os.environ.get("CHIRON_URL", "http://localhost:3000")
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
SHOTS = pathlib.Path(
    os.environ.get("CHIRON_SHOTS", REPO_ROOT / "tests" / "e2e" / "screenshots")
)
# The companion tabula checkout, which CLAUDE.md places next to this repo,
# is where the worker and orchestrator credentials already live. Point
# CHIRON_ENV_FILE somewhere else, or set CHIRON_UI_TOKEN directly, if your
# checkout is laid out differently.
ENV_FILE = os.environ.get("CHIRON_ENV_FILE", str(REPO_ROOT.parent / "tabula" / ".env"))


def read_env(path=ENV_FILE):
    """Key/value pairs out of a dotenv file, without importing dotenv."""
    env = {}
    text = pathlib.Path(path).read_text() if pathlib.Path(path).exists() else ""
    for line in text.splitlines():
        match = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if match:
            env[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    return env


def ui_token():
    """The token the browser session logs in with.

    The UI mints a child token for every app it launches (`server.generateToken`
    in Training.tsx), and Hypha only lets an admin-scoped token do that. A token
    scoped read_write on a personal workspace fails there, so this is the
    workspace admin token, which is also where the worker and the run artifacts
    live. CHIRON_UI_TOKEN overrides it.
    """
    env = read_env()
    token = os.environ.get("CHIRON_UI_TOKEN") or env.get("CHIRON_UI_TOKEN") or env.get("HYPHA_TOKEN")
    if not token:
        raise RuntimeError(
            f"No token. Set CHIRON_UI_TOKEN, or put HYPHA_TOKEN in {ENV_FILE}."
        )
    return token


class Session:
    """A logged-in page plus the screenshot counter for one model's run."""

    def __init__(self, page, browser, model_slug, outdir):
        self.page = page
        self.browser = browser
        self.model = model_slug
        self.outdir = outdir
        self._n = 0

    def shot(self, name, full_page=True):
        """Capture the page and number it in stage order."""
        self._n += 1
        path = self.outdir / f"{self._n:02d}-{name}.png"
        try:
            # animations="disabled" freezes the status spinners, so the capture
            # is not waiting on a page that repaints every frame.
            self.page.screenshot(path=str(path), full_page=full_page,
                                 animations="disabled", timeout=30_000)
        except Exception:
            # A full-page capture of a very tall page can exceed the timeout.
            # The viewport alone still shows what the stage did.
            self.page.screenshot(path=str(path), animations="disabled", timeout=30_000)
        print(f"[shot] {path}", flush=True)
        return path

    def goto(self, route, wait_text=None, timeout=120_000):
        self.page.goto(f"{BASE_URL}/#{route}", wait_until="domcontentloaded")
        if wait_text:
            self.page.wait_for_selector(f"text={wait_text}", timeout=timeout)
        self.page.wait_for_timeout(2500)


def open_session(playwright, model_slug, token, fresh=True, headed=False):
    """A browser already logged in, pointed at a clean screenshot directory."""
    browser = playwright.chromium.launch(args=["--no-sandbox"], headless=not headed)
    ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
    # LoginButton stores tokenExpiry as an ISO string and revives it with
    # `new Date(...)`, so a millisecond epoch reads back as Invalid Date and the
    # auto-login silently declines to fire.
    expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=6)
    ctx.add_init_script(
        "window.localStorage.setItem('token', %r);"
        "window.localStorage.setItem('tokenExpiry', %r);"
        % (token, expiry.isoformat().replace("+00:00", "Z"))
    )
    page = ctx.new_page()
    page.set_default_timeout(60_000)

    outdir = SHOTS / model_slug
    if fresh:
        import shutil
        shutil.rmtree(outdir, ignore_errors=True)
    outdir.mkdir(parents=True, exist_ok=True)

    session = Session(page, browser, model_slug, outdir)
    attach_diagnostics(page)
    return session


def attach_diagnostics(page):
    """Log browser-side failures a screenshot cannot show.

    `Failed to fetch` in the UI is a bare TypeError with no cause attached, so
    Chromium's own net error text, which arrives on `requestfailed`, is the only
    way to learn why a call to the Hypha server died.
    """
    def on_failed(req):
        if "hypha" not in req.url:
            return
        print(f"  NETFAIL {req.method} {req.url[:160]} -> {req.failure or '?'}", flush=True)

    def on_response(resp):
        # requestfailed only fires when the request never completed, so an HTTP
        # 500 is a completed request and arrives here instead.
        if resp.status >= 400:
            print(f"  HTTP{resp.status} {resp.request.method} {resp.url[:160]}", flush=True)

    page.on("requestfailed", on_failed)
    page.on("response", on_response)
    page.on("pageerror", lambda e: print(f"  PAGEERROR {e}", flush=True))
    page.on("console", lambda m: print(f"  CONSOLE[{m.type}] {m.text[:300]}", flush=True)
            if m.type == "error" else None)


def dismiss_error(page, shot=None, tag="error"):
    """Close the error modal if one is up. Returns its title, or None.

    The modal is a full-screen overlay, so anything left open swallows the next
    click on the page underneath.
    """
    heading = page.locator("div.fixed.inset-0 h3").first
    close = page.get_by_role("button", name="Close", exact=True)
    if close.count() == 0 or not close.first.is_visible():
        return None
    title = heading.inner_text().strip() if heading.count() else "?"
    detail = ""
    body = page.locator("div.fixed.inset-0 p.whitespace-pre-wrap").first
    if body.count():
        detail = body.inner_text().strip()
    print(f"  MODAL {title}: {detail[:300]}", flush=True)
    if shot:
        shot(tag)
    close.first.click()
    page.wait_for_timeout(500)
    return title


def wait_for(page, predicate, timeout_s, what, poll_ms=3000):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        page.wait_for_timeout(poll_ms)
    raise TimeoutError(f"timed out after {timeout_s}s waiting for {what}")


def appeared(page, count_fn, grace_s, what):
    """True as soon as `count_fn()` is non-zero, False if it stays zero.

    Worker info arrives asynchronously and one poll can die on a transient
    network blip, so an empty list right after a step change means "not loaded
    yet" at least as often as it means "nothing there". Deciding to deploy off
    that read is how a duplicate orchestrator gets created.
    """
    deadline = time.time() + grace_s
    while True:
        if count_fn() > 0:
            return True
        if time.time() >= deadline:
            print(f"  [none] no {what} after {grace_s}s, will deploy one", flush=True)
            return False
        page.wait_for_timeout(3000)


def dump_controls(page, tag):
    """Every visible control on the page, for diagnosing a selector that moved."""
    print(f"\n----- visible controls: {tag} -----", flush=True)
    for button in page.query_selector_all("button"):
        text = (button.inner_text() or "").strip().replace("\n", " | ")
        if text and button.is_visible():
            state = "" if button.is_enabled() else "(disabled) "
            print(f"  BTN {state}{text[:120]}", flush=True)
    for select in page.query_selector_all("select"):
        if select.is_visible():
            options = [o.inner_text().strip() for o in select.query_selector_all("option")]
            print(f"  SELECT {options}", flush=True)
    for field in page.query_selector_all("input, textarea"):
        if field.is_visible():
            value = field.evaluate(
                "e => e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value")
            print(f"  <{field.evaluate('e=>e.tagName')}> type={field.get_attribute('type')!r} "
                  f"ph={field.get_attribute('placeholder')!r} val={value!r}", flush=True)


# ---- ground truth ---------------------------------------------------------
#
# The UI is not a reliable witness. It drops out of the training view whenever
# its status polls fail, so a proxy replica restart mid-round looks exactly like
# a finished run from the browser's side. Reading the orchestrator's own
# counters is the only ground truth the suite has.

def orchestrator_status(timeout=180, attempts=4, gap=45):
    """The orchestrator's own status, with retries. None when unreachable.

    Retries because the failure this check exists to diagnose also blocks the
    check itself: when bioengine's proxy declares an entry deployment unhealthy
    it deregisters the app's Hypha service, and for the length of that gap the
    orchestrator is unreachable to the browser and to this query alike. Measured
    at 77s on a Geneformer run that a single-shot query reported as failed while
    it was healthy and on round 2 of 5.
    """
    for attempt in range(attempts):
        status = _status_once(timeout=timeout)
        if status is not None:
            return status
        if attempt < attempts - 1:
            print(f"  [retry] orchestrator unreachable, retrying in {gap}s "
                  f"({attempt + 1}/{attempts})", flush=True)
            time.sleep(gap)
    return None


def orchestrator_wait_until_idle(target, timeout_s, poll=60):
    """Follow a run the browser lost, until the orchestrator stops running.

    `is_running: true` at a round below target is not a failure, it is the
    healthy case: the federation is still training and only the browser fell
    off. Returns the last status seen, or None if the orchestrator stayed
    unreachable.
    """
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        status = orchestrator_status()
        if status is None:
            return last
        last = status
        if not status.get("is_running"):
            return status
        print(f"  [following] orchestrator still running at round "
              f"{status.get('current_training_round', 0)} of "
              f"{status.get('target_round', target)}, waiting {poll}s", flush=True)
        time.sleep(poll)
    return last


def _status_once(timeout=180):
    """One shot at the orchestrator's status, in a subprocess.

    hypha_rpc's sync wrapper dies encoding nested callables and its async client
    cannot share a process with Playwright's sync API, so the query runs out of
    process and answers on stdout.
    """
    script = pathlib.Path(__file__).with_name("orch_status.py")
    try:
        proc = subprocess.run([sys.executable, str(script)],
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None
