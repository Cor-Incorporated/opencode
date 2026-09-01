#!/usr/bin/env python3
"""Keep the model whitelist in step with the models.dev catalog.

Why this exists
---------------
The whitelist lives in three places that must move together:

  1. packages/guardrails/managed/opencode.json   (admin profile)
  2. packages/guardrails/profile/opencode.json   (packaged profile)
  3. guardrail-patterns.ts `paid`                (cost-0-but-billed classification)

On 2026-09-02 all three were stale at once. `glm-5.3-flash` (released
2026-08-26) was absent everywhere, as were `claude-opus-5`, `claude-sonnet-5`
and `gpt-5.6-luna` -- the last being the model Codex itself runs. The provider
*routes* were all present, which is what made the staleness easy to miss:
"is deepseek wired up?" answers yes while the model list rots underneath.

The refresh that closed that gap was done by hand. Doing it by hand is the
defect: nothing detects the next drift. This script makes the refresh
mechanical and, more importantly, gives `--check` a way to fail.

The snapshot
------------
`--check` must run offline, in CI, without a warm `~/.cache/opencode`. So the
catalog subset we care about is committed to the repo as a snapshot, and the
test compares whitelist against snapshot. Refreshing is two steps that belong
in one commit:

    python3 scripts/sync-model-whitelist.py --refresh-snapshot   # catalog -> snapshot
    python3 scripts/sync-model-whitelist.py --apply              # snapshot -> whitelist

The snapshot is the declaration of "what the catalog offered on date X"; the
whitelist is "what we allow". `--check` links the two, so a snapshot refresh
that forgets to apply fails, and so does a hand-edit that drops a model.

Detecting drift against the *live* catalog still needs network; that stays
with `local-dev-deploy.sh --check-openrouter-catalog`.

Add-only
--------
Entries are never removed. models.dev does not list the `gpt-5.x-codex` ids
(reachable only through the Codex OAuth flow) and does not list the DeepSeek
direct-API ids `deepseek-chat` / `deepseek-reasoner`, both of which still
answer. A sync that treats the catalog as the sole truth deletes working
routes -- that happened once already during the 2026-09-02 refresh and had to
be reverted.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANAGED = ROOT / "packages/guardrails/managed/opencode.json"
PROFILE = ROOT / "packages/guardrails/profile/opencode.json"
PATTERNS = ROOT / "packages/guardrails/profile/plugins/guardrail-patterns.ts"
SNAPSHOT = ROOT / "packages/guardrails/model-catalog-snapshot.json"
DEFAULT_CATALOG = Path.home() / ".cache/opencode/models.json"

# Providers whose models report cost 0 because a plan or subscription covers
# them. `paid` marks those so isFree() does not treat them as genuinely free.
# openrouter reports real per-token cost and is deliberately absent.
PAID_PROVIDERS = ("zai", "zai-coding-plan", "deepseek", "openai")


def enabled_providers() -> list[str]:
    return list(json.loads(MANAGED.read_text()).get("enabled_providers", []))


def usable(meta: dict) -> bool:
    """Coding-relevant: can call tools and can emit text."""
    if not meta.get("tool_call"):
        return False
    out = (meta.get("modalities") or {}).get("output") or []
    return (not out) or ("text" in out)


def build_snapshot(catalog_path: Path) -> dict:
    catalog = json.loads(catalog_path.read_text())
    snapshot: dict[str, dict] = {}
    for pid in enabled_providers():
        models = (catalog.get(pid) or {}).get("models", {})
        snapshot[pid] = {
            mid: {
                "release_date": meta.get("release_date") or "",
                "reasoning": bool(meta.get("reasoning")),
                "context": (meta.get("limit") or {}).get("context"),
            }
            for mid, meta in models.items()
            if usable(meta)
        }
    return snapshot


def read_snapshot() -> dict:
    if not SNAPSHOT.exists():
        sys.exit(f"snapshot missing: {SNAPSHOT}\nrun --refresh-snapshot first")
    return json.loads(SNAPSHOT.read_text())


def paid_sets() -> dict[str, list[str]]:
    """Parse the `paid` literal out of guardrail-patterns.ts."""
    src = PATTERNS.read_text()
    body = re.search(r"export const paid[^=]*=\s*\{(.*?)\n\}", src, re.S)
    if not body:
        sys.exit(f"could not locate `export const paid` in {PATTERNS}")
    out: dict[str, list[str]] = {}
    for hit in re.finditer(
        r'"?([\w-]+)"?\s*:\s*new Set\(\[(.*?)\]\)', body.group(1), re.S
    ):
        out[hit.group(1)] = re.findall(r'"([^"]+)"', hit.group(2))
    return out


def write_paid(additions: dict[str, list[str]]) -> None:
    """Add ids into the `paid` sets, preserving every existing entry."""
    src = PATTERNS.read_text()
    for pid, extra in additions.items():
        if not extra:
            continue
        key = pid if re.fullmatch(r"\w+", pid) else f'"{pid}"'
        pattern = re.compile(
            r"(\n  " + re.escape(key) + r": new Set\(\[)(.*?)(\n  \]\),)", re.S
        )
        hit = pattern.search(src)
        if not hit:
            sys.exit(f"could not locate paid entry for {pid} in {PATTERNS}")
        have = re.findall(r'"([^"]+)"', hit.group(2))
        merged = sorted(set(have) | set(extra))
        rendered = "".join(f'\n    "{mid}",' for mid in merged)
        src = (
            src[: hit.start()]
            + hit.group(1)
            + rendered
            + hit.group(3)
            + src[hit.end() :]
        )
    PATTERNS.write_text(src)


def whitelists(path: Path) -> dict[str, list[str]]:
    cfg = json.loads(path.read_text())
    return {
        pid: val.get("whitelist", [])
        for pid, val in (cfg.get("provider") or {}).items()
    }


def write_whitelists(path: Path, merged: dict[str, list[str]]) -> None:
    cfg = json.loads(path.read_text())
    for pid, ids in merged.items():
        cfg.setdefault("provider", {}).setdefault(pid, {})["whitelist"] = ids
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")


def check(snapshot: dict) -> list[str]:
    problems: list[str] = []
    mg, pf, paid = whitelists(MANAGED), whitelists(PROFILE), paid_sets()

    for pid in enabled_providers():
        have_mg, have_pf = set(mg.get(pid, [])), set(pf.get(pid, []))
        if have_mg != have_pf:
            only_mg = sorted(have_mg - have_pf)
            only_pf = sorted(have_pf - have_mg)
            problems.append(
                f"{pid}: managed and profile disagree -- "
                f"managed-only={only_mg or '[]'} profile-only={only_pf or '[]'}"
            )
        missing = sorted(set(snapshot.get(pid, {})) - have_mg)
        if missing:
            problems.append(
                f"{pid}: {len(missing)} catalog models are not whitelisted "
                f"(snapshot has {len(snapshot.get(pid, {}))}, whitelist has {len(have_mg)}): "
                + ", ".join(missing[:8])
                + (f" ... +{len(missing) - 8}" if len(missing) > 8 else "")
            )
        if pid in PAID_PROVIDERS:
            unclassified = sorted(have_mg - set(paid.get(pid, [])))
            if unclassified:
                problems.append(
                    f"{pid}: {len(unclassified)} whitelisted models missing from `paid`, "
                    "so a plan-covered model would be misread as free: "
                    + ", ".join(unclassified[:8])
                )
    return problems


def apply(snapshot: dict) -> dict[str, int]:
    mg, pf, paid = whitelists(MANAGED), whitelists(PROFILE), paid_sets()
    merged: dict[str, list[str]] = {}
    paid_add: dict[str, list[str]] = {}
    added: dict[str, int] = {}

    for pid in enabled_providers():
        # add-only: the union keeps ids the catalog does not list (Codex OAuth
        # models, DeepSeek direct-API ids) that would otherwise be deleted.
        union = sorted(
            set(mg.get(pid, [])) | set(pf.get(pid, [])) | set(snapshot.get(pid, {}))
        )
        added[pid] = len(union) - len(set(mg.get(pid, [])))
        merged[pid] = union
        if pid in PAID_PROVIDERS:
            paid_add[pid] = sorted(set(union) - set(paid.get(pid, [])))

    write_whitelists(MANAGED, merged)
    write_whitelists(PROFILE, merged)
    write_paid(paid_add)
    return added


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help=f"models.dev cache to read (default: {DEFAULT_CATALOG})",
    )
    ap.add_argument(
        "--refresh-snapshot",
        action="store_true",
        help="regenerate the committed snapshot from --catalog",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="add every snapshot model missing from the whitelists (add-only)",
    )
    args = ap.parse_args()

    if args.refresh_snapshot:
        if not args.catalog.exists():
            sys.exit(
                f"catalog not found: {args.catalog}\nrun `opencode models` once to populate it"
            )
        snapshot = build_snapshot(args.catalog)
        SNAPSHOT.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
        for pid, models in snapshot.items():
            print(f"  snapshot {pid:18} {len(models):4} models")
        print(f"wrote {SNAPSHOT.relative_to(ROOT)}")

    snapshot = read_snapshot()

    if args.apply:
        for pid, n in apply(snapshot).items():
            print(f"  {pid:18} +{n}")
        print("applied to managed, profile and `paid`")

    problems = check(snapshot)
    if problems:
        print(
            "\nFAIL: whitelist is out of step with the catalog snapshot",
            file=sys.stderr,
        )
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("ok   whitelist covers the catalog snapshot in all three copies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
