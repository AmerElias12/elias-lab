#!/usr/bin/env python3
"""Checks for the Reels bot: specs, rendering, and the Instagram calls.

    python check_bot.py

Rendering is real: ffmpeg makes a short Reel and ffprobe reads it back, so a
broken filter graph fails here and not at 6am in a cron log. Instagram is not
real: a fake session stands in for the Graph API, answers the way the API
documents, and records what it was sent. Nothing here posts anything.
"""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import shutil
import sys
import tempfile
import types

BOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BOT))

import bot  # noqa: E402
from reelbot import render, spec  # noqa: E402
from reelbot.instagram import Instagram, InstagramError  # noqa: E402
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


TMP = pathlib.Path(tempfile.mkdtemp(prefix="reelbot-check-"))
IMAGE = TMP / "photo.png"
render._run(["-f", "lavfi", "-i", "testsrc2=s=640x480", "-frames:v", "1", str(IMAGE)], TMP)


def spec_from(text: str, name: str = "reel") -> spec.Reel:
    path = TMP / f"{name}.toml"
    path.write_text(text, encoding="utf-8")
    return spec.load(path)


def refused(text: str, needle: str):
    def run():
        try:
            spec_from(text)
        except spec.SpecError as exc:
            assert needle in str(exc), f"refused, but for the wrong reason: {exc}"
            return
        raise AssertionError("accepted a spec it should have refused")
    return run


# ── specs ───────────────────────────────────────────────────────

print("specs")


def _example_loads():
    for path in sorted((BOT / "reels").glob("*.toml")):
        spec.load(path)
check("every spec in reels/ loads", _example_loads)


def _duration_counts_crossfades():
    r = spec_from('[[slide]]\ntext="a"\nduration=3\n[[slide]]\ntext="b"\nduration=3\n')
    assert r.duration == 5.5, r.duration
check("running time takes off the crossfade overlap", _duration_counts_crossfades)

check("a spec with no slides is refused", refused('caption = "hi"\n', "at least one [[slide]]"))
check("a slide shorter than the crossfade allows is refused",
      refused('[[slide]]\ntext="a"\nduration=0.5\n', "at least 1s"))
check("a reel under 3 seconds is refused",
      refused('[[slide]]\ntext="a"\nduration=2\n', "at least 3s"))
check("a missing image is named, with where it looked",
      refused('[[slide]]\nimage="nope.jpg"\nduration=3\n', "nope.jpg' not found"))
check("a blank slide is refused",
      refused('[[slide]]\nduration=3\n', "neither an image nor text"))
check("a typo in a setting is caught rather than ignored",
      refused('[[slide]]\ntext="a"\nduraton=3\nduration=3\n', "unknown setting 'duraton'"))
check("duration = true is not one second",
      refused('[[slide]]\ntext="a"\nduration=true\n', "must be a number"))
check("a bad colour is refused",
      refused('[[slide]]\ntext="a"\nduration=3\nbackground="teal"\n', "colour"))
check("more than 30 hashtags is refused",
      refused("hashtags=[" + ",".join(f'"t{i}"' for i in range(31))
              + ']\n[[slide]]\ntext="a"\nduration=3\n', "30 hashtags"))
check("a caption over 2200 characters is refused",
      refused(f'caption="{"x" * 2201}"\n[[slide]]\ntext="a"\nduration=3\n', "2200"))
check("a cover frame past the end is refused",
      refused('cover_at=9\n[[slide]]\ntext="a"\nduration=3\n', "cover_at"))


def _caption():
    c = spec.build_caption("New paper out #GeneTherapy", ["genetherapy", "#crispr", "crispr", " lab "])
    assert c == "New paper out #GeneTherapy\n\n#crispr #lab", repr(c)
    assert spec.build_caption("", ["a"]) == "#a"
    assert spec.build_caption("just text", []) == "just text"
check("hashtags are added once each, and not if the caption has them", _caption)


# ── rendering ───────────────────────────────────────────────────

print("rendering")


