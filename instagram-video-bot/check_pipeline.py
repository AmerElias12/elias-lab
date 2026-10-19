#!/usr/bin/env python3
"""Checks for the daily pipeline: generator, writer, editor, scheduler, and the run.

    .venv/bin/python check_pipeline.py

ffmpeg is real: clips are made, edited and probed. Every paid API is fake:
Claude, PiAPI, Kling and Instagram are stand-ins that answer the way their
documentation says and record what they were asked. Nothing here spends
money or posts anything.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types

BOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BOT))

import jwt  # noqa: E402

import pipeline  # noqa: E402
from reelbot import edit, generator, render, writer  # noqa: E402
from reelbot.ledger import Ledger  # noqa: E402

passed = 0
failures: list[str] = []


def check(what: str, fn) -> None:
    """Run one check; what it printed is shown only if it failed."""
    global passed
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            fn()
    except AssertionError as exc:
        failures.append(what)
        print(f"  FAIL  {what}\n          {exc}\n{out.getvalue()}")
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(what)
        print(f"  FAIL  {what}\n          {type(exc).__name__}: {exc}\n{out.getvalue()}")
        return
    passed += 1
    print(f"  ok    {what}")


def raises(exc_type, fn, needle: str = ""):
    try:
        fn()
    except exc_type as exc:
        assert needle in str(exc), f"raised, but said: {exc}"
        return exc
    raise AssertionError(f"expected {exc_type.__name__}")


TMP = pathlib.Path(tempfile.mkdtemp(prefix="reelbot-pipeline-check-"))


def clip(name: str, size: str, *, audio: bool = True, seconds: float = 5) -> pathlib.Path:
    path = TMP / name
    args = ["-f", "lavfi", "-i", f"testsrc2=s={size}:r=24:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=300:duration={seconds}", "-shortest"]
    render._run([*args, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                 *(["-c:a", "aac"] if audio else []), str(path)], TMP)
    return path


LANDSCAPE = clip("landscape.mp4", "1280x720")
TRACK = TMP / "track.mp3"
render._run(["-f", "lavfi", "-i", "sine=frequency=520:duration=2", "-c:a", "libmp3lame", str(TRACK)], TMP)


# ── fakes ───────────────────────────────────────────────────────

def resp(status: int, body) -> types.SimpleNamespace:
    return types.SimpleNamespace(status_code=status, ok=status < 400, json=lambda: body,
                                 text=json.dumps(body))


class FakeHTTP:
    """A requests.Session: answers each request from a list of (status, body)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        status, body = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return resp(status, body)


class FakeDownload:
    def __init__(self, source: pathlib.Path):
        self.data = source.read_bytes()
        self.urls = []

    def get(self, url, stream=True, timeout=None):
        self.urls.append(url)
        data = self.data

        class R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def raise_for_status(self):
                pass

            def iter_content(self, n):
                for i in range(0, len(data), n):
                    yield data[i:i + n]
        return R()


PLAN = writer.Plan(
    topic="enzyme finds its spot",
    video_prompt="Inty, a mint-green enzyme creature, slides along a glowing DNA strand.",
    subtitles=["Inty is looking for one exact spot", "Found it!"],
    caption="One enzyme, one address, three billion letters.",
    hashtags=["#genetherapy", "DNA", "dna", "molecular biology!"],
)


class FakeClaude:
    def __init__(self, plan=PLAN, stop_reason="end_turn"):
        self.calls = []
        outer = self

        class Messages:
            def parse(self, **kw):
                outer.calls.append(kw)
                return types.SimpleNamespace(stop_reason=stop_reason,
                                             parsed_output=plan.model_copy(deep=True))
        self.beta = types.SimpleNamespace(messages=Messages())


class FakeProvider:
    name = "FakeKling"

    def __init__(self, states=("pending", "done")):
        self.states = list(states)
        self.submitted = []
        self.polled = []

    def submit(self, prompt, negative_prompt=""):
        self.submitted.append(prompt)
        return f"T{len(self.submitted)}"

    def status(self, task_id):
        self.polled.append(task_id)
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        if state == "done":
            return "done", f"https://cdn.example/{task_id}.mp4", None
        if state == "failed":
            return "failed", None, "content moderation"
        return "pending", None, None


