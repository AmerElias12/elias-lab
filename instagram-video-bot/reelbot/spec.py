"""A Reel, as written in a .toml file in reels/.

    caption  = "What the post says."
    hashtags = ["genetherapy", "labmeeting"]

    [[slide]]
    image    = "../../assets/team/Hala-Kassis.jpg"   # relative to this file
    text     = "Meet Hala"
    duration = 3.5

Everything is checked here, before ffmpeg runs and long before Instagram sees
it. Instagram's own refusals arrive minutes later, after the upload, as a
container status of ERROR with no reason attached, so anything that can be
caught on the way in is caught on the way in.
"""
from __future__ import annotations

import pathlib
import re
import tomllib
from dataclasses import dataclass, field

# Instagram's limits for a caption. Over any of them and the publish fails.
CAPTION_MAX = 2200
HASHTAGS_MAX = 30
MENTIONS_MAX = 20

# Reels the API will accept run from 3 seconds to 15 minutes.
REEL_MIN_SECONDS = 3.0
REEL_MAX_SECONDS = 15 * 60

# A slide must outlast the crossfade into the next one, or the fade eats it.
SLIDE_MIN_SECONDS = 1.0

POSITIONS = ("top", "center", "bottom")
FITS = ("cover", "contain")

# Brand colours from css/tokens.css, so a slide with no image still looks
# like the lab.
DEFAULT_BACKGROUND = "#0c4a44"  # --teal
DEFAULT_TEXT_COLOR = "#f4f1e8"  # --paper

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class SpecError(ValueError):
    """The spec file is wrong. The message says what and where."""


@dataclass
class Slide:
    duration: float
    text: str = ""
    image: pathlib.Path | None = None
    fit: str = "cover"
    background: str = DEFAULT_BACKGROUND
    text_color: str = DEFAULT_TEXT_COLOR
    position: str = "bottom"
    zoom: bool = True


@dataclass
class Reel:
    path: pathlib.Path
    caption: str
    slides: list[Slide]
    hashtags: list[str] = field(default_factory=list)
    music: pathlib.Path | None = None
    music_volume: float = 0.8
    share_to_feed: bool = True
    cover_at: float | None = None
    crossfade: float = 0.5

    @property
    def name(self) -> str:
        return self.path.stem

    @property
    def duration(self) -> float:
        """Running time once the crossfades have overlapped the slides."""
        total = sum(s.duration for s in self.slides)
        return total - self.crossfade * (len(self.slides) - 1)

    def full_caption(self) -> str:
        return build_caption(self.caption, self.hashtags)


def build_caption(caption: str, hashtags: list[str]) -> str:
    """The caption, then its hashtags on a line of their own.

    A tag already written into the caption is not repeated at the end.
    """
    caption = caption.strip()
    present = {t.lower() for t in re.findall(r"#(\w+)", caption)}
    tags = []
    for tag in hashtags:
        tag = tag.strip().lstrip("#")
        if tag and tag.lower() not in present:
            present.add(tag.lower())
            tags.append("#" + tag)
    if not tags:
        return caption
    return f"{caption}\n\n{' '.join(tags)}" if caption else " ".join(tags)


def load(path: str | pathlib.Path) -> Reel:
    path = pathlib.Path(path).resolve()
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SpecError(f"{path}: no such file") from None
    except tomllib.TOMLDecodeError as exc:
        raise SpecError(f"{path}: not valid TOML: {exc}") from None
    return parse(raw, path)