def _offsets():
    assert render.crossfade_offsets([3, 3, 4], 0.5) == [2.5, 5.0], render.crossfade_offsets([3, 3, 4], 0.5)
    assert render.crossfade_offsets([3], 0.5) == []
check("crossfade offsets land where each clip begins", _offsets)


def _wrap():
    lines = render.wrap("Enzymes that write a whole gene\ninto one place")
    assert all(len(l) <= render.WRAP_CHARS for l in lines), lines
    assert lines[-1] == "into one place", "the author's line break was lost"
check("text wraps to fit and keeps the author's line breaks", _wrap)


def _text_clears_instagram_ui():
    for pos in spec.POSITIONS:
        for n in (1, 4):
            top = render.text_top(n, pos)
            bottom = top + n * render.LINE_HEIGHT
            assert top - render.BAND_PAD >= render.SAFE_TOP, (pos, n, top)
            assert bottom + render.BAND_PAD <= render.HEIGHT - render.SAFE_BOTTOM, (pos, n, bottom)
check("text stays clear of Instagram's own overlays", _text_clears_instagram_ui)


def _fitted_image_misses_text():
    s = spec.Slide(duration=3, text="Meet the lab", image=IMAGE, fit="contain", position="bottom")
    x, y, w, h = render._image_box(s)
    band_top = render.text_top(1, "bottom") - render.BAND_PAD
    assert y + h <= band_top, f"image ends at {y + h}, text band starts at {band_top}"
check("a fitted image is placed above bottom text, not under it", _fitted_image_misses_text)


VIDEO = TMP / "out.mp4"
REEL = spec_from(f'''
caption = "Test reel: 100% %{{pts}} 'quotes' and: colons"
[[slide]]
image = "{IMAGE.name}"
text = "Cover, zoomed: 100% %{{pts}}"
duration = 2
[[slide]]
image = "{IMAGE.name}"
fit = "contain"
text = "Fitted"
position = "top"
zoom = false
duration = 1.5
[[slide]]
text = "Colour only, with a long line that has to wrap"
position = "center"
duration = 1.5
''', "render-me")


def _renders():
    render.render(REEL, VIDEO, log=lambda _m: None)
    facts = render.probe(VIDEO)
    assert (facts["width"], facts["height"]) == (1080, 1920), facts
    assert facts["video_codec"] == "h264" and facts["pix_fmt"] == "yuv420p", facts
    assert facts["fps"] == 30, facts
    assert facts["audio_codec"] == "aac" and facts["audio_rate"] == 48000, facts
    assert abs(facts["duration"] - REEL.duration) < 0.1, (facts["duration"], REEL.duration)
check("a reel renders as 1080x1920 H.264/AAC at the planned length", _renders)


