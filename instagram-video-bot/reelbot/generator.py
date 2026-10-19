"""Ask a text-to-video service for a clip, wait for it, download the MP4.

Two providers, one shape. Both take a prompt, return a task id at once, and
finish the video minutes later:

    PiAPI   https://api.piapi.ai   x-api-key header      model "kling"
    Kling   https://api.klingai.com  JWT from access + secret key

Generating costs money every time, so the task id is handed to `on_task` as
soon as it exists. The pipeline writes it down; if the run dies while the
video is rendering, the next run polls the same task instead of paying for
another one.

PiAPI's documentation shows more than one place for the finished video's URL
(output.works[].video, output.video, output.video_url), so all of them are
tried, and the error names the keys it did find if none matches.
"""
from __future__ import annotations

import pathlib
import time

import jwt
import requests

PIAPI_BASE = "https://api.piapi.ai"
KLING_BASE = "https://api.klingai.com"


class GeneratorError(RuntimeError):
    pass


class TaskFailed(GeneratorError):
    """The provider gave up on this task; asking again needs a new one."""


class _Provider:
    name = ""

    def __init__(self, *, model: str, mode: str = "std", duration: int = 5,
                 cfg_scale: float = 0.5, aspect_ratio: str = "9:16",
                 session: requests.Session | None = None):
        self.model = model
        self.mode = mode
        self.duration = duration
        self.cfg_scale = cfg_scale
        self.aspect_ratio = aspect_ratio
        self.http = session or requests.Session()

    def _json(self, method: str, url: str, **kw) -> dict:
        try:
            resp = self.http.request(method, url, timeout=60, **kw)
        except requests.RequestException as exc:
            raise GeneratorError(f"could not reach {self.name}: {exc}") from None
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not resp.ok or not isinstance(body, dict):
            detail = body if isinstance(body, dict) else resp.text[:300]
            hint = " (check the API key in .env)" if resp.status_code in (401, 403) else ""
            raise GeneratorError(f"{self.name} answered HTTP {resp.status_code}{hint}: {detail}")
        return body

    def submit(self, prompt: str, negative_prompt: str = "") -> str:
        raise NotImplementedError

    def status(self, task_id: str) -> tuple[str, str | None, str | None]:
        """("pending" | "done" | "failed", video url, error message)."""
        raise NotImplementedError


class PiAPI(_Provider):
    name = "PiAPI"

    def __init__(self, api_key: str, *, base: str = PIAPI_BASE, **kw):
        if not api_key:
            raise GeneratorError("PIAPI_API_KEY is not set")
        super().__init__(**kw)
        self.base = base.rstrip("/")
        self.headers = {"x-api-key": api_key, "Content-Type": "application/json"}

    def submit(self, prompt: str, negative_prompt: str = "") -> str:
        body = self._json("POST", f"{self.base}/api/v1/task", headers=self.headers, json={
            "model": "kling",
            "task_type": "video_generation",
            "input": {
                "prompt": prompt,
                "negative_prompt": negative_prompt,
                "cfg_scale": self.cfg_scale,
                "duration": self.duration,
                "aspect_ratio": self.aspect_ratio,
                "mode": self.mode,
                "version": self.model,
            },
        })
        task_id = (body.get("data") or {}).get("task_id")
        if not task_id:
            raise GeneratorError(f"PiAPI accepted the request but returned no task_id: {body}")
        return task_id

    def status(self, task_id: str):
        body = self._json("GET", f"{self.base}/api/v1/task/{task_id}", headers=self.headers)
        data = body.get("data") or {}
        state = str(data.get("status", "")).lower()
        if state == "completed":
            url = _piapi_video_url(data.get("output") or {})
            if not url:
                keys = sorted((data.get("output") or {}).keys())
                raise GeneratorError(
                    f"PiAPI task {task_id} completed, but no video URL was found in its "
                    f"output (keys: {keys}); report this shape so the parser can learn it"
                )
            return "done", url, None
        if state == "failed":
            err = data.get("error") or {}
            msg = (err.get("message") or err.get("raw_message")) if isinstance(err, dict) else str(err)
            return "failed", None, msg or "no reason given"
        return "pending", None, None


def _piapi_video_url(output: dict) -> str | None:
    for work in output.get("works") or []:
        video = (work or {}).get("video") or {}
        url = video.get("resource_without_watermark") or video.get("resource")
        if url:
            return url
    video = output.get("video")
    if isinstance(video, str) and video:
        return video
    if isinstance(video, dict):
        url = video.get("url") or video.get("resource_without_watermark") or video.get("resource")
        if url:
            return url
    return output.get("video_url") or None


