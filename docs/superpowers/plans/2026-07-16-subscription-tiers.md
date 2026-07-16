# Subscription Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map four Stripe subscription tiers (Bronze/Silver/Gold/Kids) to Wizarr invites scoped to per-tier library sets and download permissions.

**Architecture:** Payment-link `metadata.tier` rides the existing `checkout.session.completed` webhook into the bridge. A new `tiers.py` module computes each tier's library set from the live Wizarr library list using name rules (never stored IDs), with a final hard filter that strips private Caraxes `9X.` libraries independent of tier rules. The web landing page swaps its single price CTA for four pricing cards fed by per-tier Netlify env vars.

**Tech Stack:** Python 3 / FastAPI / pytest + responses (bridge); React 18 + Vite + Vitest, SCSS modules, bun (web); Stripe CLI (Test mode objects).

**Spec:** `docs/superpowers/specs/2026-07-16-subscription-tiers-design.md`

## Global Constraints

- Private rule (verbatim from spec): any Caraxes library whose name matches `^9\d\.` is never shared under any tier, under any circumstance.
- "4K" library match is case-insensitive on the library name.
- Kids allowlist (server, name): (Vermithor, "06. Kid Shows"), (Meleys, "02. Family Movies"), (Vermithor, "04. 4K Family Movies").
- Downloads: Bronze off, Silver off, Gold on, Kids on.
- Prices: Bronze $8, Silver $14, Gold $20, Kids $20 — all CAD, monthly.
- Missing/unknown tier metadata → treat as Bronze, log an error.
- User-facing payment copy uses infrastructure language only — never library or content names.
- TypeScript: type aliases only (no interfaces), no `any`, no casts, `?.` always paired with `??`, short-circuit `&&` rendering guarded to real booleans, `Array.prototype` methods over loops.
- CSS: SCSS modules, grid + `gap` layout, token values from `web/src/styles/globals.scss` only.
- No back-compat shims — remove replaced code and env vars outright.
- Web dependencies/commands run through bun (`bun run --cwd web test`); bridge tests run through the repo venv (`../venv/bin/python -m pytest` from `stripe-bridge/`).
- Commits: subject starts with `WZ:`, short title, concise bullet body.

---

### Task 1: Tier rules module (`tiers.py`)

**Files:**

- Create: `stripe-bridge/tiers.py`
- Test: `stripe-bridge/tests/test_tiers.py`

**Interfaces:**

- Consumes: nothing (pure module; takes the library list as data).
- Produces (used by Task 3):
  - `normalize_tier(raw) -> str` — maps checkout metadata to `"bronze" | "silver" | "gold" | "kids"`, defaulting unknown/missing to `"bronze"` with an error log.
  - `resolve_tier_access(*, tier: str, libraries: list) -> dict` — returns `{"library_ids": list[int], "server_ids": list[int], "allow_downloads": bool}`. `libraries` is the raw list from Wizarr `GET /api/libraries` (dicts with `id`, `name`, `server_id`, `server_name`, `enabled`).
  - `TIER_DOWNLOADS: dict[str, bool]` — the four known tier names to their downloads flag.

- [ ] **Step 1: Write the failing tests**

Create `stripe-bridge/tests/test_tiers.py`:

