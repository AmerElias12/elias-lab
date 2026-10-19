"""Claude writes the day's post: the video prompt, the subtitles, the caption.

One request returns all of it as JSON that matches `Plan`, so the parts agree
with each other: the subtitles describe the scene the prompt asks for, and
the caption talks about the same thing. The topics of recent posts are sent
along, so the character does not do the same thing two days running.

Everything Claude returns is checked against Instagram's limits here, before
a video is paid for.
"""
from __future__ import annotations

import json
import re

import anthropic
from pydantic import BaseModel

from . import spec

DEFAULT_MODEL = "claude-opus-5-5"


class WriterError(RuntimeError):
    pass


class Plan(BaseModel):
    topic: str
    video_prompt: str
    subtitles: list[str]
    caption: str
    hashtags: list[str]


SYSTEM = """\
You plan one short Instagram Reel a day for {brand}. Each Reel is a single \
AI-generated clip of a recurring animated character, about {duration} seconds \
long, vertical 9:16, with short subtitles burned in and a caption under it.

The character, the same in every Reel:
- Name: {name}
- Looks: {look}
- Personality: {personality}
- Visual style: {style}

Audience: {audience}
Write in {language}.

Return:
- topic: a few words naming today's idea, used to avoid repeating it.
- video_prompt: the prompt for a text-to-video model. Describe one continuous \
shot: the character (restate its look and the visual style in full every \
time, since the video model has no memory), the setting, one clear action, \
the camera, the lighting. Vertical framing with the character in the middle \
of the frame. No text, letters, logos or subtitles in the picture. At most \
{prompt_chars} characters.
- subtitles: {min_subs} to {max_subs} short lines shown one after another \
over the clip. Each at most {sub_chars} characters. They narrate or voice \
the character; together they read in about {duration} seconds.
- caption: the post text. One to three short sentences that make someone \
want to watch again or follow. No hashtags in it.
- hashtags: {n_tags} hashtags without the # sign, relevant to the topic and \
specific enough to reach the audience, not generic ones like "love" or \
"instagood".

Nothing in the plan may present a claim as fact that is not true, or give \
medical advice."""


def _system(cfg: dict, duration: int) -> str:
    ch, ct = cfg["character"], cfg["content"]
    return SYSTEM.format(
        brand=ct.get("brand", "this account"), duration=duration,
        name=ch["name"], look=ch["look"], personality=ch["personality"], style=ch["style"],
        audience=ct.get("audience", "a general audience"),
        language=ct.get("language", "English"),
        prompt_chars=PROMPT_MAX, min_subs=2, max_subs=4, sub_chars=SUBTITLE_MAX,
        n_tags=int(ct.get("hashtag_count", 8)),
    )


PROMPT_MAX = 2000  # Kling refuses prompts over 2500 characters; leave room
SUBTITLE_MAX = 60


def _user(cfg: dict, recent: list[str], today: str) -> str:
    ct = cfg["content"]
    themes = "\n".join(f"- {t}" for t in ct.get("themes", [])) or "- anything that suits the character"
    done = "\n".join(f"- {t}" for t in recent) or "- (nothing yet)"
    return (f"Today is {today}. Plan today's Reel.\n\n"
            f"Themes to choose from:\n{themes}\n\n"
            f"Recent topics, do not repeat them:\n{done}")


def write_plan(cfg: dict, *, recent: list[str], today: str, duration: int,
               client: anthropic.Anthropic | None = None, model: str | None = None) -> Plan:
    client = client or anthropic.Anthropic()
    try:
        response = client.beta.messages.parse(
            model=model or DEFAULT_MODEL,
            max_tokens=16000,
            # If a safety classifier declines, retry server-side on the model
            # Anthropic recommends for that case instead of failing the day.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium"},
            system=_system(cfg, duration),
            messages=[{"role": "user", "content": _user(cfg, recent, today)}],
            output_format=Plan,
        )
    except anthropic.AuthenticationError:
        raise WriterError("ANTHROPIC_API_KEY is missing or not valid") from None
    except anthropic.RateLimitError:
        raise WriterError("Claude API rate limit reached; the next run will try again") from None
    except anthropic.APIStatusError as exc:
        raise WriterError(f"Claude API error {exc.status_code}: {exc.message}") from None
    except anthropic.APIConnectionError:
        raise WriterError("could not reach the Claude API") from None

    if response.stop_reason == "refusal":
        raise WriterError("Claude declined to write this plan; adjust the themes in pipeline.toml")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise WriterError("Claude's plan came back incomplete; run again")
    return check_plan(response.parsed_output, cfg)


def check_plan(plan: Plan, cfg: dict) -> Plan:
    """Tidy what is safe to tidy; refuse what would fail later and cost money."""
    always = cfg["content"].get("always_hashtags", [])
    tags, seen = [], set()
    for t in [*plan.hashtags, *always]:
        t = re.sub(r"[^\w]", "", t.strip().lstrip("#"))
        if t and t.lower() not in seen:
            seen.add(t.lower())
            tags.append(t)
    plan.hashtags = tags[:spec.HASHTAGS_MAX]
    plan.subtitles = [s.strip() for s in plan.subtitles if s.strip()]
    plan.caption = plan.caption.strip()

    problems = []
    if not plan.video_prompt.strip():
        problems.append("the video prompt is empty")
    if len(plan.video_prompt) > 2500:
        problems.append(f"the video prompt is {len(plan.video_prompt)} characters (limit 2500)")
    if not plan.subtitles:
        problems.append("there are no subtitles")
    if len(full_caption(plan)) > spec.CAPTION_MAX:
        problems.append(f"the caption is over {spec.CAPTION_MAX} characters")
    if problems:
        raise WriterError("Claude's plan is not usable: " + "; ".join(problems))
    return plan


def full_caption(plan: Plan) -> str:
    return spec.build_caption(plan.caption, plan.hashtags)


def to_json(plan: Plan) -> str:
    return json.dumps(plan.model_dump(), indent=2, ensure_ascii=False)
