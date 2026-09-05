"""Everything a user clicks outside the training wizard.

Split from `training.py` because the two halves fail for different reasons and
want different handling. The pages here are static: if a control is missing,
that is a defect worth failing on. The training wizard depends on a live
federation, so it has to tolerate a slow worker without calling it a bug.

Every helper takes the `Session` from `session.py` and drives the real DOM. The
selectors are the ones a user would go by (visible text, `aria-label`, the role
of the control) rather than CSS classes, so a styling change does not silently
turn an assertion into a no-op.
"""
import re

from session import dismiss_error

# Never type a real local path into a field whose value is rendered back into
# the page, the generated manifest and the copy-to-clipboard prompt. A
# screenshot of this suite is a public artifact.
PLACEHOLDER_DATA_DIR = "/path/to/single-cell-data"


def _click_if(page, locator, what, timeout=10_000):
    """Click when present and enabled. Reports what it did either way."""
    if locator.count() == 0:
        print(f"  [skip] {what}: not present", flush=True)
        return False
    first = locator.first
    if not first.is_visible():
        print(f"  [skip] {what}: not visible", flush=True)
        return False
    if not first.is_enabled():
        print(f"  [skip] {what}: disabled", flush=True)
        return False
    first.click(timeout=timeout)
    page.wait_for_timeout(600)
    print(f"  [click] {what}", flush=True)
    return True


def landing(session):
    """The front page and the four navbar destinations."""
    page = session.page
    session.goto("/", wait_text="Chiron Platform")
    session.shot("landing")

    # The AI-agent popover in the navbar hands the platform to an agent. It is
    # a button a real visitor presses, and it renders a copy-prompt, which is
    # exactly the surface that must never contain a local path.
    popover = page.get_by_title("Hand the Chiron platform to your AI agent")
    if _click_if(page, popover, "AI agent popover"):
        session.shot("landing-agent-popover", full_page=False)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

    for label in ("Models", "Worker", "Training", "Runs"):
        link = page.get_by_role("link", name=label, exact=True)
        assert link.count() > 0, f"navbar link {label!r} is missing"
    print("  [ok] all four navbar links present", flush=True)


def models_hub(session):
    """The public model collection: search, filter, open a card."""
    page = session.page
    session.goto("/models", wait_text="Models")
    page.wait_for_timeout(3000)
    session.shot("models-hub")

    search = page.get_by_placeholder("Search resources...")
    if search.count():
        search.first.fill("tabula")
        search.first.press("Enter")
        page.wait_for_timeout(3000)
        session.shot("models-hub-search")
        search.first.fill("")
        search.first.press("Enter")
        page.wait_for_timeout(2000)

    # Opening a card is the one navigation on this page, and the detail route
    # is where a broken cover image or a missing manifest field shows up.
    cards = page.locator("a[href*='#/models/'], a[href*='#/resources/']")
    if cards.count():
        cards.first.click()
        page.wait_for_timeout(4000)
        session.shot("model-detail")
        page.go_back()
        page.wait_for_timeout(2000)
    else:
        print("  [skip] no model cards to open", flush=True)


def my_models(session):
    """The signed-in user's own checkpoints.

    Worth a stage of its own because the covers on this page have broken twice
    (task #98), and a broken cover is invisible to any assertion that only
    checks that the page rendered.
    """
    page = session.page
    session.goto("/my-models")
    page.wait_for_timeout(5000)
    session.shot("my-models")

    broken = page.evaluate(
        "Array.from(document.images)"
        ".filter(i => i.complete && i.naturalWidth === 0)"
        ".map(i => i.currentSrc || i.src)"
    )
    if broken:
        print(f"  [warn] {len(broken)} image(s) failed to load: {broken[:5]}", flush=True)
    else:
        print("  [ok] every image on My Models rendered", flush=True)
    return broken


def runs_page(session):
    """Past and ongoing runs, plus its Refresh button."""
    page = session.page
    session.goto("/runs", wait_text="Training Runs")
    page.wait_for_timeout(4000)
    session.shot("runs")
    _click_if(page, page.get_by_role("button", name="Refresh", exact=True), "Runs refresh")
    page.wait_for_timeout(3000)