```python
import logging

import tiers

LIBRARIES = [
    {"id": 9, "name": "01. Classic TV Shows", "server_id": 5, "server_name": "Syrax", "enabled": True},
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 22, "name": "06. Kid Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 23, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 24, "name": "02. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 25, "name": "03. 4K TV Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 28, "name": "01. 4K Movies", "server_id": 3, "server_name": "Vhagar", "enabled": True},
    {"id": 30, "name": "01. UFC", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 36, "name": "09. Basketball", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 38, "name": "97. Home Videos", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 39, "name": "98. Documents", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 40, "name": "96. Assignments", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 50, "name": "07. Disabled Stuff", "server_id": 2, "server_name": "Meleys", "enabled": False},
]

PRIVATE_IDS = {37, 38, 39, 40}
FOUR_K_IDS = {20, 25, 28}


def test_private_libraries_appear_in_no_tier():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_private_guard_survives_tier_rule_bugs(monkeypatch):
    # Simulate a future tier-rule bug that wants every library shared; the
    # final private filter must still strip the 9X. Caraxes libraries.
    monkeypatch.setattr(tiers, "_tier_wants", lambda tier, lib: True)
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_bronze_excludes_4k_and_disallows_downloads():
    out = tiers.resolve_tier_access(tier="bronze", libraries=LIBRARIES)
    assert out["library_ids"] == [9, 17, 22, 23, 24, 30, 36]
    assert out["server_ids"] == [1, 2, 4, 5]
    assert out["allow_downloads"] is False


def test_silver_includes_4k_without_downloads():
    out = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    assert FOUR_K_IDS <= set(out["library_ids"])
    assert out["library_ids"] == [9, 17, 20, 22, 23, 24, 25, 28, 30, 36]
    assert out["server_ids"] == [1, 2, 3, 4, 5]
    assert out["allow_downloads"] is False


def test_gold_matches_silver_libraries_with_downloads_on():
    silver = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    gold = tiers.resolve_tier_access(tier="gold", libraries=LIBRARIES)
    assert gold["library_ids"] == silver["library_ids"]
    assert gold["server_ids"] == silver["server_ids"]
    assert gold["allow_downloads"] is True


def test_kids_gets_exactly_the_allowlist():
    out = tiers.resolve_tier_access(tier="kids", libraries=LIBRARIES)
    assert out["library_ids"] == [20, 22, 24]
    assert out["server_ids"] == [1, 2]
    assert out["allow_downloads"] is True


def test_kids_allowlist_miss_logs_and_proceeds(caplog):
    # "06. Kid Shows" renamed on the server -> log loudly, share what matched.
    renamed = [lib for lib in LIBRARIES if lib["id"] != 22]
    with caplog.at_level(logging.ERROR):
        out = tiers.resolve_tier_access(tier="kids", libraries=renamed)
    assert out["library_ids"] == [20, 24]
    assert "kids allowlist" in caplog.text


def test_caraxes_09_prefix_is_not_private():
    # "09. Basketball" starts with "09.", not "9X." -- it is shareable.
    out = tiers.resolve_tier_access(tier="bronze", libraries=LIBRARIES)
    assert 36 in out["library_ids"]


def test_disabled_libraries_are_never_shared():
    for tier in ("bronze", "silver", "gold"):
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert 50 not in out["library_ids"], tier


def test_normalize_tier_accepts_known_tiers_case_insensitively():
    assert tiers.normalize_tier("gold") == "gold"
    assert tiers.normalize_tier(" Silver ") == "silver"
    assert tiers.normalize_tier("KIDS") == "kids"


def test_normalize_tier_defaults_unknown_and_missing_to_bronze(caplog):
    with caplog.at_level(logging.ERROR):
        assert tiers.normalize_tier("platinum") == "bronze"
        assert tiers.normalize_tier(None) == "bronze"
        assert tiers.normalize_tier("") == "bronze"
    assert "unknown tier" in caplog.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest tests/test_tiers.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tiers'`

- [ ] **Step 3: Write the implementation**

Create `stripe-bridge/tiers.py`:

```python
import logging
import re

log = logging.getLogger("bridge")

# Never-share rule: Caraxes libraries named "96. ..." through "99. ...".
PRIVATE_SERVER_NAME = "Caraxes"
PRIVATE_NAME_RE = re.compile(r"^9\d\.")

# Kids allowlist, matched on (server_name, library name).
KIDS_LIBRARIES = frozenset({
    ("Vermithor", "06. Kid Shows"),
    ("Meleys", "02. Family Movies"),
    ("Vermithor", "04. 4K Family Movies"),
})

TIER_DOWNLOADS = {
    "bronze": False,
    "silver": False,
    "gold": True,
    "kids": True,
}


def normalize_tier(raw) -> str:
    """Map checkout metadata to a known tier; unknown or missing falls back to bronze."""
    tier = (raw or "").strip().lower()
    if tier not in TIER_DOWNLOADS:
        log.error("unknown tier %r on checkout session; defaulting to bronze", raw)
        return "bronze"
    return tier


def _is_private(library: dict) -> bool:
    """Whether a library is in the never-share set (Caraxes 9X. names)."""
    return (
        library.get("server_name") == PRIVATE_SERVER_NAME
        and bool(PRIVATE_NAME_RE.match(library.get("name") or ""))
    )


def _is_4k(library: dict) -> bool:
    """Case-insensitive '4K' match on the library name."""
    return "4k" in (library.get("name") or "").lower()


def _tier_wants(tier: str, library: dict) -> bool:
    """Whether a tier's rules include a library (before the private filter)."""
    if tier == "kids":
        return (library.get("server_name"), library.get("name")) in KIDS_LIBRARIES
    if tier == "bronze":
        return not _is_4k(library)
    return True  # silver / gold: everything


def resolve_tier_access(*, tier: str, libraries: list) -> dict:
    """Compute an invite's scope for a tier from the live Wizarr library list.

    The private filter runs last, independent of the tier rules, so no rule
    change can ever share a private library.
    """
    selected = [
        lib for lib in libraries
        if lib.get("enabled") and _tier_wants(tier, lib)
    ]
    shareable = [lib for lib in selected if not _is_private(lib)]
    if tier == "kids" and len(shareable) < len(KIDS_LIBRARIES):
        found = {(lib.get("server_name"), lib.get("name")) for lib in shareable}
        log.error("kids allowlist mismatch; missing %s", sorted(KIDS_LIBRARIES - found))
    return {
        "library_ids": [lib["id"] for lib in shareable],
        "server_ids": sorted({lib["server_id"] for lib in shareable}),
        "allow_downloads": TIER_DOWNLOADS[tier],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest tests/test_tiers.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/tiers.py stripe-bridge/tests/test_tiers.py
git commit -m "WZ: Add tier rules module for invite scoping

- Name-rule library resolution per tier from the live library list
- Hard private filter for Caraxes 9X. libraries runs last, independent
  of tier rules
- Unknown or missing tier normalizes to bronze with an error log"
```

