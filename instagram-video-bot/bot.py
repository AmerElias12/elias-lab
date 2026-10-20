#!/usr/bin/env python3
"""Instagram Reels bot: render a Reel from a spec file, then post it.

    python bot.py render reels/01-meet-the-lab.toml   # make the MP4, post nothing
    python bot.py post   reels/01-meet-the-lab.toml   # render it and post it
    python bot.py next                                # post the next reel not yet posted
    python bot.py status                              # what is posted, what is queued
    python bot.py check                               # every spec, and the login

`post` and `next` take --dry-run: render, show the caption, call nothing.

Credentials come from the environment or from a .env file beside this script
(see .env.example). posted.json records what went out; see reelbot/ledger.py.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys

from reelbot import render as rendering
from reelbot import spec as specs
from reelbot.instagram import DEFAULT_HOST, DEFAULT_VERSION, Instagram, InstagramError
from reelbot.ledger import Ledger

BOT_DIR = pathlib.Path(__file__).resolve().parent
REELS_DIR = BOT_DIR / "reels"
OUT_DIR = BOT_DIR / "out"
LEDGER = BOT_DIR / "posted.json"


def load_env(path: pathlib.Path) -> None:
    """KEY=value lines from .env, for anything not already in the environment."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def client() -> Instagram:
    return Instagram(
        os.environ.get("IG_USER_ID", ""),
        os.environ.get("IG_ACCESS_TOKEN", ""),
        api_version=os.environ.get("IG_API_VERSION") or DEFAULT_VERSION,
        host=os.environ.get("IG_GRAPH_HOST") or DEFAULT_HOST,
    )


def queued(reels_dir: pathlib.Path) -> list[pathlib.Path]:
    return sorted(reels_dir.glob("*.toml"))


def render_reel(reel: specs.Reel, args) -> pathlib.Path:
    out = pathlib.Path(args.out) if getattr(args, "out", None) else OUT_DIR / f"{reel.name}.mp4"
    n = len(reel.slides)
    print(f"rendering {reel.name} ({reel.duration:.1f}s, {n} slide{'s' if n != 1 else ''})")
    path = rendering.render(reel, out, font=args.font, keep_work=args.keep_work)
    facts = rendering.probe(path)
    print(f"  -> {path} ({facts['bytes'] / 1e6:.1f} MB)")
    return path


def post_reel(reel: specs.Reel, ledger: Ledger, args, *, ig: Instagram | None = None) -> None:
    name = reel.name
    entry = ledger.get(name)
    if entry and entry["status"] == "published":
        raise SystemExit(f"error: {name} was already posted ({entry.get('permalink') or entry.get('media_id')}); "
                         "rename the spec to post it again")

    if args.dry_run:
        render_reel(reel, args)
        print("\n--- caption " + "-" * 40)
        print(reel.full_caption())
        print("-" * 52)
        print("dry run: nothing was sent to Instagram")
        return

    ig = ig or client()

    # A previous run got as far as publishing and then stopped. Ask Instagram
    # what happened before doing anything that could post it twice.
    if entry and entry["status"] == "publishing":
        cid = entry["container_id"]
        code, _ = ig.container_status(cid)
        print(f"resuming {name}: container {cid} is {code or 'unknown'}")
        if code == "PUBLISHED":
            ledger.published(name, container_id=cid, media_id=None, permalink=None)
            print(f"{name} had in fact been posted; recorded it")
            return
        if code in ("FINISHED", "IN_PROGRESS"):
            ig.wait_until_ready(cid)
            _publish(ig, ledger, name, cid)
            return
        ledger.forget(name)  # expired or failed: start again

    video = render_reel(reel, args)
    print("uploading to Instagram")
    thumb = round(reel.cover_at * 1000) if reel.cover_at is not None else None
    cid, uri = ig.create_container(reel.full_caption(), share_to_feed=reel.share_to_feed,
                                   thumb_offset_ms=thumb)
    ig.upload(uri, video)
    ig.wait_until_ready(cid)
    _publish(ig, ledger, name, cid)