class FakeInstagram:
    def __init__(self):
        self.calls = []

    def create_container(self, caption, **kw):
        self.calls.append(("create", caption))
        return "C1", "https://rupload.example/C1"

    def upload(self, uri, path):
        self.calls.append(("upload", pathlib.Path(path).name))

    def wait_until_ready(self, cid, **kw):
        self.calls.append(("wait", cid))

    def publish(self, cid):
        self.calls.append(("publish", cid))
        return "M1"

    def permalink(self, media_id):
        return "https://www.instagram.com/reel/xyz/"

    def container_status(self, cid):
        return "FINISHED", ""


CFG = pipeline.load_config(BOT / "pipeline.toml")
quiet = dict(log=lambda *_a: None)


# ── generator ───────────────────────────────────────────────────

print("generator")


def _piapi_submit():
    http = FakeHTTP((200, {"code": 200, "data": {"task_id": "abc"}, "message": "success"}))
    p = generator.PiAPI("PI-KEY", model="1.6", session=http)
    assert p.submit("a cat", "blur") == "abc"
    call = http.calls[0]
    assert call["url"] == "https://api.piapi.ai/api/v1/task", call["url"]
    assert call["headers"]["x-api-key"] == "PI-KEY"
    body = call["json"]
    assert body["model"] == "kling" and body["task_type"] == "video_generation", body
    assert body["input"]["aspect_ratio"] == "9:16" and body["input"]["version"] == "1.6", body
    assert body["input"]["duration"] == 5 and body["input"]["negative_prompt"] == "blur"
check("PiAPI: a Kling text-to-video task, 9:16, keyed by x-api-key", _piapi_submit)


def _piapi_shapes():
    shapes = [
        {"works": [{"video": {"resource": "u1", "resource_without_watermark": "u0"}}]},
        {"video": "u2"},
        {"video": {"url": "u3"}},
        {"video_url": "u4"},
    ]
    want = ["u0", "u2", "u3", "u4"]
    for shape, url in zip(shapes, want):
        http = FakeHTTP((200, {"data": {"status": "completed", "output": shape}}))
        state, got, _ = generator.PiAPI("k", model="1.6", session=http).status("abc")
        assert (state, got) == ("done", url), (shape, state, got)
    http = FakeHTTP((200, {"data": {"status": "completed", "output": {"thing": 1}}}))
    raises(generator.GeneratorError,
           lambda: generator.PiAPI("k", model="1.6", session=http).status("abc"), "['thing']")
check("PiAPI: the video URL is found in every documented response shape", _piapi_shapes)


def _piapi_fail():
    http = FakeHTTP((200, {"data": {"status": "processing"}}),
                    (200, {"data": {"status": "failed", "error": {"message": "prompt rejected"}}}))
    p = generator.PiAPI("k", model="1.6", session=http)
    raises(generator.TaskFailed,
           lambda: generator.wait(p, "abc", sleep=lambda _s: None, **quiet), "prompt rejected")
check("PiAPI: a failed task stops the wait and says why", _piapi_fail)


def _bad_key():
    http = FakeHTTP((401, {"message": "Invalid API key"}))
    raises(generator.GeneratorError,
           lambda: generator.PiAPI("k", model="1.6", session=http).submit("x"), "check the API key")
check("a rejected API key is reported as one", _bad_key)


def _kling():
    http = FakeHTTP((200, {"code": 0, "data": {"task_id": "k1"}}),
                    (200, {"code": 0, "data": {"task_status": "succeed",
                                               "task_result": {"videos": [{"url": "https://v/k1.mp4"}]}}}))
    secret = "kling-secret-key-of-a-realistic-length-0123456789"
    k = generator.Kling("AK", secret, model="kling-v1-6", session=http, clock=lambda: 1_700_000_000)
    assert k.submit("a cat") == "k1"
    call = http.calls[0]
    assert call["url"] == "https://api.klingai.com/v1/videos/text2video", call["url"]
    token = call["headers"]["Authorization"].removeprefix("Bearer ")
    claims = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_exp": False,
                                                                     "verify_nbf": False})
    assert claims == {"iss": "AK", "exp": 1_700_001_800, "nbf": 1_699_999_995}, claims
    body = call["json"]
    assert body["model_name"] == "kling-v1-6" and body["duration"] == "5" and body["aspect_ratio"] == "9:16"
    assert k.status("k1") == ("done", "https://v/k1.mp4", None)
    assert secret not in json.dumps(call["json"]) + call["url"] + json.dumps(call["headers"])