---

### Task 2: WizarrClient library support

**Files:**

- Modify: `stripe-bridge/wizarr.py` (add `list_libraries`; extend `create_invite`)
- Test: `stripe-bridge/tests/test_wizarr.py`

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Task 3):
  - `WizarrClient.list_libraries() -> list` — raw library dicts from `GET /api/libraries` (`id`, `name`, `server_id`, `server_name`, `enabled`).
  - `WizarrClient.create_invite(server_ids, expires_in_days, duration, unlimited=False, library_ids=None, allow_downloads=False) -> dict` — `library_ids=None` omits the key from the payload (Wizarr's own default scoping); a list sends it verbatim. `allow_downloads` is always sent.

- [ ] **Step 1: Write the failing tests**

In `stripe-bridge/tests/test_wizarr.py`, replace `test_create_invite_sends_server_ids_and_returns_code_and_url` with the two tests below, and add `test_list_libraries_returns_raw_library_dicts`:

```python
@responses.activate
def test_create_invite_scopes_libraries_and_downloads():
    responses.post(
        f"{BASE}/api/invitations",
        json={"invitation": {"id": 5, "code": "abc123",
                             "url": f"{BASE}/j/abc123"}},
        status=201,
    )
    out = client().create_invite([1, 2], expires_in_days=7, duration="35",
                                 library_ids=[17, 20], allow_downloads=True)
    assert out == {"code": "abc123", "url": f"{BASE}/j/abc123"}
    sent = json.loads(responses.calls[0].request.body)
    assert sent["server_ids"] == [1, 2]
    assert sent["expires_in_days"] == 7
    assert sent["duration"] == "35"
    assert sent["unlimited"] is False
    assert sent["library_ids"] == [17, 20]
    assert sent["allow_downloads"] is True


@responses.activate
def test_create_invite_omits_library_ids_when_unscoped():
    responses.post(
        f"{BASE}/api/invitations",
        json={"invitation": {"id": 6, "code": "def456",
                             "url": f"{BASE}/j/def456"}},
        status=201,
    )
    client().create_invite([1], expires_in_days=7, duration="35")
    sent = json.loads(responses.calls[0].request.body)
    assert "library_ids" not in sent
    assert sent["allow_downloads"] is False


@responses.activate
def test_list_libraries_returns_raw_library_dicts():
    responses.get(
        f"{BASE}/api/libraries",
        json={"libraries": [
            {"id": 17, "name": "01. TV Shows", "server_id": 1,
             "server_name": "Vermithor", "enabled": True},
            {"id": 37, "name": "99. Tutorials", "server_id": 4,
             "server_name": "Caraxes", "enabled": True},
        ]},
    )
    libs = client().list_libraries()
    assert [lib["id"] for lib in libs] == [17, 37]
    assert libs[0]["server_name"] == "Vermithor"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest tests/test_wizarr.py -v`
Expected: the two `create_invite` tests FAIL with `TypeError: create_invite() got an unexpected keyword argument 'library_ids'`; `test_list_libraries_returns_raw_library_dicts` FAILS with `AttributeError: 'WizarrClient' object has no attribute 'list_libraries'`

- [ ] **Step 3: Implement**

In `stripe-bridge/wizarr.py`, replace the `create_invite` method and add `list_libraries` right after `list_server_ids`:

```python
    def list_libraries(self) -> list:
        """All libraries Wizarr knows (id, name, server_id, server_name, enabled)."""
        r = requests.get(
            f"{self.base_url}/api/libraries",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("libraries", [])

    def create_invite(self, server_ids, expires_in_days: int, duration,
                      unlimited: bool = False, library_ids=None,
                      allow_downloads: bool = False) -> dict:
        """Create an invite for the given servers; return just its code and url.

        library_ids=None leaves scoping to Wizarr's defaults; a list scopes the
        invite to exactly those libraries.
        """
        payload = {
            "server_ids": list(server_ids),
            "expires_in_days": expires_in_days,
            "duration": duration,
            "unlimited": unlimited,
            "allow_downloads": allow_downloads,
        }
        if library_ids is not None:
            payload["library_ids"] = list(library_ids)
        r = requests.post(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            json=payload,
            timeout=10,
        )
        r.raise_for_status()
        inv = r.json()["invitation"]
        return {"code": inv["code"], "url": inv["url"]}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest tests/test_wizarr.py -v`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/wizarr.py stripe-bridge/tests/test_wizarr.py
git commit -m "WZ: Teach WizarrClient library scoping

- Add list_libraries() over GET /api/libraries
- create_invite() accepts library_ids and allow_downloads
- library_ids=None keeps Wizarr's own default scoping"
```

---

### Task 3: Checkout handler reads the tier; drop server-id env scoping

**Files:**

- Modify: `stripe-bridge/stripe_wizarr_bridge.py`
- Modify: `stripe-bridge/wizarr.py` (remove `list_server_ids`)
- Modify: `.env.example` (remove `WIZARR_SERVER_IDS`, document Netlify vars)
- Test: `stripe-bridge/tests/test_bridge.py`, `stripe-bridge/tests/test_wizarr.py`

**Interfaces:**

- Consumes: `tiers.normalize_tier`, `tiers.resolve_tier_access` (Task 1); `client.list_libraries()`, extended `create_invite` (Task 2).
- Produces: checkout invites scoped by tier. `resolve_server_ids()`, `WIZARR_SERVER_IDS`, and `WizarrClient.list_server_ids` are **removed** (servers now derive from the tier's libraries; no back-compat shims).

- [ ] **Step 1: Update the bridge tests**

In `stripe-bridge/tests/test_bridge.py`:

1. Remove `"WIZARR_SERVER_IDS": "all",` from the `os.environ.update({...})` block.
2. Delete `test_resolve_server_ids_explicit_list_overrides_discovery` and `test_resolve_server_ids_empty_env_discovers_from_wizarr`.
3. Add a module-level fixture list after the env block:

```python
FIXTURE_LIBRARIES = [
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 24, "name": "02. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
]
```

With this fixture: bronze → libraries `[17, 24]`, servers `[1, 2]`; silver/gold → `[17, 20, 24]`, servers `[1, 2]`; kids → `[20, 24]`, servers `[1, 2]`; library 37 must never appear.

4. Replace `test_checkout_brand_new_member_invites_without_time_boxing` with:

```python
def test_checkout_brand_new_member_invites_for_its_tier(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://wizarr-lan:5690/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []  # no existing records yet
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "silver"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 7, "35", library_ids=[17, 20, 24], allow_downloads=False)
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")
    # brand-new member has no records to time-box; invite redemption sets expiry
    bridge.client.set_expiry.assert_not_called()
    import store
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["invite_code"] == "abc"
```

5. In `test_checkout_existing_member_time_boxes_all_records`, replace the `list_server_ids` line with `bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES` and add `"metadata": {"tier": "bronze"},` to the session object (the time-boxing assertions stay unchanged).

6. In `test_webhook_route_handles_stripe_object_event`, replace `bridge.client.list_server_ids.return_value = [1, 2, 3]` with `bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES` (the payload carries no metadata — the route must still work and default to bronze).

7. In `test_checkout_falls_back_to_customer_email_field`, replace `bridge.client.list_server_ids.return_value = [1]` with `bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES`.

8. Add three new checkout tests:

```python
def test_checkout_without_tier_metadata_defaults_to_bronze(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_no_tier",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    # bronze: no 4K library, downloads off
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 7, "35", library_ids=[17, 24], allow_downloads=False)


def test_checkout_gold_enables_downloads(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_gold",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 7, "35", library_ids=[17, 20, 24], allow_downloads=True)


def test_checkout_kids_scopes_to_kid_libraries_only(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_kids",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "kids"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 7, "35", library_ids=[20, 24], allow_downloads=True)
```

In `stripe-bridge/tests/test_wizarr.py`: delete `test_list_server_ids_returns_only_verified`, and change `test_wizarr_http_errors_propagate` to use libraries instead of servers:

```python
@responses.activate
def test_wizarr_http_errors_propagate():
    responses.get(f"{BASE}/api/libraries", json={"error": "boom"}, status=500)
    with pytest.raises(requests.HTTPError):
        client().list_libraries()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest tests/test_bridge.py -v`
Expected: the checkout tests FAIL — `create_invite` still called with the old `([...], 7, "35")` shape (assertion mismatch on `library_ids`/`allow_downloads` kwargs).

- [ ] **Step 3: Implement the handler changes**

In `stripe-bridge/stripe_wizarr_bridge.py`:

1. Add `import tiers` after `import store`.
2. Delete the `WIZARR_SERVER_IDS` constant (lines 20–22: the two comment lines and the assignment).
3. Delete the whole `resolve_server_ids` function.
4. In `handle_event`, replace the invite-creation line

```python
        invite = client.create_invite(resolve_server_ids(), INVITE_DAYS, ACCESS_DURATION)
```

with:

```python
        tier = tiers.normalize_tier((obj.get("metadata") or {}).get("tier"))
        access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
        invite = client.create_invite(
            access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
            library_ids=access["library_ids"],
            allow_downloads=access["allow_downloads"],
        )
        log.info("created %s invite (%d libraries, servers %s)",
                 tier, len(access["library_ids"]), access["server_ids"])
```

5. In `stripe-bridge/wizarr.py`, delete the `list_server_ids` method.
6. In `.env.example`: delete the `WIZARR_SERVER_IDS=all` line, and append this comment block at the end:

```bash
# Netlify build-time variables (set in the Netlify dashboard, not in this file):
#   VITE_PAYMENT_LINK_BRONZE_URL, VITE_PAYMENT_LINK_SILVER_URL,
#   VITE_PAYMENT_LINK_GOLD_URL, VITE_PAYMENT_LINK_KIDS_URL, VITE_MEMBER_URL
```

- [ ] **Step 4: Run the full bridge suite**

Run: `cd stripe-bridge && ../venv/bin/python -m pytest -v`
Expected: all pass (tiers, wizarr, bridge, store, email template)

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/stripe_wizarr_bridge.py stripe-bridge/wizarr.py \
  stripe-bridge/tests/test_bridge.py stripe-bridge/tests/test_wizarr.py .env.example
git commit -m "WZ: Scope checkout invites by subscription tier

- Read metadata.tier from the checkout session (payment-link metadata)
- Resolve library_ids/server_ids/allow_downloads via tiers module
- Remove WIZARR_SERVER_IDS and list_server_ids; servers derive from
  the tier's libraries"
```

---

### Task 4: Web tier config

**Files:**

- Modify: `web/src/site.config.ts`
- Test: `web/src/site.config.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Task 5):
  - `type Tier = { id: 'bronze' | 'silver' | 'gold' | 'kids'; name: string; priceLabel: string; features: ReadonlyArray<string>; paymentLinkUrl: string }` (exported).
  - `SiteConfig.tiers: ReadonlyArray<Tier>`; `priceLabel` and `paymentLinkUrl` are **removed** from `SiteConfig`, and `DEFAULT_PAYMENT_LINK_URL` is removed. Unset env → `paymentLinkUrl: ''` (Task 5 hides the card CTA for empty strings).

- [ ] **Step 1: Write the failing tests**

Replace `web/src/site.config.test.ts` with:

```typescript
import { resolveConfig } from '@/site.config'

test('defines the four tiers in order with CAD price labels', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.id)).toEqual(['bronze', 'silver', 'gold', 'kids'])
  expect(config.tiers.map((tier) => tier.priceLabel)).toEqual([
    '$8 CAD / month',
    '$14 CAD / month',
    '$20 CAD / month',
    '$20 CAD / month',
  ])
})

