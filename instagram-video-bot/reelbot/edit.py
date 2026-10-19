"""Finish a generated clip as a Reel: 9:16, background music, burned-in subtitles.

    finish(raw.mp4, out.mp4, subtitles=[...], music=track)

One ffmpeg pass:

- crop the centre to 9:16 (whatever shape came back; the generator is asked
  for 9:16, but not every model honours it) and scale to 1080x1920 at 30 fps;
- show each subtitle in turn, white with a dark outline, inside the area
  Instagram's own buttons and caption do not cover;
- put the music under it, faded in and out, cut to the clip's length, and
  mixed with the clip's own sound if it has any and that is wanted.

Subtitles are drawn with drawtext, like the slide renderer, so they share its
font lookup and its rule that text reaches ffmpeg through files rather than
through filter arguments (see render.py).
"""
from __future__ import annotations

import pathlib
import shutil
import tempfile
import textwrap

from . import render

AUDIO_SUFFIXES = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}

SUB_FONT_SIZE = 64
SUB_LINE_HEIGHT = round(SUB_FONT_SIZE * 1.25)
SUB_WRAP = 24
SUB_GAP = 0.15  # seconds of nothing between two subtitles, so they read as two


def subtitle_times(subtitles: list[str], duration: float) -> list[tuple[float, float]]:
    """Start and end of each subtitle, longer lines given longer on screen.

    Every line gets a base share plus a share by length, so a two-word line
    is not flashed past and a long one is not cut off mid-read.
    """
    if not subtitles:
        return []
    weights = [1.0 + len(s.split()) for s in subtitles]
    total = sum(weights)
    times, t = [], 0.0
    for w in weights:
        span = duration * w / total
        times.append((round(t, 3), round(t + span - SUB_GAP, 3)))
        t += span
    return times


def pick_track(music_dir: pathlib.Path, last_used: dict[str, str]) -> pathlib.Path | None:
    """The track to use today: one never used yet, newest file first; else the
    one used longest ago.

    `last_used` maps file name to the date it last went out. The folder is the
    playlist: drop in what is trending this week, and it is used first.
    """
    if not music_dir.is_dir():
        return None
    tracks = [p for p in music_dir.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES]
    if not tracks:
        return None
    fresh = [p for p in tracks if p.name not in last_used]
    if fresh:
        return max(fresh, key=lambda p: (p.stat().st_mtime, p.name))
    return min(tracks, key=lambda p: (last_used[p.name], p.name))


def finish(raw: pathlib.Path, out: pathlib.Path, *, subtitles: list[str],
           music: pathlib.Path | None = None, music_volume: float = 0.9,
           original_volume: float = 0.0, font: str | None = None,
           keep_work: bool = False, log=print) -> pathlib.Path:
    raw, out = pathlib.Path(raw).resolve(), pathlib.Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    facts = render.probe(raw)
    duration = facts["duration"]
    if duration < 3:
        raise render.RenderError(f"the clip is {duration:.1f}s; a Reel needs at least 3s")

    font_path = render.find_font(font)
    work = pathlib.Path(tempfile.mkdtemp(prefix="reelbot-edit-"))
    try:
        shutil.copyfile(font_path, work / "font")

        W, H = render.WIDTH, render.HEIGHT
        chain = [
            # The largest centred 9:16 window: full height of a landscape
            # clip, full width of one taller than 9:16.
            f"crop='min(iw,ih*{W}/{H})':'min(ih,iw*{H}/{W})'",
            f"scale={W}:{H}", "setsar=1", f"fps={render.FPS}",
        ]
        for i, (text, (start, end)) in enumerate(zip(subtitles, subtitle_times(subtitles, duration))):
            lines = _wrap(text)
            top = render.HEIGHT - render.SAFE_BOTTOM - len(lines) * SUB_LINE_HEIGHT
            for j, line in enumerate(lines):
                name = f"sub{i}-{j}.txt"
                (work / name).write_text(line, encoding="utf-8")
                chain.append(
                    f"drawtext=fontfile=font:textfile={name}:expansion=none"
                    f":fontsize={SUB_FONT_SIZE}:fontcolor=white"
                    ":borderw=6:bordercolor=black@0.85"
                    f":x=(w-text_w)/2:y={top + j * SUB_LINE_HEIGHT}"
                    f":enable='between(t,{start},{end})'"
                    f":alpha='min(1,(t-{start})/0.2)'"
                )
        chain.append("format=yuv420p")
        graph = "[0:v]" + ",".join(chain) + "[v]"

        args = ["-i", str(raw)]
        has_audio = facts["audio_codec"] is not None
        keep_original = has_audio and original_volume > 0
        fade = min(1.5, duration / 3)
        if music:
            args += ["-stream_loop", "-1", "-i", str(music)]
            graph += (f";[1:a]atrim=0:{duration:.3f},asetpts=N/SR/TB,volume={music_volume},"
                      f"afade=t=in:d=0.3,afade=t=out:st={duration - fade:.3f}:d={fade:.3f},"
                      "aresample=48000")
            if keep_original:
                graph += ("[m];[0:a]aresample=48000,"
                          f"volume={original_volume}[o];[m][o]amix=inputs=2:duration=first"
                          ":normalize=0[a]")
            else:
                graph += "[a]"
        elif has_audio:
            graph += f";[0:a]aresample=48000,volume={original_volume or 1.0}[a]"
        else:
            args += ["-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
            graph += ";[1:a]anull[a]"

        log(f"  editing: 9:16 crop, {len(subtitles)} subtitles, "
            f"{'music ' + music.name if music else 'no music'}")
        render._run([*args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
                     "-t", f"{duration:.3f}",
                     "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high",
                     "-pix_fmt", "yuv420p", "-r", str(render.FPS), "-g", str(render.FPS * 2),
                     "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                     "-movflags", "+faststart", str(out)], work)
    finally:
        if keep_work:
            log(f"  work files kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    done = render.probe(out)
    if (done["width"], done["height"]) != (render.WIDTH, render.HEIGHT):
        raise render.RenderError(f"edited video is {done['width']}x{done['height']}")
    return out


def _wrap(text: str) -> list[str]:
    return textwrap.wrap(" ".join(text.split()), SUB_WRAP) or [""]