class Kling(_Provider):
    name = "Kling"

    def __init__(self, access_key: str, secret_key: str, *, base: str = KLING_BASE,
                 clock=time.time, **kw):
        if not access_key or not secret_key:
            raise GeneratorError("KLING_ACCESS_KEY and KLING_SECRET_KEY must both be set")
        super().__init__(**kw)
        self.base = base.rstrip("/")
        self._ak, self._sk = access_key, secret_key
        self._clock = clock

    def _headers(self) -> dict:
        # Kling signs a fresh short-lived JWT per request with the secret key;
        # the secret itself never leaves this machine.
        now = int(self._clock())
        signed = jwt.encode({"iss": self._ak, "exp": now + 1800, "nbf": now - 5},
                            self._sk, algorithm="HS256", headers={"typ": "JWT"})
        return {"Authorization": f"Bearer {signed}", "Content-Type": "application/json"}

    def _ok(self, body: dict) -> dict:
        if body.get("code") not in (0, None):
            raise GeneratorError(f"Kling error {body.get('code')}: {body.get('message')}")
        return body.get("data") or {}

    def submit(self, prompt: str, negative_prompt: str = "") -> str:
        data = self._ok(self._json("POST", f"{self.base}/v1/videos/text2video",
                                   headers=self._headers(), json={
            "model_name": self.model,
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "cfg_scale": self.cfg_scale,
            "mode": self.mode,
            "aspect_ratio": self.aspect_ratio,
            "duration": str(self.duration),
        }))
        if not data.get("task_id"):
            raise GeneratorError(f"Kling accepted the request but returned no task_id: {data}")
        return data["task_id"]

    def status(self, task_id: str):
        data = self._ok(self._json("GET", f"{self.base}/v1/videos/text2video/{task_id}",
                                   headers=self._headers()))
        state = data.get("task_status")
        if state == "succeed":
            videos = (data.get("task_result") or {}).get("videos") or []
            if not videos or not videos[0].get("url"):
                raise GeneratorError(f"Kling task {task_id} succeeded with no video URL")
            return "done", videos[0]["url"], None
        if state == "failed":
            return "failed", None, data.get("task_status_msg") or "no reason given"
        return "pending", None, None


def from_env(env: dict, video_cfg: dict, *, session=None) -> _Provider:
    provider = video_cfg.get("provider", "piapi")
    kw = dict(mode=video_cfg.get("mode", "std"), duration=int(video_cfg.get("duration", 5)),
              cfg_scale=float(video_cfg.get("cfg_scale", 0.5)), session=session)
    if provider == "piapi":
        return PiAPI(env.get("PIAPI_API_KEY", ""), model=video_cfg.get("model", "1.6"),
                     base=env.get("PIAPI_BASE_URL") or PIAPI_BASE, **kw)
    if provider == "kling":
        return Kling(env.get("KLING_ACCESS_KEY", ""), env.get("KLING_SECRET_KEY", ""),
                     model=video_cfg.get("model", "kling-v1-6"),
                     base=env.get("KLING_BASE_URL") or KLING_BASE, **kw)
    raise GeneratorError(f"unknown video provider {provider!r}; use \"piapi\" or \"kling\"")


def wait(provider: _Provider, task_id: str, *, timeout: float = 1800, poll: float = 15,
         sleep=time.sleep, clock=time.monotonic, log=print) -> str:
    """Poll until the video is ready; return its URL."""
    deadline = clock() + timeout
    log(f"  {provider.name}: task {task_id} rendering")
    while True:
        state, url, err = provider.status(task_id)
        if state == "done":
            return url
        if state == "failed":
            raise TaskFailed(f"{provider.name} could not make the video: {err}")
        if clock() >= deadline:
            raise GeneratorError(
                f"{provider.name} task {task_id} still not finished after {timeout / 60:.0f} min; "
                "run the pipeline again later and it will pick the same task up"
            )
        sleep(poll)


def download(url: str, dest: pathlib.Path, *, session: requests.Session | None = None) -> pathlib.Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    http = session or requests.Session()
    try:
        with http.get(url, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(1 << 20):
                    f.write(chunk)
    except requests.RequestException as exc:
        tmp.unlink(missing_ok=True)
        raise GeneratorError(f"could not download the video: {exc}") from None
    if tmp.stat().st_size < 1024:
        tmp.unlink()
        raise GeneratorError("the downloaded video is empty; the link may have expired")
    tmp.replace(dest)
    return dest
