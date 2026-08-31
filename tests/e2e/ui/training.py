"""The federated training wizard, driven end to end.

Ported from the out-of-tree demo driver and widened: the driver's job was to
produce screenshots of a happy path, this one's job is to press what a user
presses, including the controls the demo never touched (the transport switch,
the batch-size stepper, the advanced parameter sections, the checkpoint pills,
the history refresh).

Two things about this page shape everything below.

First, most of its buttons are rendered from state that a single failed poll
empties, so "the control is not there" and "the control is not there yet" are
the same DOM. Every decision to deploy is therefore taken after a grace period,
never off one read.

Second, the browser is not a reliable witness to the run. The UI leaves the
training view whenever its polls fail, which looks exactly like a finished run.
Where the outcome matters, the orchestrator's own counters decide.

Nothing here publishes. `Upload Model` stages a real artifact in the user's
workspace, so it is asserted to be present and enabled and deliberately not
clicked. `Clear Training History` is destructive and is likewise only checked
for presence.
"""
import re

from playwright.sync_api import TimeoutError as PWTimeout

from session import appeared, dismiss_error, wait_for

STEP_MARKERS = {
    "Setup Workers": "BioEngine Workers",
    "Select Apps": "Select one orchestrator to coordinate training",
    "Train": "Per Round Timeout",
}

# add_trainer can 404 on a transient pinned service lookup (bioengine #164).
REGISTER_ATTEMPTS = 4
# Checks of 5s each that "Next: Train" must survive before it is believed.
REGISTER_STABLE_CHECKS = 3


def goto_step(page, label):
    """Click one of the three wizard steps in the header stepper.

    The stepper disables a step until its prerequisites are met, and a click on
    a disabled step is a silent no-op, so confirm the target step actually
    rendered instead of assuming the click landed.
    """
    page.get_by_role("button", name=label).first.click()
    page.wait_for_timeout(1500)
    marker = STEP_MARKERS.get(label)
    if marker and page.locator(f"text={marker}").count() == 0:
        page.wait_for_selector(f"text={marker}", timeout=60_000)


def launch_button(page):
    # has_text is case-insensitive and would also match the wizard's
    # "Connect workers & launch apps" step, so pin the exact label.
    return page.get_by_role("button", name="Launch", exact=True).first


def open_launch_dialog(page, tab):
    launch_button(page).click()
    page.wait_for_selector("text=Launch Application", timeout=30_000)
    if tab == "trainer":
        page.get_by_role("button", name="🏋 Trainer").click()
    page.wait_for_timeout(1500)


def close_launch_dialog(page):
    if page.locator("text=Launch Application").count():
        page.keyboard.press("Escape")
        # The dialog has no Escape handler, so click its X.
        close = page.locator("div.fixed.inset-0 button svg path[d^='M6 18L18 6']").first
        if close.count():
            close.click()
        page.wait_for_timeout(500)


def orchestrator_radios(page):
    return page.locator("input[type=radio][name=orchestrator]")


def trainer_checkboxes(page):
    """Trainer rows in step 2. Each row's checkbox toggles registration."""
    return page.locator("label[data-managerid] input[type=checkbox]")


def next_train_visible(page):
    return page.get_by_role("button", name="Next: Train").count() > 0


def workers_loaded(page):
    """True when the page holds live worker info.

    `startTraining` looks the orchestrator up in the worker list and returns
    silently when it is not there, and a `get_worker_info` poll killed by a
    transient net error empties that list. The Federation Map header counts the
    same workers, so a non-zero count there means the click will find its
    orchestrator.
    """
    return page.locator("text=/\\b[1-9]\\d* workers?\\b/").count() > 0


def set_number(page, label, value):
    """Fill the numeric input under a given parameter label.

    The config panel derives every label from the schema key and the input is
    the label's sibling rather than a `for`-linked control, so match on the
    wrapping div rather than the label.
    """
    box = page.locator(f"div:has(> label:text-is('{label}')) > input").first
    if box.count() == 0:
        print(f"  [warn] no input for {label!r}", flush=True)
        return False
    box.fill(str(value))
    box.dispatch_event("change")
    print(f"  [set] {label} = {value}", flush=True)
    return True