check("Kling: a signed JWT (secret never sent), and the video URL read back", _kling)


def _kling_error():
    http = FakeHTTP((200, {"code": 1102, "message": "account balance not enough"}))
    raises(generator.GeneratorError,
           lambda: generator.Kling("AK", "s" * 40, model="m", session=http).submit("x"), "balance")
check("Kling: an error code in a 200 answer is still an error", _kling_error)


def _timeout():
    clock = iter(range(0, 100_000, 600))
    p = FakeProvider(states=("pending",))
    raises(generator.GeneratorError,
           lambda: generator.wait(p, "T1", timeout=1800, sleep=lambda _s: None,
                                  clock=lambda: next(clock), **quiet),
           "pick the same task up")
check("a video that never finishes gives up, and says the next run resumes it", _timeout)


def _download():
    dest = TMP / "dl" / "raw.mp4"
    generator.download("https://cdn/x.mp4", dest, session=FakeDownload(LANDSCAPE))
    assert dest.read_bytes() == LANDSCAPE.read_bytes()
    tiny = TMP / "tiny.bin"
    tiny.write_bytes(b"<html>")
    raises(generator.GeneratorError,
           lambda: generator.download("u", TMP / "dl" / "bad.mp4", session=FakeDownload(tiny)), "empty")
    assert not (TMP / "dl" / "bad.mp4").exists() and not (TMP / "dl" / "bad.part").exists()
check("download writes the whole file, and refuses an empty one", _download)


def _from_env():
    raises(generator.GeneratorError, lambda: generator.from_env({}, {"provider": "piapi"}), "PIAPI_API_KEY")
    raises(generator.GeneratorError, lambda: generator.from_env({}, {"provider": "kling"}), "KLING_ACCESS_KEY")
    p = generator.from_env({"PIAPI_API_KEY": "k"}, CFG["video"])
    assert p.name == "PiAPI" and p.duration == 5
check("the provider comes from pipeline.toml, its keys from .env", _from_env)


# ── writer ──────────────────────────────────────────────────────

print("writer")


def _asks_claude():
    fake = FakeClaude()
    plan = writer.write_plan(CFG, recent=["cells dividing"], today="2026-10-20", duration=5, client=fake)
    kw = fake.calls[0]
    assert kw["model"] == "claude-opus-5-5", kw["model"]
    assert kw["output_format"] is writer.Plan
    assert kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"]
    assert CFG["character"]["look"] in kw["system"], "the character's look is not in the prompt"
    assert "cells dividing" in kw["messages"][0]["content"], "recent topics were not passed"
    assert plan.topic == PLAN.topic
check("Claude gets the character, the themes and recent topics; returns a Plan", _asks_claude)


def _hashtags():
    plan = writer.check_plan(PLAN.model_copy(deep=True), CFG)
    assert plan.hashtags == ["genetherapy", "DNA", "molecularbiology", "eliaslab"], plan.hashtags
    cap = writer.full_caption(plan)
    assert cap.endswith("#genetherapy #DNA #molecularbiology #eliaslab"), cap
check("hashtags are cleaned, de-duplicated, and the account's own tag added", _hashtags)


def _refusal():
    raises(writer.WriterError,
           lambda: writer.write_plan(CFG, recent=[], today="d", duration=5,
                                     client=FakeClaude(stop_reason="refusal")), "declined")
    empty = PLAN.model_copy(update={"subtitles": ["  "]})
    raises(writer.WriterError, lambda: writer.check_plan(empty, CFG), "no subtitles")
check("a refused or unusable plan stops the day before a video is paid for", _refusal)


# ── editing ─────────────────────────────────────────────────────

print("editing")


