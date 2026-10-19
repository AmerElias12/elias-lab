"""Turn a Reel spec into a 1080x1920 MP4 that Instagram accepts as a Reel.

It runs in three passes, each a separate ffmpeg call:

1. every slide becomes a still at twice the output size (image cropped to
   fill, image fitted onto a colour, or just the colour);
2. every still becomes a clip: a slow zoom, a band for the text, the text;
3. the clips are crossfaded into one and given an audio track.

Doing it in passes is slower than one enormous filter graph, but when a slide
looks wrong its clip is sitting in the work directory to be opened on its own.
The still is rendered at double size because zoompan moves in whole input
pixels: at 1x the zoom visibly steps, at 2x it reads as smooth.

Every file ffmpeg reads from inside a filter (the font, each line of text) is
copied into the work directory and named by a plain relative path. Filter
arguments have two levels of escaping, and a font at C:/Windows/Fonts/... or
a caption with a colon in it gets both wrong eventually; a file called
line0.txt does not.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap

from .spec import Reel, Slide

WIDTH, HEIGHT = 1080, 1920
FPS = 30
ZOOM_AMOUNT = 0.08  # how far a slide pushes in over its duration

FONT_SIZE = 76
LINE_HEIGHT = round(FONT_SIZE * 1.25)
WRAP_CHARS = 20
BAND_PAD = 44

# Instagram draws its own interface over a Reel: the account name and caption
# along the bottom, the camera and title along the top. Text kept out of these
# margins is not covered by it.
SAFE_TOP = 260
SAFE_BOTTOM = 480

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


class RenderError(RuntimeError):
    pass


def find_font(explicit: str | None = None) -> pathlib.Path:
    chosen = explicit or os.environ.get("REELBOT_FONT")
    if chosen:
        p = pathlib.Path(chosen).expanduser()
        if not p.is_file():
            raise RenderError(f"font {chosen} not found")
        return p
    for c in FONT_CANDIDATES:
        if pathlib.Path(c).is_file():
            return pathlib.Path(c)
    raise RenderError(
        "no bold font found; set REELBOT_FONT to a .ttf or .otf file "
        "(or pass --font)"
    )


def _require(tool: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise RenderError(
            f"{tool} is not installed (macOS: brew install ffmpeg; "
            "Ubuntu: sudo apt install ffmpeg; Windows: winget install ffmpeg)"
        )
    return path


def _run(args: list[str], cwd: pathlib.Path) -> None:
    proc = subprocess.run(
        [_require("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", *args],
        cwd=cwd, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RenderError(f"ffmpeg failed:\n{proc.stderr.strip()}")


def _colour(hex_colour: str) -> str:
    return "0x" + hex_colour.lstrip("#")


def wrap(text: str) -> list[str]:
    """Lines of text, wrapped to fit, keeping the line breaks the author wrote."""
    lines: list[str] = []
    for para in text.strip().splitlines():
        para = para.strip()
        lines.extend(textwrap.wrap(para, WRAP_CHARS) if para else [""])
    return lines


def text_top(n_lines: int, position: str) -> int:
    block = n_lines * LINE_HEIGHT
    if position == "top":
        return SAFE_TOP + BAND_PAD
    if position == "center":
        return (HEIGHT - block) // 2
    return HEIGHT - SAFE_BOTTOM - BAND_PAD - block


def crossfade_offsets(durations: list[float], fade: float) -> list[float]:
    """Where each xfade starts on the timeline of the clips joined so far.

    Every join overlaps the two clips by `fade`, so clip k starts `fade`
    earlier than the clips before it add up to.
    """
    offsets, elapsed = [], 0.0
    for k, d in enumerate(durations[:-1], start=1):
        elapsed += d
        offsets.append(round(elapsed - k * fade, 3))
    return offsets


def _is_dark(hex_colour: str) -> bool:
    r, g, b = (int(hex_colour.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5


def _image_box(slide: Slide) -> tuple[int, int, int, int]:
    """Where a fitted image goes (x, y, w, h at output size): in the part of
    the safe area the text leaves free, so a logo and its caption never overlap.
    Text in the centre has nowhere else to go, and sits on a band instead."""
    lo, hi = SAFE_TOP, HEIGHT - SAFE_BOTTOM
    lines = wrap(slide.text)
    if lines and slide.position != "center":
        top = text_top(len(lines), slide.position)
        if slide.position == "bottom":
            hi = top - BAND_PAD - 40
        else:
            lo = top + len(lines) * LINE_HEIGHT + BAND_PAD + 40
    w, h = int(WIDTH * 0.8), int((hi - lo) * 0.9)
    return (WIDTH - w) // 2, lo + (hi - lo - h) // 2, w, h


def _needs_band(slide: Slide) -> bool:
    # Text over a photo needs a band to be read; text on a flat colour, or
    # beside a fitted image, does not.
    if slide.image is None:
        return False
    return slide.fit == "cover" or slide.position == "center"


def _still(slide: Slide, work: pathlib.Path, out: str) -> None:
    w, h = WIDTH * 2, HEIGHT * 2
    bg = f"color=c={_colour(slide.background)}:s={w}x{h}"
    if slide.image is None:
        _run(["-f", "lavfi", "-i", bg, "-frames:v", "1", out], work)
    elif slide.fit == "cover":
        _run(["-i", str(slide.image), "-vf",
              f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1",
              "-frames:v", "1", out], work)
    else:
        bx, by, bw, bh = (v * 2 for v in _image_box(slide))
        _run(["-f", "lavfi", "-i", bg, "-i", str(slide.image), "-filter_complex",
              f"[1:v]scale={bw}:{bh}:force_original_aspect_ratio=decrease[fg];"
              f"[0:v][fg]overlay={bx}+({bw}-w)/2:{by}+({bh}-h)/2",
              "-frames:v", "1", out], work)


def _clip(slide: Slide, idx: int, work: pathlib.Path, still: str, out: str) -> None:
    frames = round(slide.duration * FPS)
    zoom = f"1+{ZOOM_AMOUNT}*on/{frames}" if slide.zoom else "1"
    chain = [
        f"zoompan=z='{zoom}':x='trunc(iw/2-iw/zoom/2)':y='trunc(ih/2-ih/zoom/2)'"
        f":d={frames}:s={WIDTH}x{HEIGHT}:fps={FPS}",
    ]

    lines = wrap(slide.text)
    if lines:
        top = text_top(len(lines), slide.position)
        if _needs_band(slide):
            # Light text reads on a darkened band, dark text on a lightened one.
            band = "white@0.6" if _is_dark(slide.text_color) else "black@0.42"
            chain.append(
                f"drawbox=x=0:y={top - BAND_PAD}:w=iw"
                f":h={len(lines) * LINE_HEIGHT + 2 * BAND_PAD}:color={band}:t=fill"
            )
        for i, line in enumerate(lines):
            if not line:
                continue
            name = f"slide{idx}-line{i}.txt"
            (work / name).write_text(line, encoding="utf-8")
            # expansion=none: otherwise "100%" or "%{" in a caption is read as
            # a drawtext expression.
            chain.append(
                f"drawtext=fontfile=font:textfile={name}:expansion=none"
                f":fontsize={FONT_SIZE}:fontcolor={_colour(slide.text_color)}"
                f":x=(w-text_w)/2:y={top + i * LINE_HEIGHT}"
                ":alpha='min(1,t/0.4)'"
            )

    chain.append("format=yuv420p")
    _run(["-i", still, "-filter_complex", "[0:v]" + ",".join(chain) + "[v]",
          "-map", "[v]", "-frames:v", str(frames),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", str(FPS),
          out], work)


def _join(reel: Reel, clips: list[str], work: pathlib.Path, out: pathlib.Path) -> None:
    total = reel.duration
    args: list[str] = []
    for c in clips:
        args += ["-i", c]
    n = len(clips)

    if n == 1:
        graph = "[0:v]null[v]"
    elif reel.crossfade == 0:
        graph = "".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]"
    else:
        offsets = crossfade_offsets([s.duration for s in reel.slides], reel.crossfade)
        parts, prev = [], "[0:v]"
        for k in range(1, n):
            label = "[v]" if k == n - 1 else f"[x{k}]"
            parts.append(f"{prev}[{k}:v]xfade=transition=fade"
                         f":duration={reel.crossfade}:offset={offsets[k - 1]}{label}")
            prev = label
        graph = ";".join(parts)

    if reel.music:
        args += ["-stream_loop", "-1", "-i", str(reel.music)]
        fade_out = min(1.5, total / 3)
        graph += (f";[{n}:a]atrim=0:{total:.3f},asetpts=N/SR/TB,volume={reel.music_volume},"
                  f"afade=t=out:st={total - fade_out:.3f}:d={fade_out:.3f},"
                  "aresample=48000[a]")
    else:
        # A Reel with no audio stream at all is refused by some players and
        # treated oddly by Instagram's editor; silence costs nothing.
        args += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        graph += f";[{n}:a]anull[a]"

    _run([*args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
          "-t", f"{total:.3f}",
          "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high",
          "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", str(FPS * 2),
          "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
          "-movflags", "+faststart", str(out)], work)


def probe(path: str | pathlib.Path) -> dict:
    """The facts about a video that Instagram checks, read back by ffprobe."""
    proc = subprocess.run(
        [_require("ffprobe"), "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RenderError(f"ffprobe could not read {path}: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    num, den = video["r_frame_rate"].split("/")
    return {
        "width": video["width"],
        "height": video["height"],
        "video_codec": video["codec_name"],
        "pix_fmt": video["pix_fmt"],
        "fps": int(num) / int(den),
        "audio_codec": audio["codec_name"] if audio else None,
        "audio_rate": int(audio["sample_rate"]) if audio else None,
        "duration": float(data["format"]["duration"]),
        "bytes": int(data["format"]["size"]),
    }


def render(reel: Reel, out: str | pathlib.Path, *, font: str | None = None,
           keep_work: bool = False, log=print) -> pathlib.Path:
    out = pathlib.Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    font_path = find_font(font)
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"reelbot-{reel.name}-"))
    try:
        shutil.copyfile(font_path, work / "font")
        clips = []
        for i, slide in enumerate(reel.slides):
            log(f"  slide {i + 1}/{len(reel.slides)}")
            still, clip = f"still{i}.png", f"clip{i}.mp4"
            _still(slide, work, still)
            _clip(slide, i, work, still, clip)
            clips.append(clip)
        log("  joining")
        _join(reel, clips, work, out)
    finally:
        if keep_work:
            log(f"  work files kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    facts = probe(out)
    if (facts["width"], facts["height"]) != (WIDTH, HEIGHT):
        raise RenderError(f"rendered {facts['width']}x{facts['height']}, not {WIDTH}x{HEIGHT}")
    if abs(facts["duration"] - reel.duration) > 0.5:
        raise RenderError(
            f"rendered {facts['duration']:.2f}s but the spec adds up to {reel.duration:.2f}s"
        )
    return out