def ensure_registered(page):
    """Tick the trainer row and confirm the orchestrator really took it.

    add_trainer intermittently 404s on the pinned service lookup. The row stays
    checked when it does, so `is_checked()` proves nothing, and "Next: Train"
    is rendered from that same local state, so the button merely appearing
    proves nothing either: the next `list_trainers` poll drops it again. Only a
    button that survives a full poll cycle means the orchestrator holds it.
    """
    for attempt in range(1, REGISTER_ATTEMPTS + 1):
        # A failed add_trainer raises a full-screen error modal, and that
        # overlay swallows every click underneath it, including the re-tick
        # below. Clear it before touching the row.
        dismiss_error(page)
        checkbox = trainer_checkboxes(page).first
        if not checkbox.is_checked():
            checkbox.check()
        try:
            wait_for(page, lambda: next_train_visible(page), 30,
                     "the orchestrator to accept the trainer")
            for _ in range(REGISTER_STABLE_CHECKS):
                page.wait_for_timeout(5000)
                if not next_train_visible(page):
                    raise TimeoutError("a poll reverted the registration")
            return
        except TimeoutError as error:
            print(f"  [retry] registration did not stick ({error}), "
                  f"re-registering ({attempt}/{REGISTER_ATTEMPTS})", flush=True)
            dismiss_error(page)
            checkbox = trainer_checkboxes(page).first
            if checkbox.is_checked():
                checkbox.uncheck()
            page.wait_for_timeout(5000)
    raise TimeoutError(f"the trainer never registered after {REGISTER_ATTEMPTS} attempts")


# ---- stages ---------------------------------------------------------------

def open_wizard(session):
    page = session.page
    session.goto("/training", wait_text="Federated Training", timeout=120_000)
    page.wait_for_timeout(5000)
    goto_step(page, "Setup Workers")
    session.shot("training-workers")
    assert page.get_by_text("BioEngine Workers").count() > 0, \
        "step 1 did not render the worker list"


def ensure_orchestrator(session):
    """Select a running orchestrator, deploying one if the worker has none."""
    page = session.page
    goto_step(page, "Select Apps")
    if not appeared(page, lambda: orchestrator_radios(page).count(), 45, "orchestrator"):
        goto_step(page, "Setup Workers")
        open_launch_dialog(page, "orchestrator")
        session.shot("launch-orchestrator")
        page.get_by_role("button", name="Start Orchestrator").click()
        page.wait_for_timeout(10_000)
        # The deploy runs to completion on the worker even when the browser
        # loses the response, so treat a popup as noise and let the poll below
        # decide whether an orchestrator actually came up.
        dismiss_error(page, session.shot, "orchestrator-error")
        close_launch_dialog(page)
        wait_for(page, lambda: (goto_step(page, "Select Apps"),
                                orchestrator_radios(page).count() > 0)[1],
                 240, "a RUNNING orchestrator")
    goto_step(page, "Select Apps")
    session.shot("orchestrator-running")


def ensure_trainer(session, model):
    """Select the orchestrator, then deploy this model's trainer if needed."""
    page = session.page
    # A trainer only appears in step 2 once an orchestrator is selected, so
    # select first and count after.
    orchestrator_radios(page).first.check()
    page.wait_for_timeout(3000)
    if appeared(page, lambda: trainer_checkboxes(page).count(), 45, "trainer"):
        goto_step(page, "Select Apps")
        orchestrator_radios(page).first.check()
        page.wait_for_timeout(2000)
        session.shot("trainer-running")
        return

    goto_step(page, "Setup Workers")
    open_launch_dialog(page, "trainer")

    # The gene-panel models need a full-panel dataset, so the row is chosen by
    # name whenever the model names one.
    dataset = model.get("dataset")
    if dataset:
        row = page.locator(
            f"label:has(input[type=checkbox]):has-text('{dataset}')").first
        if row.count() == 0:
            raise RuntimeError(
                f"no dataset row matching {dataset!r} in the trainer launch dialog")
        row.locator("input").check()
    else:
        page.locator("label:has(input[type=checkbox])").first.locator("input").check()

    # The batch-size stepper. Both arrows are real controls a user reaches for,
    # and they clamp to powers of two, so pressing them is also the only check
    # that the clamp holds.
    batch = page.locator("input[placeholder='32']").first
    if batch.count():
        for label in ("Double to next power of 2", "Halve to previous power of 2"):
            arrow = page.get_by_role("button", name=label, exact=True)
            if arrow.count() and arrow.first.is_enabled():
                arrow.first.click()
                page.wait_for_timeout(300)
        value = batch.input_value()
        assert value.isdigit() and int(value) & (int(value) - 1) == 0, \
            f"the batch-size stepper left a non power of two: {value!r}"
        batch.fill(str(model["batch_size"]))
    page.wait_for_timeout(500)
    session.shot("launch-trainer")

    page.get_by_role("button", name="Start Trainer").click()
    page.wait_for_timeout(15_000)
    dismiss_error(page, session.shot, "trainer-error")
    close_launch_dialog(page)
    session.shot("trainer-deploying")
    wait_for(page, lambda: (goto_step(page, "Select Apps"),
                            orchestrator_radios(page).first.check(),
                            trainer_checkboxes(page).count() > 0)[2],
             600, "a RUNNING trainer")
    goto_step(page, "Select Apps")
    orchestrator_radios(page).first.check()
    page.wait_for_timeout(2000)
    session.shot("trainer-running")