def _music():
    track = TMP / "tone.m4a"
    render._run(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", str(track)], TMP)
    r = spec_from(f'music="{track.name}"\n[[slide]]\ntext="a"\nduration=3.5\n', "music")
    out = render.render(r, TMP / "music.mp4", log=lambda _m: None)
    assert abs(render.probe(out)["duration"] - 3.5) < 0.1, "a 1s track was not looped to fill 3.5s"
check("music shorter than the reel is looped to fill it", _music)


# ── Instagram ───────────────────────────────────────────────────

print("instagram")


class FakeGraph:
    """Answers like the Graph API and remembers every request."""

    def __init__(self, statuses=("IN_PROGRESS", "FINISHED"), fail=None):
        self.calls: list[dict] = []
        self.statuses = list(statuses)
        self.fail = fail or {}

    def request(self, method, url, headers=None, data=None, params=None, timeout=None):
        self.calls.append({"method": method, "url": url, "headers": headers or {},
                           "data": data, "params": params})
        key = url.rsplit("/", 1)[-1]
        if key in self.fail:
            status, body = self.fail[key]
            return self._resp(status, body)
        if url.endswith("/media"):
            return self._resp(200, {"id": "C1", "uri": "https://rupload.facebook.com/ig-api-upload/v23.0/C1"})
        if "rupload" in url:
            return self._resp(200, {"success": True})
        if url.endswith("/C1"):
            code = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            return self._resp(200, {"status_code": code, "status": "Error: bad audio" if code == "ERROR" else ""})
        if url.endswith("/media_publish"):
            return self._resp(200, {"id": "M1"})
        if url.endswith("/M1"):
            return self._resp(200, {"permalink": "https://www.instagram.com/reel/abc/"})
        return self._resp(404, {"error": {"message": "unknown", "code": 100}})

    @staticmethod
    def _resp(status, body):
        return types.SimpleNamespace(status_code=status, ok=status < 400,
                                     json=lambda: body, text=json.dumps(body))

    def urls(self):
        return [c["url"].split("/v23.0/")[-1] for c in self.calls]


# The video was rendered and checked above; posting it again only needs the file.
bot.render_reel = lambda _reel, _args: VIDEO


def ig_with(fake) -> Instagram:
    return Instagram("U1", "SECRET-ACCESS", session=fake, sleep=lambda _s: None)


def args(**kw):
    base = dict(dry_run=False, font=None, keep_work=False, out=None)
    return types.SimpleNamespace(**{**base, **kw})


def _publishes_in_order():
    fake = FakeGraph()
    ledger = Ledger(TMP / "posted-1.json")
    bot.post_reel(REEL, ledger, args(), ig=ig_with(fake))
    assert fake.urls() == ["U1/media", "C1", "C1", "C1", "U1/media_publish", "M1"], fake.urls()
    create = fake.calls[0]["data"]
    assert create["media_type"] == "REELS" and create["upload_type"] == "resumable", create
    assert create["caption"] == REEL.full_caption()
    upload = fake.calls[1]
    assert upload["headers"]["file_size"] == str(len(upload["data"])) and upload["headers"]["offset"] == "0"
    entry = ledger.get("render-me")
    assert entry["status"] == "published" and entry["permalink"].endswith("/reel/abc/"), entry
check("create, upload, wait, publish, and record it", _publishes_in_order)


def _token_stays_out_of_urls():
    fake = FakeGraph()
    bot.post_reel(REEL, Ledger(TMP / "posted-2.json"), args(), ig=ig_with(fake))
    for c in fake.calls:
        assert "SECRET-ACCESS" not in c["url"], c["url"]
        assert "SECRET-ACCESS" not in json.dumps(c["params"] or {})
        assert c["headers"]["Authorization"] == "OAuth SECRET-ACCESS"
check("the access token goes in a header, never in a URL", _token_stays_out_of_urls)


def _never_twice():
    fake = FakeGraph()
    ledger = Ledger(TMP / "posted-3.json")
    bot.post_reel(REEL, ledger, args(), ig=ig_with(fake))
    n = len(fake.calls)
    try:
        bot.post_reel(REEL, Ledger(TMP / "posted-3.json"), args(), ig=ig_with(fake))
    except SystemExit as exc:
        assert "already posted" in str(exc), exc
    else:
        raise AssertionError("posted the same reel twice")
    assert len(fake.calls) == n, "called Instagram for a reel it had already posted"
check("a reel already posted is not posted again", _never_twice)


def _resumes_after_crash():
    ledger = Ledger(TMP / "posted-4.json")
    ledger.publishing("render-me", "C1")
    fake = FakeGraph(statuses=("FINISHED",))
    bot.post_reel(REEL, ledger, args(), ig=ig_with(fake))
    assert "U1/media" not in fake.urls(), "uploaded again instead of resuming"
    assert fake.urls().count("U1/media_publish") == 1
    assert ledger.is_published("render-me")
check("a run that died before publishing resumes without re-uploading", _resumes_after_crash)


def _crash_after_publish():
    ledger = Ledger(TMP / "posted-5.json")
    ledger.publishing("render-me", "C1")
    fake = FakeGraph(statuses=("PUBLISHED",))
    bot.post_reel(REEL, ledger, args(), ig=ig_with(fake))
    assert "U1/media_publish" not in fake.urls(), "published a second time"
    assert ledger.is_published("render-me")
check("a run that died after publishing is recorded, not reposted", _crash_after_publish)


def _processing_error():
    fake = FakeGraph(statuses=("ERROR",))
    ledger = Ledger(TMP / "posted-6.json")
    try:
        bot.post_reel(REEL, ledger, args(), ig=ig_with(fake))
    except InstagramError as exc:
        assert "bad audio" in str(exc), exc
    else:
        raise AssertionError("an ERROR container was treated as fine")
    assert "U1/media_publish" not in fake.urls()
    assert ledger.get("render-me") is None, "a failed upload was recorded"
check("a container Instagram cannot process is reported and not published", _processing_error)


def _expired_token():
    fake = FakeGraph(fail={"media": (400, {"error": {"message": "Error validating access token",
                                                       "code": 190}})})
    try:
        bot.post_reel(REEL, Ledger(TMP / "posted-7.json"), args(), ig=ig_with(fake))
    except InstagramError as exc:
        assert "expired" in str(exc) and exc.code == 190, exc
        assert "SECRET-ACCESS" not in str(exc)
    else:
        raise AssertionError("an expired token went unnoticed")
check("an expired token says so, and does not print the token", _expired_token)


def _retries_rate_limit():
    fake = FakeGraph()
    hits = {"n": 0}
    real = fake.request

    def flaky(method, url, **kw):
        if url.endswith("/C1") and "rupload" not in url and hits["n"] == 0:
            hits["n"] += 1
            return fake._resp(400, {"error": {"message": "slow down", "code": 4}})
        return real(method, url, **kw)
    fake.request = flaky
    bot.post_reel(REEL, Ledger(TMP / "posted-8.json"), args(), ig=ig_with(fake))
check("a rate-limited status check is retried", _retries_rate_limit)


def _times_out():
    clock = iter(range(0, 10_000, 100))
    ig = Instagram("U1", "x", session=FakeGraph(statuses=("IN_PROGRESS",)),
                   sleep=lambda _s: None, clock=lambda: next(clock))
    try:
        ig.wait_until_ready("C1", timeout=600, log=lambda _m: None)
    except InstagramError as exc:
        assert "run the bot again" in str(exc), exc
    else:
        raise AssertionError("waited forever")
check("processing that never finishes gives up with a way forward", _times_out)


def _dry_run_calls_nothing():
    fake = FakeGraph()
    ledger = Ledger(TMP / "posted-9.json")
    bot.post_reel(REEL, ledger, args(dry_run=True), ig=ig_with(fake))
    assert fake.calls == [], fake.urls()
    assert ledger.get("render-me") is None
check("--dry-run renders and calls nothing", _dry_run_calls_nothing)


def _next_skips_posted():
    reels = TMP / "queue"
    reels.mkdir()
    for n in ("02-b", "01-a", "03-c"):
        (reels / f"{n}.toml").write_text('[[slide]]\ntext="x"\nduration=3\n')
    ledger_path = TMP / "posted-10.json"
    Ledger(ledger_path).published("01-a", container_id="C0", media_id="M0", permalink=None)
    picked = []
    real = bot.post_reel
    bot.post_reel = lambda reel, _l, _a: picked.append(reel.name)
    try:
        bot.cmd_next(types.SimpleNamespace(reels=str(reels), ledger=str(ledger_path)))
    finally:
        bot.post_reel = real
    assert picked == ["02-b"], picked
check("next picks the first reel by name that is not posted", _next_skips_posted)


def _env_file():
    import os
    env = TMP / ".env"
    env.write_text('# comment\nexport REELBOT_T1="quoted value"\nREELBOT_T2=plain\nREELBOT_T3=keep\n')
    os.environ["REELBOT_T3"] = "from-environment"
    bot.load_env(env)
    assert os.environ["REELBOT_T1"] == "quoted value"
    assert os.environ["REELBOT_T2"] == "plain"
    assert os.environ["REELBOT_T3"] == "from-environment", "the environment should win over .env"
check(".env is read, and the real environment wins", _env_file)


shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{passed} checks passed" + (f", {len(failures)} FAILED" if failures else ""))
for f in failures:
    print(f"  - {f}")
raise SystemExit(1 if failures else 0)