test('tier payment links fall back to empty strings with empty env', () => {
  const config = resolveConfig({ env: {} })
  config.tiers.forEach((tier) => expect(tier.paymentLinkUrl).toBe(''))
})

test('maps each payment link env var to its tier', () => {
  const config = resolveConfig({
    env: {
      VITE_PAYMENT_LINK_BRONZE_URL: 'https://buy.stripe.com/b',
      VITE_PAYMENT_LINK_SILVER_URL: 'https://buy.stripe.com/s',
      VITE_PAYMENT_LINK_GOLD_URL: 'https://buy.stripe.com/g',
      VITE_PAYMENT_LINK_KIDS_URL: 'https://buy.stripe.com/k',
    },
  })
  const byId = Object.fromEntries(config.tiers.map((tier) => [tier.id, tier.paymentLinkUrl]))
  expect(byId).toEqual({
    bronze: 'https://buy.stripe.com/b',
    silver: 'https://buy.stripe.com/s',
    gold: 'https://buy.stripe.com/g',
    kids: 'https://buy.stripe.com/k',
  })
})

test('uses the member url from env when set', () => {
  const config = resolveConfig({ env: { VITE_MEMBER_URL: 'https://invite.example.com' } })
  expect(config.memberUrl).toBe('https://invite.example.com')
})