def _times():
    t = edit.subtitle_times(["one two three four five six", "ok"], 5.0)
    assert t[0][0] == 0 and t[-1][1] <= 5.0, t
    assert t[0][1] < t[1][0], "subtitles overlap"
    assert (t[0][1] - t[0][0]) > (t[1][1] - t[1][0]), "the long line got less time"
check("subtitles take turns, longer lines stay up longer", _times)


def _pick():
    music = TMP / "music"
    music.mkdir()
    for i, name in enumerate(["old.mp3", "older.mp3", "newest.mp3"]):
        (music / name).write_bytes(b"x")
        os.utime(music / name, (1000 + i * 10 if name != "older.mp3" else 900,) * 2)
    (music / "notes.txt").write_text("not audio")
    assert edit.pick_track(music, {}).name == "newest.mp3"
    assert edit.pick_track(music, {"newest.mp3": "2026-10-01"}).name == "old.mp3"
    used = {"newest.mp3": "2026-10-03", "old.mp3": "2026-10-01", "older.mp3": "2026-10-02"}
    assert edit.pick_track(music, used).name == "old.mp3", "did not reuse the longest-unused"
    assert edit.pick_track(TMP / "nowhere", {}) is None
check("music: newest unused track first, then the one used longest ago", _pick)


def _finish(src, **kw):
    out = TMP / f"{src.stem}-reel.mp4"
    edit.finish(src, out, subtitles=["Inty found it", "Snip, swap, done"], **kw, **quiet)
    return render.probe(out)


def _landscape():
    f = _finish(LANDSCAPE, music=TRACK, original_volume=0.3)
    assert (f["width"], f["height"]) == (1080, 1920), f
    assert abs(f["duration"] - 5) < 0.1 and f["fps"] == 30, f
    assert f["audio_codec"] == "aac" and f["audio_rate"] == 48000, f
check("a 16:9 clip becomes 1080x1920 with music mixed under its own sound", _landscape)


def _tall_silent():
    f = _finish(clip("tall.mp4", "720x1600", audio=False))
    assert (f["width"], f["height"]) == (1080, 1920), f
    assert f["audio_codec"] == "aac", "a clip with no sound and no music has no audio track"
check("a clip taller than 9:16 is cropped too, and silence is added if needed", _tall_silent)


def _too_short():
    raises(render.RenderError, lambda: _finish(clip("short.mp4", "720x1280", seconds=2)), "at least 3s")
check("a clip under 3 seconds is refused", _too_short)


# ── the daily run ───────────────────────────────────────────────

print("daily run")


def harness(name: str):
    root = TMP / name
    root.mkdir()
    return dict(ledger=Ledger(root / "posted.json"), daily_dir=root / "daily",
                anthropic_client=FakeClaude(), provider=FakeProvider(), ig=FakeInstagram(),
                http=FakeDownload(LANDSCAPE), sleep=lambda _s: None, **quiet)


def _whole_day():
    h = harness("day1")
    final = pipeline.run(CFG, "2026-10-20", **h)
    assert final and render.probe(final)["height"] == 1920
    assert h["provider"].submitted == [PLAN.video_prompt]
    assert [c[0] for c in h["ig"].calls] == ["create", "upload", "wait", "publish"], h["ig"].calls
    assert h["ig"].calls[0][1].startswith(PLAN.caption) and "#eliaslab" in h["ig"].calls[0][1]
    entry = h["ledger"].get("daily-2026-10-20")
    assert entry["status"] == "published" and entry["topic"] == PLAN.topic, entry
    state = json.loads((h["daily_dir"] / "2026-10-20" / "state.json").read_text())
    assert state["task_id"] == "T1" and state["plan"]["topic"] == PLAN.topic
check("plan, render, download, edit, post, and record it", _whole_day)


def _once_a_day():
    h = harness("day2")
    pipeline.run(CFG, "2026-10-20", **h)
    h["anthropic_client"].calls.clear()
    pipeline.run(CFG, "2026-10-20", **h)
    assert h["anthropic_client"].calls == [], "asked Claude again on a day already posted"
    assert len(h["provider"].submitted) == 1, "paid for a second video"
    assert sum(c[0] == "publish" for c in h["ig"].calls) == 1, "posted twice"