def parse(raw: dict, path: pathlib.Path) -> Reel:
    where = path.name
    base = path.parent

    def fail(msg: str):
        raise SpecError(f"{where}: {msg}")

    known = {"caption", "hashtags", "slide", "music", "music_volume",
             "share_to_feed", "cover_at", "crossfade"}
    for key in raw:
        if key not in known:
            fail(f"unknown setting {key!r} (a typo? known: {', '.join(sorted(known))})")

    caption = raw.get("caption", "")
    if not isinstance(caption, str):
        fail("caption must be text")

    hashtags = raw.get("hashtags", [])
    if not isinstance(hashtags, list) or not all(isinstance(h, str) for h in hashtags):
        fail("hashtags must be a list of text, like [\"genetherapy\", \"crispr\"]")
    for tag in hashtags:
        if not re.fullmatch(r"#?\w+", tag.strip()):
            fail(f"hashtag {tag!r} can only hold letters, digits and underscores")

    slides_raw = raw.get("slide", [])
    if not isinstance(slides_raw, list) or not slides_raw:
        fail("needs at least one [[slide]]")

    crossfade = _number(raw.get("crossfade", 0.5), "crossfade", fail)
    if not 0 <= crossfade <= 2:
        fail("crossfade must be between 0 and 2 seconds")

    slides = [_slide(s, i + 1, base, fail) for i, s in enumerate(slides_raw)]

    music = raw.get("music")
    if music is not None:
        music = _file(music, base, "music", fail)
    music_volume = _number(raw.get("music_volume", 0.8), "music_volume", fail)
    if not 0 <= music_volume <= 2:
        fail("music_volume must be between 0 and 2")

    share_to_feed = raw.get("share_to_feed", True)
    if not isinstance(share_to_feed, bool):
        fail("share_to_feed must be true or false")

    reel = Reel(
        path=path,
        caption=caption,
        slides=slides,
        hashtags=hashtags,
        music=music,
        music_volume=music_volume,
        share_to_feed=share_to_feed,
        crossfade=crossfade,
    )

    if reel.duration < REEL_MIN_SECONDS:
        fail(f"runs {reel.duration:.1f}s; Instagram needs at least {REEL_MIN_SECONDS:.0f}s")
    if reel.duration > REEL_MAX_SECONDS:
        fail(f"runs {reel.duration:.0f}s; Instagram allows at most {REEL_MAX_SECONDS}s")

    cover_at = raw.get("cover_at")
    if cover_at is not None:
        cover_at = _number(cover_at, "cover_at", fail)
        if not 0 <= cover_at < reel.duration:
            fail(f"cover_at must fall inside the reel (0 to {reel.duration:.1f}s)")
        reel.cover_at = cover_at

    full = reel.full_caption()
    if len(full) > CAPTION_MAX:
        fail(f"caption with hashtags is {len(full)} characters; the limit is {CAPTION_MAX}")
    if len(re.findall(r"#\w+", full)) > HASHTAGS_MAX:
        fail(f"more than {HASHTAGS_MAX} hashtags; Instagram refuses the post")
    if len(re.findall(r"(?<!\w)@\w+", full)) > MENTIONS_MAX:
        fail(f"more than {MENTIONS_MAX} @mentions; Instagram refuses the post")

    return reel


def _slide(raw, n: int, base: pathlib.Path, fail) -> Slide:
    if not isinstance(raw, dict):
        fail(f"slide {n} is not a table")

    def bad(msg: str):
        fail(f"slide {n}: {msg}")

    known = {"duration", "text", "image", "fit", "background", "text_color",
             "position", "zoom"}
    for key in raw:
        if key not in known:
            bad(f"unknown setting {key!r} (known: {', '.join(sorted(known))})")

    if "duration" not in raw:
        bad("needs a duration in seconds")
    duration = _number(raw["duration"], f"slide {n} duration", fail)
    if duration < SLIDE_MIN_SECONDS:
        bad(f"duration must be at least {SLIDE_MIN_SECONDS:.0f}s")

    text = raw.get("text", "")
    if not isinstance(text, str):
        bad("text must be text")

    image = raw.get("image")
    if image is not None:
        image = _file(image, base, f"slide {n} image", fail)

    fit = raw.get("fit", "cover")
    if fit not in FITS:
        bad(f"fit must be one of {', '.join(FITS)}")

    position = raw.get("position", "bottom")
    if position not in POSITIONS:
        bad(f"position must be one of {', '.join(POSITIONS)}")

    colours = {}
    for key, default in (("background", DEFAULT_BACKGROUND), ("text_color", DEFAULT_TEXT_COLOR)):
        value = raw.get(key, default)
        if not isinstance(value, str) or not _HEX.match(value):
            bad(f"{key} must be a colour like \"#0c4a44\"")
        colours[key] = value

    zoom = raw.get("zoom", True)
    if not isinstance(zoom, bool):
        bad("zoom must be true or false")

    if image is None and not text.strip():
        bad("has neither an image nor text, so it would be a blank screen")

    return Slide(duration=duration, text=text, image=image, fit=fit,
                 position=position, zoom=zoom, **colours)


def _number(value, what: str, fail) -> float:
    # bool is an int in Python; `duration = true` is a mistake, not 1 second.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{what} must be a number")
    return float(value)


def _file(value, base: pathlib.Path, what: str, fail) -> pathlib.Path:
    if not isinstance(value, str) or not value:
        fail(f"{what} must be a file path")
    p = (base / value).resolve()
    if not p.is_file():
        fail(f"{what} {value!r} not found (looked for {p})")
    return p
