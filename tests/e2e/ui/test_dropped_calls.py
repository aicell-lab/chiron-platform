"""Two lost calls that the page used to report as verdicts.

Both are races. Hypha cannot route a call to a freshly deployed app for the
first half minute or so and answers it with a 404, and a request can simply die
in transit. Neither means the app refused anything, because in both cases the
app never saw the call, but the page reported both as refusals: a blocking
"Failed to Register Trainer" over a federation that was seconds from working,
and a red "Training Failed" over a run that was visibly training and went on to
produce checkpoints.

The model journey in test_model_journeys.py cannot cover this. It hits the
windows only when the timing happens to line up, which is a minority of runs,
and its own driver clears the modal and carries on, so a leg passes either way.
So the failures are injected here instead, and what is asserted is the thing
the user sees: no modal, and a page that keeps telling the truth.

Both tests reuse whatever orchestrator and trainer are already running, and
skip when there are none. They deploy nothing.

    python -m pytest tests/e2e/ui/test_dropped_calls.py -s
"""
import re
import threading
import time

import pytest
import requests
from playwright.sync_api import sync_playwright

import training as training_mod
from session import appeared, open_session, wait_for

# The body Hypha returns while a service is not yet routable. The frontend
# matches on the service id inside it, so it is rebuilt per request from the
# id the page actually addressed rather than hard-coded.
UNROUTABLE_BODY = (
    '{"success":false,"detail":"RemoteException: KeyError: '
    "\'Service not found: %s@*\'\"}"
)


def service_id_of(url):
    """The service id the frontend addressed, back out of the request URL.

    `https://hypha.aicell.io/<workspace>/services/<id>/<method>?...` is the
    shape, and `<workspace>/<id>` is what HyphaHttpError carries and what the
    frontend's own routing check compares against.
    """
    match = re.search(r"//[^/]+/([^/]+)/services/([^/]+)/([^/?]+)", url)
    if not match:
        return None
    return f"{match.group(1)}/{match.group(2)}"


def error_modal_title(page):
    """The title of the blocking error modal, or None when none is up."""
    close = page.get_by_role("button", name="Close", exact=True)
    if close.count() == 0 or not close.first.is_visible():
        return None
    heading = page.locator("div.fixed.inset-0 h3").first
    return heading.inner_text().strip() if heading.count() else "?"


def assert_no_modal(page, during):
    title = error_modal_title(page)
    assert title is None, f"a blocking error modal appeared while {during}: {title!r}"


@pytest.fixture(scope="module")
def wizard(token, base_url, tmp_path_factory):
    """A logged-in page sitting on the wizard's Select Apps step."""
    with sync_playwright() as playwright:
        session = open_session(playwright, "dropped-calls", token, fresh=True)
        # The shared config helper takes screenshots along the way. They are a
        # by-product here, not a reference set, so keep them out of the tree the
        # model journeys' committed screenshots live in.
        session.outdir = tmp_path_factory.mktemp("dropped-calls-shots")
        page = session.page
        session.goto("/training", wait_text="Setup Workers")
        page.wait_for_timeout(4000)
        training_mod.goto_step(page, "Select Apps")
        # The app lists are filled by a get_worker_info poll, so an empty list
        # right after the step change means "not loaded yet" at least as often
        # as it means "nothing there". Reading it once would skip the whole
        # module against a healthy federation.
        if not appeared(page, lambda: training_mod.orchestrator_radios(page).count(),
                        90, "orchestrator"):
            pytest.skip("no orchestrator is running, deploy one first")
        # The trainer rows only render once an orchestrator is selected, so
        # select first and count after.
        training_mod.orchestrator_radios(page).first.check()
        page.wait_for_timeout(3000)
        if not appeared(page, lambda: training_mod.trainer_checkboxes(page).count(),
                        60, "trainer"):
            pytest.skip("no trainer is running, deploy one first")
        yield session
        session.browser.close()