test('provides three support items', () => {
  const config = resolveConfig({ env: {} })
  expect(config.supportItems).toHaveLength(3)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test`
Expected: site.config tests FAIL (`config.tiers` is undefined); `App.test.tsx` still passes (untouched until Task 5).

- [ ] **Step 3: Implement**

Replace `web/src/site.config.ts` with:

```typescript
type SupportItem = {
  title: string
  detail: string
}

type Tier = {
  id: 'bronze' | 'silver' | 'gold' | 'kids'
  name: string
  priceLabel: string
  features: ReadonlyArray<string>
  paymentLinkUrl: string
}

type SiteConfig = {
  brandName: string
  tagline: string
  memberUrl: string | null
  supportItems: ReadonlyArray<SupportItem>
  tiers: ReadonlyArray<Tier>
}

type RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL?: string
  VITE_PAYMENT_LINK_SILVER_URL?: string
  VITE_PAYMENT_LINK_GOLD_URL?: string
  VITE_PAYMENT_LINK_KIDS_URL?: string
  VITE_MEMBER_URL?: string
}

const SUPPORT_ITEMS: ReadonlyArray<SupportItem> = [
  {
    title: 'Server hardware',
    detail: 'Always-on machines that host and stream the platform.',
  },
  {
    title: 'Storage & bandwidth',
    detail: 'Disks and network capacity that keep everything available.',
  },
  {
    title: 'Maintenance & uptime',
    detail: 'Updates, backups, and monitoring so it stays reliable.',
  },
]

export const resolveConfig = ({ env }: { env: RawEnv }): SiteConfig => ({
  brandName: 'Westeroz',
  tagline: 'A community-run media server. Contribute to the cost of keeping it online.',
  memberUrl: env.VITE_MEMBER_URL ?? null,
  supportItems: SUPPORT_ITEMS,
  tiers: [
    {
      id: 'bronze',
      name: 'Bronze',
      priceLabel: '$8 CAD / month',
      features: ['Standard streaming quality', 'Watch on all your devices'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_BRONZE_URL ?? '',
    },
    {
      id: 'silver',
      name: 'Silver',
      priceLabel: '$14 CAD / month',
      features: ['Everything in Bronze', '4K streaming support'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_SILVER_URL ?? '',
    },
    {
      id: 'gold',
      name: 'Gold',
      priceLabel: '$20 CAD / month',
      features: ['Everything in Silver', 'Offline downloads'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_GOLD_URL ?? '',
    },
    {
      id: 'kids',
      name: 'Kids',
      priceLabel: '$20 CAD / month',
      features: ['Family plan curated for kids', '4K streaming support', 'Offline downloads'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_KIDS_URL ?? '',
    },
  ],
})

const env: RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL: import.meta.env.VITE_PAYMENT_LINK_BRONZE_URL,
  VITE_PAYMENT_LINK_SILVER_URL: import.meta.env.VITE_PAYMENT_LINK_SILVER_URL,
  VITE_PAYMENT_LINK_GOLD_URL: import.meta.env.VITE_PAYMENT_LINK_GOLD_URL,
  VITE_PAYMENT_LINK_KIDS_URL: import.meta.env.VITE_PAYMENT_LINK_KIDS_URL,
  VITE_MEMBER_URL: import.meta.env.VITE_MEMBER_URL,
}

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem, Tier }
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test`
Expected: site.config tests pass. `App.test.tsx` now FAILS (it imports the removed `DEFAULT_PAYMENT_LINK_URL`) — expected mid-refactor; Task 5 rewrites it. Verify only the site.config file: `cd web && bun run test src/site.config.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/site.config.ts web/src/site.config.test.ts
git commit -m "WZ: Add four-tier config to the web site config

- tiers array with CAD price labels and capability-framed features
- Per-tier VITE_PAYMENT_LINK_*_URL env vars replace the single link
- Unset env resolves to an empty link (card CTA hidden)"
```

---

### Task 5: Pricing component; rewire Hero and App

**Files:**

- Create: `web/src/components/Pricing/Pricing.tsx`
- Create: `web/src/components/Pricing/Pricing.module.scss`
- Create: `web/src/components/Pricing/Pricing.test.tsx`
- Modify: `web/src/components/Hero/Hero.tsx`, `web/src/components/Hero/Hero.module.scss`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**

- Consumes: `Tier` type and `siteConfig.tiers` (Task 4).
- Produces: `Pricing` component with props `{ tiers: ReadonlyArray<Tier> }`, rendered section `id="pricing"`; `Hero` props shrink to `{ brandName: string; tagline: string }` with its CTA hard-linked to `#pricing`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/Pricing/Pricing.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import Pricing from '@/components/Pricing/Pricing'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'bronze',
    name: 'Bronze',
    priceLabel: '$8 CAD / month',
    features: ['Standard streaming quality'],
    paymentLinkUrl: 'https://buy.stripe.com/test_bronze',
  },
  {
    id: 'gold',
    name: 'Gold',
    priceLabel: '$20 CAD / month',
    features: ['Offline downloads'],
    paymentLinkUrl: '',
  },
]

test('renders a card per tier with price and features', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByText('$8 CAD / month')).toBeInTheDocument()
  expect(screen.getByText('Standard streaming quality')).toBeInTheDocument()
})