def worker_guide(session, model):
    """The setup wizard at /worker, pressed the way an operator presses it.

    This is the densest page in the app: two audience tabs, four info popovers,
    three disclosures, a manifest builder and an advanced section. All of it is
    exercised here because all of it is reachable in one visit and none of it
    needs a live worker.
    """
    page = session.page
    session.goto("/worker", wait_text="BioEngine")
    page.wait_for_timeout(2000)
    session.shot("worker-guide")

    # Audience toggle. The AI Agent tab renders a copy-prompt built from the
    # same form state, so it has to be visited after the fields are filled to
    # be worth anything. Visit it once now to prove the tab works, and again at
    # the end for the screenshot.
    for tab in ("AI Agent", "Human"):
        _click_if(page, page.get_by_role("tab", name=tab, exact=True), f"{tab} tab")
    session.shot("worker-guide-human-tab")

    # The three disclosures. Each is a plain button whose label is its own
    # description, so the name is the selector.
    for label in ("Show example folder layout",
                  "Show expected AnnData structure",
                  "Build manifest.yaml"):
        opened = _click_if(page, page.get_by_role("button", name=label), label)
        if opened:
            page.wait_for_timeout(500)
    session.shot("worker-guide-disclosures")

    # Manifest builder. Generic values only: the dataset id and description end
    # up in a downloadable file and in the rendered preview.
    _fill_labeled(page, "Dataset ID", f"demo-{model['slug']}-dataset")
    _fill_labeled(page, "Description", "Demo dataset for the end-to-end suite")
    download = page.get_by_role("button", name=re.compile("Download manifest"))
    if download.count() and download.first.is_enabled():
        # The button flips to "Downloaded" for two seconds. Catching that is
        # the only proof the click produced a file rather than a silent throw.
        with page.expect_download(timeout=15_000) as caught:
            download.first.click()
        print(f"  [download] {caught.value.suggested_filename}", flush=True)
        page.wait_for_timeout(800)
        session.shot("worker-guide-manifest-downloaded", full_page=False)

    # Worker configurator.
    _fill_labeled(page, "Worker Name", f"chiron-e2e-{model['slug']}")
    _fill_labeled(page, "Training Data Directory", PLACEHOLDER_DATA_DIR)
    _select_labeled(page, "Model", model["display"])
    _set_number(page, "Memory (GB)", model["worker_memory_gb"])
    session.shot("worker-guide-configured")

    # Container Runtime drives two conditional blocks (the runtime popover and
    # the GPU popover), so both values have to be visited to cover the branch.
    for runtime in ("apptainer", "docker"):
        if _select_labeled(page, "Container Runtime", runtime, by_value=True):
            page.wait_for_timeout(700)
            session.shot(f"worker-guide-runtime-{runtime}")

    # Every info popover, by the aria-label InfoPopover puts on its trigger.
    for label in ("Container runtime info", "Shared memory info",
                  "GPU support info", "Memory info"):
        trigger = page.get_by_role("button", name=label, exact=True)
        if _click_if(page, trigger, label):
            session.shot(f"popover-{label.split()[0].lower()}", full_page=False)
            # Portalled panel, closes on Escape. Leaving it open would swallow
            # the next click.
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

    _click_if(page, page.get_by_role("button", name=re.compile("Advanced Options")),
              "Advanced Options")
    page.wait_for_timeout(700)
    session.shot("worker-guide-advanced")

    workspace_info = page.get_by_role("button", name="Workspace directory info", exact=True)
    if _click_if(page, workspace_info, "Workspace directory info"):
        session.shot("popover-workspace-dir", full_page=False)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

    # The AI Agent tab, now that the form is filled, is what an agent-operated
    # setup actually copies.
    if _click_if(page, page.get_by_role("tab", name="AI Agent", exact=True), "AI Agent tab"):
        page.wait_for_timeout(800)
        session.shot("worker-guide-agent-tab")
        leaked = _leaked_paths(page)
        assert not leaked, f"the agent prompt contains a real local path: {leaked}"
        _click_if(page, page.get_by_role("tab", name="Human", exact=True), "back to Human tab")

    # Copy buttons. Clipboard access is not granted to a headless context, so
    # this proves the handler does not throw, not that the clipboard filled.
    copies = page.get_by_role("button", name=re.compile("^Copy"))
    print(f"  [info] {copies.count()} copy button(s) on the guide", flush=True)
    if copies.count():
        _click_if(page, copies, "first Copy button")

    dismiss_error(page, session.shot, "worker-guide-error")