def test_add_trainer_survives_an_unroutable_orchestrator(wizard):
    """A 404 from the routing layer must not be read as a refusal.

    The first two attempts are answered the way Hypha answers a call to an app
    it cannot resolve yet. The third is let through. A user who ticked the box
    once should see the trainer register, with nothing in the way.
    """
    page = wizard.page
    checkbox = training_mod.trainer_checkboxes(page).first
    if checkbox.is_checked():
        checkbox.uncheck()
        page.wait_for_timeout(6000)
    assert_no_modal(page, "clearing the registration")

    blocked = []

    def block_the_first_two(route):
        if len(blocked) >= 2:
            route.continue_()
            return
        service = service_id_of(route.request.url)
        blocked.append(service)
        print(f"  [inject] unroutable add_trainer #{len(blocked)} -> {service}", flush=True)
        route.fulfill(status=404, content_type="application/json",
                      body=UNROUTABLE_BODY % service)

    page.route("**/add_trainer*", block_the_first_two)
    try:
        checkbox.check()
        # Four attempts five seconds apart, so the third lands around 10s in.
        # Give it the same margin the page gives itself.
        deadline = time.time() + 90
        while time.time() < deadline:
            assert_no_modal(page, "the orchestrator was unroutable")
            if training_mod.next_train_visible(page):
                break
            page.wait_for_timeout(1000)
        else:
            pytest.fail("the trainer never registered after the routing settled")

        # The button is rendered from local state, so let a list_trainers poll
        # land before believing it: that poll is what used to drop the row.
        page.wait_for_timeout(15_000)
        assert training_mod.next_train_visible(page), \
            "a poll reverted the registration, so the orchestrator never took it"
        assert_no_modal(page, "the registration settled")
    finally:
        page.unroute("**/add_trainer*")

    assert len(blocked) == 2, \
        f"expected the injected 404s to be used, got {len(blocked)}"
    print(f"  [ok] registered after {len(blocked)} unroutable attempts, no modal",
          flush=True)


def test_a_lost_start_training_response_is_not_a_failed_run(wizard):
    """Dropping the response must not be reported as the run failing.

    The request is performed for real and only its response is thrown away, so
    the orchestrator starts the session exactly as it would have. That is the
    real failure: `start_training` returns only when the whole run is over, so
    an error arriving seconds in can never be the run's verdict.
    """
    page = wizard.page
    if not training_mod.next_train_visible(page):
        pytest.skip("no registered trainer, the registration test has to pass first")

    training_mod.configure(wizard, {"slug": "tabula"}, rounds=1)

    dropped = []

    def drop_the_response(route):
        """Send the request for real, deny the page the answer.

        route.fetch() cannot do this: it waits for the response, and this
        particular response only comes when the whole run is over. So the
        browser's request is aborted and an identical one is posted from a
        thread, which leaves the orchestrator running a session the page has no
        answer about. That is the state the fix exists for.
        """
        if dropped:
            route.continue_()
            return
        request = route.request
        url, headers, body = request.url, request.all_headers(), request.post_data
        dropped.append(url)
        print("  [inject] aborting start_training in the browser, posting it for real",
              flush=True)
        route.abort("failed")
        threading.Thread(
            target=lambda: requests.post(url, headers=headers, data=body, timeout=3600),
            daemon=True,
        ).start()

    page.route("**/start_training*", drop_the_response)
    try:
        start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
        if start.count() == 0:
            page.get_by_role("button", name="Start Training", exact=True).first.click()
            page.wait_for_timeout(2000)
            start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
        wait_for(page, lambda: training_mod.workers_loaded(page), 180,
                 "worker info to load before starting")
        start.first.scroll_into_view_if_needed()
        start.first.click()

        # The page probes the orchestrator before deciding anything, three
        # tries five seconds apart, so a verdict cannot arrive before then.
        # Watch well past that.
        deadline = time.time() + 120
        running = False
        while time.time() < deadline:
            assert_no_modal(page, "the start_training response was lost")
            if page.get_by_text("Training Running").count() > 0:
                running = True
                break
            page.wait_for_timeout(2000)
        assert running, "the page never showed the run it had just started"
        assert_no_modal(page, "the run got going")
        print("  [ok] the run is shown as running, no modal", flush=True)
    finally:
        page.unroute("**/start_training*")
        stop = page.get_by_role("button", name=re.compile("Stop Training"))
        if stop.count():
            stop.first.click()
            page.wait_for_timeout(3000)
            confirm = page.get_by_role("button", name=re.compile("Stop"))
            if confirm.count():
                confirm.last.click()
            print("  [cleanup] stopped the injected run", flush=True)
            page.wait_for_timeout(10_000)

    assert dropped, "the injected drop never fired, so nothing was proven"
