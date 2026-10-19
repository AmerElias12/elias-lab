#!/usr/bin/env python3
"""The daily Reel: Claude plans it, Kling renders it, ffmpeg finishes it, Instagram gets it.

    python pipeline.py run                 # the whole day: plan, video, edit, post
    python pipeline.py run --no-post       # stop before Instagram; look at out/daily/<date>/reel.mp4
    python pipeline.py run --plan-only     # just ask Claude for today's plan (cheap)
    python pipeline.py edit clip.mp4 -s "Line one" -s "Line two"   # the ffmpeg step on any clip
    python pipeline.py check               # config, ffmpeg, keys, Instagram login

scheduler/ runs `pipeline.py run` once a day with node-cron.

Every stage leaves its result in out/daily/<date>/ (plan.json, state.json,
raw.mp4, reel.mp4) and is skipped when that result is already there. So a run
that fails at any point can simply be run again: it does not re-ask Claude,
does not pay for a second video, and never posts the same day twice. To redo a
stage, delete its file (or the whole folder, to start the day over).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import tomllib

import bot
from reelbot import edit, generator, render, writer
from reelbot.instagram import InstagramError
from reelbot.ledger import Ledger
from reelbot.publish import AlreadyPosted, publish

BOT_DIR = pathlib.Path(__file__).resolve().parent
CONFIG = BOT_DIR / "pipeline.toml"
DAILY_DIR = BOT_DIR / "out" / "daily"

REQUIRED = {
    "character": ["name", "look", "personality", "style"],
    "content": ["brand", "audience"],
    "video": ["provider"],
}


class PipelineError(RuntimeError):
    pass


def load_config(path: pathlib.Path) -> dict:
    try:
        cfg = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PipelineError(f"{path} not found") from None
    except tomllib.TOMLDecodeError as exc:
        raise PipelineError(f"{path.name} is not valid TOML: {exc}") from None
    for section, keys in REQUIRED.items():
        for key in keys:
            if not str((cfg.get(section) or {}).get(key, "")).strip():
                raise PipelineError(f"{path.name}: [{section}] needs {key}")
    for section in ("edit", "post"):
        cfg.setdefault(section, {})
    if cfg["video"]["provider"] not in ("piapi", "kling"):
        raise PipelineError(f"{path.name}: [video] provider must be \"piapi\" or \"kling\"")
    if int(cfg["video"].get("duration", 5)) not in (5, 10):
        raise PipelineError(f"{path.name}: [video] duration must be 5 or 10")
    return cfg


class Day:
    """out/daily/<date>/: what has been done today, and its results."""

    def __init__(self, root: pathlib.Path, date: str):
        self.date = date
        self.key = f"daily-{date}"
        self.dir = root / date
        self.dir.mkdir(parents=True, exist_ok=True)
        self.raw = self.dir / "raw.mp4"
        self.final = self.dir / "reel.mp4"
        self._state_path = self.dir / "state.json"
        self.state = json.loads(self._state_path.read_text()) if self._state_path.exists() else {}

    def save(self) -> None:
        tmp = self._state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, self._state_path)


def recent(ledger: Ledger, field: str, n: int = 14) -> list[str]:
    rows = [e for e in ledger.entries.values() if e.get("status") == "published" and e.get(field)]
    rows.sort(key=lambda e: e.get("posted_at", ""), reverse=True)
    return [e[field] for e in rows[:n]]


def last_used_tracks(ledger: Ledger) -> dict[str, str]:
    used: dict[str, str] = {}
    for e in ledger.entries.values():
        if e.get("track"):
            used[e["track"]] = max(used.get(e["track"], ""), e.get("posted_at", ""))
    return used


def run(cfg: dict, date: str, *, ledger: Ledger, daily_dir: pathlib.Path = DAILY_DIR,
        plan_only: bool = False, no_post: bool = False, font: str | None = None,
        anthropic_client=None, provider=None, ig=None, http=None,
        sleep=None, log=print) -> pathlib.Path | None:
    day = Day(daily_dir, date)
    if ledger.is_published(day.key):
        log(f"{date}: already posted ({ledger.get(day.key).get('permalink')}); nothing to do")
        return None
    log(f"{date}: daily reel")
    video_cfg = cfg["video"]
    duration = int(video_cfg.get("duration", 5))

    # 1. Plan ─────────────────────────────────────────────────────
    if "plan" not in day.state:
        log("  asking Claude for today's plan")
        plan = writer.write_plan(cfg, recent=recent(ledger, "topic"), today=date,
                                 duration=duration, client=anthropic_client,
                                 model=os.environ.get("ANTHROPIC_MODEL") or None)
        day.state["plan"] = plan.model_dump()
        day.save()
        (day.dir / "plan.json").write_text(writer.to_json(plan) + "\n")
    plan = writer.Plan(**day.state["plan"])
    log(f"  topic: {plan.topic}")
    if plan_only:
        log(writer.to_json(plan))
        return None

    # 2. Video ────────────────────────────────────────────────────
    if not day.raw.exists():
        provider = provider or generator.from_env(os.environ, video_cfg)
        if not day.state.get("task_id"):
            log(f"  requesting a {duration}s clip from {provider.name}")
            day.state["task_id"] = provider.submit(plan.video_prompt,
                                                   video_cfg.get("negative_prompt", ""))
            day.state["provider"] = provider.name
            day.save()
        wait_kw = {"timeout": float(video_cfg.get("timeout_minutes", 30)) * 60, "log": log}
        if sleep:
            wait_kw["sleep"] = sleep
        try:
            url = generator.wait(provider, day.state["task_id"], **wait_kw)
        except generator.TaskFailed:
            # A failed task never recovers; forget it so the next run asks again.
            day.state.pop("task_id", None)
            day.save()
            raise
        log("  downloading the clip")
        generator.download(url, day.raw, session=http)

    # 3. Edit ─────────────────────────────────────────────────────
    if not day.final.exists():
        ecfg = cfg["edit"]
        music_dir = BOT_DIR / ecfg.get("music_dir", "music")
        track = edit.pick_track(music_dir, last_used_tracks(ledger))
        if track is None:
            log(f"  no music in {music_dir.name}/; the reel keeps the clip's own sound")
        edit.finish(day.raw, day.final, subtitles=plan.subtitles, music=track,
                    music_volume=float(ecfg.get("music_volume", 0.9)),
                    original_volume=float(ecfg.get("original_volume", 0.0)),
                    font=font, log=log)
        day.state["track"] = track.name if track else None
        day.save()
    log(f"  -> {day.final}")

    caption = writer.full_caption(plan)
    if no_post:
        log("\n--- caption " + "-" * 40 + f"\n{caption}\n" + "-" * 52)
        log("not posted (--no-post); run without it to post this reel")
        return day.final

    # 4. Post ─────────────────────────────────────────────────────
    publish(ig or bot.client(), ledger, day.key, lambda: day.final, caption,
            share_to_feed=bool(cfg["post"].get("share_to_feed", True)),
            extra={"topic": plan.topic, "track": day.state.get("track")}, log=log)
    return day.final


# ── commands ────────────────────────────────────────────────────

def cmd_run(args) -> None:
    cfg = load_config(pathlib.Path(args.config))
    run(cfg, args.date, ledger=Ledger(args.ledger), plan_only=args.plan_only,
        no_post=args.no_post, font=args.font)


def cmd_edit(args) -> None:
    cfg = load_config(pathlib.Path(args.config))
    ecfg = cfg["edit"]
    music = pathlib.Path(args.music) if args.music else None
    out = pathlib.Path(args.out or pathlib.Path(args.clip).with_name(
        pathlib.Path(args.clip).stem + "-reel.mp4"))
    edit.finish(pathlib.Path(args.clip), out, subtitles=args.subtitle or [], music=music,
                music_volume=float(ecfg.get("music_volume", 0.9)),
                original_volume=float(ecfg.get("original_volume", 0.0)), font=args.font)
    print(f"  -> {out}")


def cmd_check(args) -> None:
    problems = 0

    def report(ok: bool, msg: str) -> None:
        nonlocal problems
        problems += not ok
        print(f"  {'ok  ' if ok else 'FAIL'}  {msg}")

    try:
        cfg = load_config(pathlib.Path(args.config))
        report(True, f"{pathlib.Path(args.config).name}: {cfg['character']['name']}, "
                     f"{cfg['video']['provider']} {cfg['video'].get('model', '')}")
    except PipelineError as exc:
        report(False, str(exc))
        raise SystemExit(1)
    try:
        render.find_font(args.font)
        render._require("ffmpeg")
        report(True, "ffmpeg and a font")
    except render.RenderError as exc:
        report(False, str(exc))
    music_dir = BOT_DIR / cfg["edit"].get("music_dir", "music")
    tracks = [p for p in music_dir.glob("*") if p.suffix.lower() in edit.AUDIO_SUFFIXES]
    report(True, f"{len(tracks)} music track(s) in {music_dir.name}/"
                 + ("" if tracks else " (reels will keep the clip's own sound)"))
    try:
        generator.from_env(os.environ, cfg["video"])
        report(True, f"{cfg['video']['provider']} key is set")
    except generator.GeneratorError as exc:
        report(False, str(exc))
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    report(has_key, f"ANTHROPIC_API_KEY is {'set' if has_key else 'not set'}")
    try:
        me = bot.client().account()
        report(True, f"Instagram: logged in as @{me.get('username', '?')}")
    except InstagramError as exc:
        report(False, f"Instagram: {exc}")
    if problems:
        raise SystemExit(1)


def main(argv: list[str] | None = None) -> None:
    bot.load_env(BOT_DIR / ".env")

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", default=str(CONFIG), help="settings file (default: pipeline.toml)")
    p.add_argument("--ledger", default=str(bot.LEDGER), help="record of posted reels (default: posted.json)")
    p.add_argument("--font", help="bold .ttf/.otf for subtitles (or set REELBOT_FONT)")
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("run", help="make and post today's reel, resuming where a previous run stopped")
    r.add_argument("--date", default=dt.date.today().isoformat(), help="the day to make (default: today)")
    r.add_argument("--plan-only", action="store_true", help="only ask Claude for the plan; no video")
    r.add_argument("--no-post", action="store_true", help="make the reel but do not post it")
    r.set_defaults(func=cmd_run)

    e = sub.add_parser("edit", help="crop, add music and subtitles to any clip; no APIs")
    e.add_argument("clip")
    e.add_argument("-s", "--subtitle", action="append", help="a subtitle line (repeat for more)")
    e.add_argument("-m", "--music", help="an audio file to put under it")
    e.add_argument("-o", "--out", help="output file (default: <clip>-reel.mp4)")
    e.set_defaults(func=cmd_edit)

    sub.add_parser("check", help="validate settings, ffmpeg, API keys and the Instagram login") \
        .set_defaults(func=cmd_check)

    args = p.parse_args(argv)
    try:
        args.func(args)
    except AlreadyPosted as exc:
        print(exc)
    except (PipelineError, writer.WriterError, generator.GeneratorError,
            render.RenderError, InstagramError) as exc:
        raise SystemExit(f"error: {exc}")


if __name__ == "__main__":
    sys.exit(main())