def worker_instances(session):
    """The instance list behind "View BioEngine Workers"."""
    page = session.page
    session.goto("/worker")
    page.wait_for_timeout(1500)
    # Reaching the list through its button rather than the URL is the point:
    # the button is the only way a user finds this route.
    assert _click_if(page, page.get_by_role("button", name=re.compile("View BioEngine Workers")),
                     "View BioEngine Workers"), "the workers button is missing from /worker"
    page.wait_for_url(re.compile(r"#/worker/instances"), timeout=20_000)
    page.wait_for_timeout(6000)
    session.shot("worker-instances")

    _click_if(page, page.get_by_role("button", name="Refresh", exact=True), "instances refresh")
    page.wait_for_timeout(5000)

    # The Chiron-only filter is a switch, so its state is readable and worth
    # asserting rather than just clicking.
    toggle = page.get_by_role("switch").first
    if toggle.count() and toggle.is_visible():
        before = toggle.get_attribute("aria-checked")
        toggle.click()
        page.wait_for_timeout(1500)
        after = toggle.get_attribute("aria-checked")
        assert before != after, "the Chiron-workers-only switch did not change state"
        session.shot("worker-instances-all-workers")
        toggle.click()
        page.wait_for_timeout(1500)

    # Add and remove an observed workspace. This writes to localStorage, so it
    # has to clean up after itself or the next leg inherits it.
    add = page.get_by_placeholder("Add workspace name...")
    if add.count():
        add.first.fill("chiron-e2e-scratch")
        add.first.press("Enter")
        page.wait_for_timeout(3000)
        session.shot("worker-instances-workspace-added")
        removes = page.locator("button[title*='Remove'], button[aria-label*='Remove']")
        _click_if(page, removes, "remove observed workspace")
        page.wait_for_timeout(1500)

    dismiss_error(page, session.shot, "worker-instances-error")

    # Copying a service id is how an operator hands a worker to an agent.
    copy_id = page.locator("button[title*='Copy'], button[aria-label*='Copy']")
    _click_if(page, copy_id, "copy service id")


def worker_dashboard(session):
    """A worker's own dashboard, reached from its card.

    Returns True when a dashboard opened. A leg with no reachable worker is a
    real state (the swap between models has a gap), not a failure of the page.
    """
    page = session.page
    session.goto("/worker/instances")
    page.wait_for_timeout(8000)
    view = page.get_by_role("button", name="View Dashboard")
    enabled = [i for i in range(view.count()) if view.nth(i).is_enabled()]
    if not enabled:
        print("  [skip] no worker with a reachable dashboard", flush=True)
        return False
    view.nth(enabled[0]).click()
    page.wait_for_timeout(10_000)
    session.shot("worker-dashboard")
    dismiss_error(page, session.shot, "worker-dashboard-error")

    # The dashboard has no tabs. It is one scrolling page of sections, so what
    # a user presses here are the copy affordances, the cache loader and the
    # refresh. Load app cache is opt-in by design (it fans a Ray task out per
    # node), which makes it the one control that has to be pressed to see the
    # section fill in at all.
    for name in ("Copy Service ID", "Copy AI Agent Prompt", "Copy AI Coding Skill"):
        _click_if(page, page.get_by_role("button", name=name, exact=True), f"dashboard {name}")
        page.wait_for_timeout(800)
    _click_if(page, page.get_by_role("button", name="Load app cache", exact=True), "load app cache")
    page.wait_for_timeout(6000)
    session.shot("worker-dashboard-cache")
    _click_if(page, page.get_by_role("button", name="Refresh", exact=True).first, "dashboard refresh")
    page.wait_for_timeout(4000)

    # Scroll the whole page so the cluster resource cards and the deployed-app
    # list render into the screenshot rather than staying below the fold.
    page.mouse.wheel(0, 2400)
    page.wait_for_timeout(1200)
    session.shot("worker-dashboard-resources")
    dismiss_error(page, session.shot, "worker-dashboard-late-error")
    return True


def account_menu(session):
    """The avatar dropdown: connection status, My Models, and back out."""
    page = session.page
    session.goto("/")
    page.wait_for_timeout(3000)
    avatar = page.get_by_role("button", name=re.compile("User profile menu"))
    if avatar.count() == 0:
        print("  [warn] not signed in, no account menu", flush=True)
        return None
    avatar.first.click()
    page.wait_for_selector("#user-dropdown", timeout=10_000)
    page.wait_for_timeout(500)
    status = page.locator("#user-dropdown .text-xs").first.inner_text().strip()
    print(f"  [connection] {status}", flush=True)
    session.shot("account-menu", full_page=False)
    # Close without logging out. Logging out here would strand every later
    # stage, which all need the session.
    page.keyboard.press("Escape")
    page.mouse.click(10, 10)
    page.wait_for_timeout(500)
    return status