def _publish(ig: Instagram, ledger: Ledger, name: str, cid: str) -> None:
    ledger.publishing(name, cid)
    media_id = ig.publish(cid)
    link = ig.permalink(media_id)
    ledger.published(name, container_id=cid, media_id=media_id, permalink=link)
    print(f"posted {name}: {link or media_id}")


# ── commands ────────────────────────────────────────────────────

def cmd_render(args) -> None:
    render_reel(specs.load(args.spec), args)


def cmd_post(args) -> None:
    post_reel(specs.load(args.spec), Ledger(args.ledger), args)


def cmd_next(args) -> None:
    ledger = Ledger(args.ledger)
    for path in queued(pathlib.Path(args.reels)):
        if not ledger.is_published(path.stem):
            post_reel(specs.load(path), ledger, args)
            return
    print("nothing queued: every reel in reels/ has been posted")


def cmd_status(args) -> None:
    ledger = Ledger(args.ledger)
    paths = queued(pathlib.Path(args.reels))
    if not paths:
        print("no reels in", args.reels)
    for path in paths:
        entry = ledger.get(path.stem) or {}
        if entry.get("status") == "published":
            state = f"posted {entry['posted_at'][:10]}  {entry.get('permalink') or ''}"
        elif entry.get("status") == "publishing":
            state = "interrupted while publishing; the next run resumes it"
        else:
            state = "queued"
        print(f"  {path.stem:32} {state}")


def cmd_check(args) -> None:
    problems = 0
    for path in queued(pathlib.Path(args.reels)):
        try:
            reel = specs.load(path)
            print(f"  ok    {path.name} ({reel.duration:.1f}s)")
        except specs.SpecError as exc:
            problems += 1
            print(f"  FAIL  {exc}")
    try:
        rendering.find_font(args.font)
        rendering._require("ffmpeg")
        print("  ok    ffmpeg and a font")
    except rendering.RenderError as exc:
        problems += 1
        print(f"  FAIL  {exc}")
    try:
        me = client().account()
        quota = ""
        if me.get("quota_usage") is not None:
            quota = f", {me['quota_usage']}/{me.get('quota_total', '?')} posts used in the last 24h"
        print(f"  ok    logged in as @{me.get('username', '?')}{quota}")
    except InstagramError as exc:
        problems += 1
        print(f"  FAIL  {exc}")
    if problems:
        raise SystemExit(1)


def main(argv: list[str] | None = None) -> None:
    load_env(BOT_DIR / ".env")

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--reels", default=str(REELS_DIR), help="folder of reel specs (default: reels/)")
    p.add_argument("--ledger", default=str(LEDGER), help="record of posted reels (default: posted.json)")
    p.add_argument("--font", help="bold .ttf/.otf for the slide text (or set REELBOT_FONT)")
    p.add_argument("--keep-work", action="store_true", help="keep ffmpeg's intermediate files")
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("render", help="render a spec to an MP4; posts nothing")
    r.add_argument("spec")
    r.add_argument("-o", "--out", help="output file (default: out/<name>.mp4)")
    r.set_defaults(func=cmd_render)

    for name, fn, helptext in (("post", cmd_post, "render a spec and post it"),
                               ("next", cmd_next, "post the first reel in reels/ not yet posted")):
        s = sub.add_parser(name, help=helptext)
        if name == "post":
            s.add_argument("spec")
        s.add_argument("--dry-run", action="store_true", help="render and show the caption; post nothing")
        s.set_defaults(func=fn)

    sub.add_parser("status", help="list reels and whether each is posted").set_defaults(func=cmd_status)
    sub.add_parser("check", help="validate every spec, ffmpeg, and the Instagram login").set_defaults(func=cmd_check)

    args = p.parse_args(argv)
    try:
        args.func(args)
    except (specs.SpecError, rendering.RenderError, InstagramError) as exc:
        raise SystemExit(f"error: {exc}")


if __name__ == "__main__":
    sys.exit(main())