def register_trainer(session):
    """Ticking the trainer row is the registration: onChange calls add_trainer."""
    page = session.page
    ensure_registered(page)
    page.wait_for_timeout(2000)
    session.shot("registered")


def configure(session, model, rounds, transport=None):
    """Open the config panel and press through it before starting."""
    page = session.page
    try:
        page.get_by_role("button", name="Next: Train").click(timeout=20_000)
    except PWTimeout:
        print("  [retry] Next: Train went away before the click", flush=True)
        ensure_registered(page)
        page.get_by_role("button", name="Next: Train").click(timeout=20_000)
    page.wait_for_timeout(2000)
    # The parameter list is read from the trainer's live bioengine schema, so
    # it only renders once the orchestrator has answered get_trainer_params.
    page.wait_for_selector("text=Number of Rounds", timeout=180_000)
    page.wait_for_timeout(2000)

    set_number(page, "Number of Rounds", rounds)

    # The panel must survive a poll landing mid-edit. The config used to be
    # rebuilt from the schema on every status poll, which wiped whatever was
    # half-typed (issue #101), and nothing but waiting reproduces that.
    page.wait_for_timeout(12_000)
    typed = page.locator("div:has(> label:text-is('Number of Rounds')) > input").first
    assert typed.input_value() == str(rounds), \
        (f"the config panel reset Number of Rounds from {rounds} to "
         f"{typed.input_value()!r} while it sat idle")
    print("  [ok] the configured round count survived a poll cycle", flush=True)

    # The advanced sections are collapsed by default and hold the parameters a
    # user changes least often, which is exactly why they are worth opening
    # once: a schema key that fails to render only shows up in here.
    for advanced in page.get_by_role("button", name=re.compile("Advanced Parameters")).all():
        if advanced.is_visible():
            advanced.click()
            page.wait_for_timeout(500)
    session.shot("training-config-advanced")

    # The weight transport switch. Toggling it and reading the label back is
    # the only check that the persisted choice and the rendered choice agree.
    #
    # It is a role=switch, and its (i) trigger next to it is a role=button
    # carrying "About peer-to-peer weight transfer". Matching on the button
    # role with a non-exact name picks the (i) up by substring, so the role and
    # the exact name both have to be pinned.
    switch = _transport_switch(page)
    if switch.count():
        # An InfoPopover left open earlier renders a full-viewport backdrop
        # that swallows the click, so clear one before reaching for the switch.
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        before = switch.first.get_attribute("aria-checked")
        switch.first.click()
        page.wait_for_timeout(700)
        after = switch.first.get_attribute("aria-checked")
        assert after != before, (
            f"the transport switch did not move: aria-checked stayed {before!r}")
        session.shot("transport-toggled", full_page=False)
        switch.first.click()
        page.wait_for_timeout(700)
    if transport:
        _select_transport(page, transport)

    session.shot("training-config")


def _transport_switch(page):
    return page.get_by_role("switch", name="Peer-to-peer weight transfer", exact=True)


def _select_transport(page, transport):
    """Leave the switch on a named transport, whatever it was on before."""
    switch = _transport_switch(page)
    if switch.count() == 0:
        return
    for _ in range(2):
        checked = switch.first.get_attribute("aria-checked")
        on_webrtc = checked == "true"
        if (transport == "webrtc") == on_webrtc:
            print(f"  [transport] {transport}", flush=True)
            return
        switch.first.click()
        page.wait_for_timeout(700)