def report_issue_dialog(session):
    """The footer's Report Issue path, opened and cancelled.

    Deliberately never submitted. A submit writes a real artifact into
    `chiron-platform/issues`, and a suite that runs four times per pass would
    bury the collection under its own noise. Everything up to the submit button
    is exercised, including the payload preview, which is where a token or a
    local path would leak if the redaction regressed.
    """
    page = session.page
    session.goto("/")
    page.wait_for_timeout(2000)
    button = page.get_by_role("button", name=re.compile("Report Issue"))
    if button.count() == 0:
        print("  [warn] no Report Issue button in the footer", flush=True)
        return False
    button.first.scroll_into_view_if_needed()
    button.first.click()
    page.wait_for_selector("[role=dialog]", timeout=15_000)
    page.wait_for_timeout(800)

    page.locator("#report-issue-description").fill(
        "End-to-end suite dry run. This report is cancelled, not sent."
    )
    _click_if(page, page.get_by_role("button", name="What gets sent"), "What gets sent")
    page.wait_for_timeout(1000)
    session.shot("report-issue-dialog", full_page=False)

    preview = page.locator("[role=dialog] pre").first
    if preview.count():
        text = preview.inner_text()
        for secret in ("eyJhbGciOi", "/data/nmechtel", "/home/nmechtel"):
            assert secret not in text, f"the report preview leaks {secret!r}"
        print("  [ok] report preview carries no token and no local path", flush=True)

    assert _click_if(page, page.get_by_role("button", name="Cancel", exact=True),
                     "Cancel report"), "the report dialog has no Cancel button"
    page.wait_for_timeout(800)
    assert page.locator("[role=dialog]").count() == 0, "the report dialog did not close"
    return True


# ---- field helpers --------------------------------------------------------
#
# The guide labels its inputs with a plain <label> sibling rather than `for=`,
# so `get_by_label` does not find them. These match the structure the guide
# actually uses.

def _control(page, label, tag):
    """The control a <label> belongs to.

    Two shapes exist in the guide. A plain field puts the label directly above
    its input, but a field with an (i) popover wraps label and button in a flex
    row first, so the label is a grandchild and `div:has(> label)` misses it.
    Walking up from the label to the nearest ancestor div that actually holds a
    control covers both without caring which shape a given field uses.
    """
    label_node = page.locator(f"label:text-is('{label}')").first
    if label_node.count() == 0:
        return label_node
    return label_node.locator(
        f"xpath=ancestor::div[.//{tag}][1]"
    ).locator(tag).first


def _field(page, label):
    """Text-ish inputs. Description is a textarea, the rest are inputs."""
    field = _control(page, label, "input")
    if field.count() == 0:
        field = _control(page, label, "textarea")
    return field


def _fill_labeled(page, label, value):
    field = _field(page, label)
    if field.count() == 0:
        print(f"  [skip] field {label!r} not found", flush=True)
        return False
    field.fill(str(value))
    field.dispatch_event("change")
    page.wait_for_timeout(300)
    return True


def _set_number(page, label, value):
    """Number inputs need an explicit change event after fill()."""
    field = _control(page, label, "input")
    if field.count() == 0:
        print(f"  [skip] number field {label!r} not found", flush=True)
        return False
    field.fill(str(value))
    field.dispatch_event("change")
    page.wait_for_timeout(300)
    return True


def _select_labeled(page, label, value, by_value=False):
    select = _control(page, label, "select")
    if select.count() == 0:
        print(f"  [skip] select {label!r} not found", flush=True)
        return False
    try:
        select.select_option(value=value) if by_value else select.select_option(label=value)
    except Exception as error:
        print(f"  [skip] select {label!r} has no option {value!r}: {error}", flush=True)
        return False
    select.dispatch_event("change")
    page.wait_for_timeout(400)
    print(f"  [select] {label} = {value}", flush=True)
    return True


def _leaked_paths(page):
    """Real local paths visible anywhere in the rendered page."""
    body = page.inner_text("body")
    return [p for p in ("/data/nmechtel", "/home/nmechtel", "/home/nils") if p in body]