test('links the CTA to the tier payment link', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('link', { name: 'Choose Bronze' })).toHaveAttribute(
    'href',
    'https://buy.stripe.com/test_bronze',
  )
})

test('hides the CTA when the payment link is not configured', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.queryByRole('link', { name: 'Choose Gold' })).toBeNull()
})
```

Replace `web/src/App.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react'
import App from '@/App'

test('renders the brand heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
})

test('hero CTA scrolls to the pricing section', () => {
  render(<App />)
  expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '#pricing')
})

test('renders the four tier cards', () => {
  render(<App />)
  ;['Bronze', 'Silver', 'Gold', 'Kids'].forEach((name) => {
    expect(screen.getByRole('heading', { name })).toBeInTheDocument()
  })
})

test('renders the three support items', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Server hardware' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Storage & bandwidth' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Maintenance & uptime' })).toBeInTheDocument()
})

test('hides the member link by default (no VITE_MEMBER_URL)', () => {
  render(<App />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test`
Expected: Pricing tests FAIL (module not found); App tests FAIL (Hero still takes payment props; no pricing cards).

- [ ] **Step 3: Implement**

Create `web/src/components/Pricing/Pricing.tsx`:

```tsx
import type { Tier } from '@/site.config'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
}

const Pricing = ({ tiers }: PricingProps) => (
  <section id="pricing" className={styles.pricing}>
    {tiers.map(({ id, name, priceLabel, features, paymentLinkUrl }) => (
      <article key={id} className={styles.card}>
        <h2 className={styles.name}>{name}</h2>
        <p className={styles.price}>{priceLabel}</p>
        <ul className={styles.features}>
          {features.map((feature) => (
            <li key={feature} className={styles.feature}>
              {feature}
            </li>
          ))}
        </ul>
        {!!paymentLinkUrl && (
          <a className={styles.cta} href={paymentLinkUrl}>
            Choose {name}
          </a>
        )}
      </article>
    ))}
  </section>
)

export default Pricing
```

Create `web/src/components/Pricing/Pricing.module.scss`:

```scss
.pricing {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  padding: var(--space-6) var(--space-3);
}

.card {
  display: grid;
  gap: var(--space-2);
  align-content: start;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.name {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.price {
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.features {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.feature {
  font-size: var(--font-size-sm);
  color: var(--color-muted);
}

.cta {
  display: inline-grid;
  align-items: center;
  justify-self: start;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-weight: 600;
  text-decoration: none;
}
```

Replace `web/src/components/Hero/Hero.tsx` with:

```tsx
import styles from '@/components/Hero/Hero.module.scss'

type HeroProps = {
  brandName: string
  tagline: string
}

const Hero = ({ brandName, tagline }: HeroProps) => (
  <section className={styles.hero}>
    <h1 className={styles.brand}>{brandName}</h1>
    <p className={styles.tagline}>{tagline}</p>
    <a className={styles.cta} href="#pricing">
      Choose a plan
    </a>
  </section>
)

export default Hero
```

In `web/src/components/Hero/Hero.module.scss`, delete the now-unused `.price` block:

```scss
.price {
  font-size: var(--font-size-lg);
  font-weight: 600;
}
```

Replace `web/src/App.tsx` with:

```tsx
import Hero from '@/components/Hero/Hero'
import Pricing from '@/components/Pricing/Pricing'
import Support from '@/components/Support/Support'
import Footer from '@/components/Footer/Footer'
import { siteConfig } from '@/site.config'
import styles from '@/App.module.scss'

const App = () => (
  <main className={styles.page}>
    <Hero brandName={siteConfig.brandName} tagline={siteConfig.tagline} />
    <Pricing tiers={siteConfig.tiers} />
    <Support items={siteConfig.supportItems} />
    <Footer memberUrl={siteConfig.memberUrl} />
  </main>
)

export default App
```

- [ ] **Step 4: Run the full web suite and repo checks**

Run: `cd web && bun run test && bun run typecheck`
Expected: all tests pass, no type errors.
Then from the repo root: `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Pricing web/src/components/Hero web/src/App.tsx web/src/App.test.tsx
git commit -m "WZ: Replace single price CTA with four pricing cards

- New Pricing component renders a card per tier with its payment link
- Card CTA hidden until the tier's payment link env var is set
- Hero slims to brand + tagline and scrolls to #pricing"
```

---

### Task 6: Stripe Test-mode products and payment links (operator-assisted)

**Files:** none (Stripe Dashboard/CLI state only). Requires the operator's authenticated `stripe` CLI in **Test mode** (no `--live` flag anywhere).

**Interfaces:**

- Consumes: nothing from code.
- Produces: four Test-mode payment links, each carrying `metadata[tier]`, consumed by Task 7 (Netlify env vars + E2E).

- [ ] **Step 1: Tag the existing Bronze payment link**

```bash
stripe payment_links list --limit 10
```

Find the link whose `line_items` price belongs to "Media Server Hosting (Bronze)" (its URL should match the current `VITE_PAYMENT_LINK_URL` on Netlify: `https://buy.stripe.com/test_28EaEW9nG7Zjb1Z6BE1VK00`). Then:

```bash
stripe payment_links update plink_BRONZE_ID -d "metadata[tier]=bronze"
```

Verify: `stripe payment_links retrieve plink_BRONZE_ID` shows `"metadata": {"tier": "bronze"}`.

- [ ] **Step 2: Create Silver, Gold, and Kids products, prices, and links**

For each row of: Silver / 1400 / `Server-cost contribution with 4K streaming support.`; Gold / 2000 / `Server-cost contribution with 4K streaming support and offline downloads.`; Kids / 2000 / `Family server-cost contribution, curated for kids, with offline downloads.`:

```bash
stripe products create --name "Media Server Hosting (Silver)" \
  --description "Server-cost contribution with 4K streaming support."
# note the prod_... id, then:
stripe prices create -d "product=prod_SILVER_ID" -d "currency=cad" \
  -d "unit_amount=1400" -d "recurring[interval]=month"
# note the price_... id, then:
stripe payment_links create -d "line_items[0][price]=price_SILVER_ID" \
  -d "line_items[0][quantity]=1" -d "metadata[tier]=silver"
```

Repeat with `(Gold)` / `unit_amount=2000` / `metadata[tier]=gold`, and `(Kids)` / `unit_amount=2000` / `metadata[tier]=kids`.

- [ ] **Step 3: Verify all four links**

```bash
stripe payment_links list --limit 10
```

Expected: four active links; each `metadata.tier` is exactly one of `bronze`, `silver`, `gold`, `kids`; prices 800/1400/2000/2000 CAD monthly. Record the four `https://buy.stripe.com/test_...` URLs for Task 7.

---

### Task 7: Deploy and per-tier E2E verification (operator-assisted)

**Files:** none in-repo (NAS `.env`, Netlify env vars, live verification).

**Interfaces:**

- Consumes: deployed bridge (Tasks 1–3), built web app (Tasks 4–5), payment links (Task 6).
- Produces: verified tier flow in Test mode.

- [ ] **Step 1: Update the NAS .env and deploy**

Remove the `WIZARR_SERVER_IDS` line from the NAS bridge env (and from the local `.env` to match `.env.example`):

```bash
ssh crivas@192.168.50.2 "sed -i '/^WIZARR_SERVER_IDS=/d' /volume1/docker/wizteros/.env"
npm run deploy:nas
```

Then force-recreate the `stripe-bridge` container in Container Manager on Meleys (docker needs sudo on the NAS, so this is a UI step). Confirm startup: the container log should show uvicorn listening with no `KeyError` (proves no lingering env dependency).

- [ ] **Step 2: Point Netlify at the four payment links**

In the Netlify site settings (Environment variables): delete `VITE_PAYMENT_LINK_URL`; add `VITE_PAYMENT_LINK_BRONZE_URL`, `VITE_PAYMENT_LINK_SILVER_URL`, `VITE_PAYMENT_LINK_GOLD_URL`, `VITE_PAYMENT_LINK_KIDS_URL` with the Task 6 URLs. Trigger a redeploy and confirm the live page shows four cards whose CTAs point at the four `buy.stripe.com/test_...` URLs.

- [ ] **Step 3: Run one test checkout per tier**

For each tier, open its payment link and pay with Stripe's test card `4242 4242 4242 4242` (any future expiry, any CVC), using a fresh email per tier (e.g. `cj.rivas.dev+bronze@gmail.com`, `+silver`, `+gold`, `+kids`).

- [ ] **Step 4: Verify each invite's scope via the Wizarr API**

After each checkout, from the repo root:

```bash
set -a && source .env && set +a
curl -sS -H "X-API-Key: $WIZARR_API_KEY" "$WIZARR_BASE_URL/api/invitations" | python3 -m json.tool | tail -60
```

And check the bridge log line on the NAS (Container Manager → stripe-bridge → logs) for each event: `created <tier> invite (<n> libraries, servers [...])`.

Expected per tier against the live 31-library list:

- bronze: 24 libraries, servers `[1, 2, 3, 4, 5]`, no library whose name contains "4K", downloads off
- silver: 27 libraries, servers `[1, 2, 3, 4, 5]`, includes the three 4K libraries, downloads off
- gold: same 27 libraries, downloads on
- kids: 3 libraries (`06. Kid Shows`, `02. Family Movies`, `04. 4K Family Movies`), servers Vermithor + Meleys only, downloads on
- **every tier**: none of `96. Assignments`, `97. Home Videos`, `98. Documents`, `99. Tutorials`

- [ ] **Step 5: Record completion**

Update the "What's done vs what's next" section of `CLAUDE.md`: add a Done bullet `Four subscription tiers (Bronze/Silver/Gold/Kids) live in Test mode: payment-link metadata -> tier-scoped Wizarr invites, verified per tier E2E`, then commit:

```bash
git add CLAUDE.md
git commit -m "WZ: Record tier rollout in project context

- Test-mode tier flow verified end to end per tier"
```