def run(session, rounds, reload_at_round=None):
    """Start the run, follow it to the end, and prove it actually finished."""
    page = session.page

    # "Start Training" is also the collapsible section header, and clicking
    # that one just folds the panel away, so match the emerald button by the
    # summary it carries.
    start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
    if start.count() == 0:
        page.get_by_role("button", name="Start Training", exact=True).first.click()
        page.wait_for_timeout(2000)
        start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
    assert start.count() and start.first.is_enabled(), "the Start Training button is not usable"

    # Clicking while the worker list is empty is a silent no-op, and the list
    # is emptied by any get_worker_info that dies on a transient net error, so
    # confirm the list is populated and re-click if the run did not take.
    started = False
    for attempt in range(4):
        wait_for(page, lambda: workers_loaded(page), 180,
                 "worker info to load before starting")
        start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
        if start.count() == 0:
            page.get_by_role("button", name="Start Training", exact=True).first.click()
            page.wait_for_timeout(2000)
            start = page.get_by_role("button", name=re.compile(r"^Start Training ·"))
        start.first.scroll_into_view_if_needed()
        start.first.click()
        page.wait_for_timeout(8000)
        dismiss_error(page, session.shot, "training-error")
        # The header flips to "Training Running" for the whole run, which is
        # the one marker that survives a collapsed panel.
        for _ in range(10):
            if page.get_by_text("Training Running").count() > 0:
                started = True
                break
            page.wait_for_timeout(3000)
        if started:
            break
        print(f"  [retry] start did not take (attempt {attempt + 1})", flush=True)
    if not started:
        raise TimeoutError("the federated run never entered the running state")
    session.shot("training-running")

    # The pre-round-1 window renders as "Preparing" with an elapsed clock. It
    # is the state a stuck run sits in, so capture it while it is up rather
    # than only ever screenshotting the healthy middle of a run.
    if page.get_by_text(re.compile(r"Preparing")).count():
        session.shot("training-preparing", full_page=False)

    # Stopping a run is a real button on this page and it must be reachable
    # while the run is live. Checked, never pressed: pressing it would end the
    # run this leg exists to complete.
    stop = page.get_by_role("button", name=re.compile("Stop"))
    print(f"  [info] {stop.count()} stop control(s) visible during the run", flush=True)

    if reload_at_round:
        _reload_mid_run(session, rounds, reload_at_round)

    _follow_to_the_end(session, rounds)
    page.wait_for_timeout(5000)
    session.shot("training-done")


def _reload_mid_run(session, rounds, at_round):
    """Drop the page mid-run on purpose.

    Everything the UI knows about a run is component state, so a reload is the
    cheapest deterministic way to reproduce the "UI lost the run" case that a
    replica rotation causes by accident. `?orchestrator_id=` and `?step=` are
    in the URL, so the reloaded page lands back on the same orchestrator and
    takes the resume path.
    """
    from session import orchestrator_status
    page = session.page

    def reached():
        match = re.search(r"Round\s+(\d+)\s*/\s*(\d+)", page.content())
        if match and int(match.group(1)) >= at_round:
            return True
        # The UI only renders that counter once a status poll has come back,
        # and on a busy entry deployment those polls time out for minutes at a
        # stretch. Fall back to the orchestrator's own count so the reload
        # still happens on a run the browser has already lost sight of, which
        # is the more interesting case to reload into anyway.
        truth = orchestrator_status() or {}
        return (truth.get("is_running")
                and truth.get("current_training_round", 0) >= at_round)

    wait_for(page, reached, rounds * 900, f"round {at_round} before reloading")
    print(f"  [reload] dropping the page at round {at_round}", flush=True)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    wait_for(page, lambda: page.get_by_text("Training Running").count() > 0,
             300, "the reloaded page to pick the run back up")
    session.shot("training-resumed")