check("a second run on a posted day does nothing at all", _once_a_day)


def _resume_render():
    h = harness("day3")
    h["provider"] = FakeProvider(states=("pending",))
    clock = iter(range(0, 10**6, 3600))
    real_wait = generator.wait
    generator.wait = lambda p, t, **kw: real_wait(p, t, **{**kw, "clock": lambda: next(clock)})
    try:
        raises(generator.GeneratorError, lambda: pipeline.run(CFG, "2026-10-21", **h))
    finally:
        generator.wait = real_wait
    h["provider"].states = ["done"]
    pipeline.run(CFG, "2026-10-21", **h)
    assert h["provider"].submitted == [PLAN.video_prompt], "submitted a second video after a timeout"
    assert len(h["anthropic_client"].calls) == 1, "asked Claude twice for one day"
    assert h["ledger"].is_published("daily-2026-10-21")
check("a run that times out while rendering resumes the same task next time", _resume_render)


def _failed_task():
    h = harness("day4")
    h["provider"] = FakeProvider(states=("failed",))
    raises(generator.TaskFailed, lambda: pipeline.run(CFG, "2026-10-22", **h), "moderation")
    h["provider"].states = ["done"]
    pipeline.run(CFG, "2026-10-22", **h)
    assert len(h["provider"].submitted) == 2, "a failed task was polled forever instead of replaced"
check("a task the provider failed is replaced on the next run", _failed_task)


def _no_post_and_plan_only():
    h = harness("day5")
    pipeline.run(CFG, "2026-10-23", plan_only=True, **h)
    assert h["provider"].submitted == [] and h["ig"].calls == []
    final = pipeline.run(CFG, "2026-10-23", no_post=True, **h)
    assert final.exists() and h["ig"].calls == [] and not h["ledger"].entries
    assert len(h["anthropic_client"].calls) == 1, "--no-post asked Claude again"
check("--plan-only spends nothing on video; --no-post stops before Instagram", _no_post_and_plan_only)


def _next_day_knows():
    h = harness("day6")
    pipeline.run(CFG, "2026-10-24", **h)
    pipeline.run(CFG, "2026-10-25", **h)
    second = h["anthropic_client"].calls[1]["messages"][0]["content"]
    assert PLAN.topic in second, "yesterday's topic was not passed to Claude"
check("tomorrow's plan is told what was posted today", _next_day_knows)


def _config():
    bad = TMP / "bad.toml"
    text = (BOT / "pipeline.toml").read_text()
    for broken, needle in ((text.replace('provider  = "piapi"', 'provider  = "sora"'), "provider"),
                           (text.replace("duration  = 5", "duration  = 7"), "5 or 10"),
                           (text.replace("look        =", "#look        ="), "needs look")):
        bad.write_text(broken)
        raises(pipeline.PipelineError, lambda: pipeline.load_config(bad), needle)
check("pipeline.toml mistakes are named before anything runs", _config)


# ── scheduler ───────────────────────────────────────────────────

print("scheduler")


def _scheduler():
    node = shutil.which("node")
    if not node or not (BOT / "scheduler" / "node_modules" / "node-cron").exists():
        raise AssertionError("node or node-cron missing; run npm install in scheduler/")
    fake = TMP / "fakepython"
    fake.write_text(f"#!/bin/sh\necho ARGS \"$@\"\nexit 4\n")
    fake.chmod(0o755)
    env = {**os.environ, "PYTHON": str(fake)}
    proc = subprocess.run([node, "index.js", "--now"], cwd=BOT / "scheduler", env=env,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 4, (proc.returncode, proc.stdout, proc.stderr)
    assert "pipeline.py run" in proc.stdout, proc.stdout
    proc = subprocess.run([node, "index.js"], cwd=BOT / "scheduler",
                          env={**env, "CRON_SCHEDULE": "not cron"},
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 2 and "not a valid cron" in proc.stderr, proc
check("node-cron scheduler runs pipeline.py run, and rejects a bad schedule", _scheduler)


shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
for f in failures:
    print(f"  - {f}")
raise SystemExit(1 if failures else 0)