def _follow_to_the_end(session, rounds):
    """Wait out the run, and check the orchestrator when the browser gives up.

    "Training Running" disappearing is not proof the run finished. The UI also
    drops out of the training view when its status polls fail, so a network
    flap mid-round looks exactly like success from here. Record the furthest
    round actually observed and insist it reached the target before believing
    the disappearance.
    """
    from session import orchestrator_status, orchestrator_wait_until_idle
    page = session.page
    seen = {"max": 0}

    def finished():
        match = re.search(r"Round\s+(\d+)\s*/\s*(\d+)", page.content())
        if match:
            seen["max"] = max(seen["max"], int(match.group(1)))
        return page.get_by_text("Training Running").count() == 0

    wait_for(page, finished, rounds * 900, "the federated run to finish")
    if seen["max"] >= rounds:
        return

    truth = orchestrator_status()
    if truth is None:
        raise RuntimeError(
            f"the run left the training view at round {seen['max']} of {rounds} "
            f"and no orchestrator could be reached to confirm what happened. "
            f"Check the worker logs rather than trusting the screenshots.")
    reached = truth.get("current_training_round", 0)
    target = truth.get("target_round", rounds)
    if truth.get("is_running"):
        # Healthy run, lost browser. Follow it to the end instead of calling it
        # a failure, and re-read the counters afterwards.
        print(f"  [following] the UI left the training view at round {seen['max']}, "
              f"but the orchestrator is running at round {reached} of {target}. "
              f"Following it.", flush=True)
        remaining = max(target - reached, 1) * 900
        truth = orchestrator_wait_until_idle(target, remaining) or truth
        reached = truth.get("current_training_round", reached)
        target = truth.get("target_round", target)
        if truth.get("is_running"):
            raise RuntimeError(f"the orchestrator was still running at round {reached} "
                               f"of {target} after waiting {remaining}s for it to finish.")
    if reached < target:
        raise RuntimeError(
            f"the run stopped at round {reached} of {target} (the UI last showed "
            f"{seen['max']}), so it did not finish. Check the orchestrator logs "
            f"rather than trusting the screenshots.")
    print(f"  [recovered] the UI lost the run at round {seen['max']}, but the "
          f"orchestrator reports {reached} of {target} complete", flush=True)


def inspect_history(session):
    """The loss charts and their refresh, after the run."""
    page = session.page
    if page.get_by_text("Training History").count() == 0:
        print("  [skip] no Training History panel rendered", flush=True)
        return
    refresh = page.locator("button:near(:text('Training History'))").filter(
        has_text=re.compile("Refresh"))
    if refresh.count() == 0:
        refresh = page.get_by_role("button", name=re.compile("Refresh"))
    if refresh.count() and refresh.first.is_enabled():
        refresh.first.click()
        page.wait_for_timeout(4000)
        print("  [click] Training History refresh", flush=True)
    session.shot("training-history")

    # Present but never pressed: it throws away the loss curves this leg just
    # produced, and the next leg has no way to get them back.
    clear = page.get_by_role("button", name=re.compile("Clear Training History"))
    assert clear.count() > 0, "the Clear Training History button is missing after a run"


def save_weights(session):
    """The Save Weights panel: checkpoint pills, save to worker, upload check."""
    page = session.page
    page.wait_for_selector("text=Save Weights", timeout=120_000)

    # The global card offers one pill per completed round. Clicking the earliest
    # and then the latest is what a user does when comparing checkpoints, and it
    # is the only thing that exercises the manual-selection path.
    pills = page.get_by_role("button", name=re.compile(r"^Round \d+$"))
    if pills.count() > 1:
        pills.first.click()
        page.wait_for_timeout(1200)
        session.shot("checkpoint-earliest", full_page=False)
        pills.last.click()
        page.wait_for_timeout(1200)

    # Upload Model stages a real artifact in the user's workspace. A suite that
    # runs four legs a pass would leave four of them behind every time, so this
    # asserts the button is usable and stops there.
    upload = page.get_by_role("button", name=re.compile("Upload Model"))
    assert upload.count() > 0, "no Upload Model button after a finished run"
    enabled = [i for i in range(upload.count()) if upload.nth(i).is_enabled()]
    assert enabled, "every Upload Model button is disabled after a finished run"
    print(f"  [ok] {len(enabled)} of {upload.count()} Upload Model buttons enabled", flush=True)

    save_local = page.get_by_role("button", name="Save to worker")
    assert save_local.count() > 0, "no Save to worker button after a finished run"
    save_local.first.scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    session.shot("save-weights-panel")
    save_local.first.click()
    wait_for(page, lambda: page.get_by_role("button", name="Saved to worker").count() > 0,
             300, "the local checkpoint to be written")
    page.wait_for_timeout(1000)
    session.shot("checkpoint-saved")
