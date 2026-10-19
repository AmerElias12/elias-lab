"""Publish a Reel through the Instagram Graph API.

Publishing is four calls, and only the last one is visible to anyone:

1. create a REELS container with the caption, asking for a resumable upload;
2. send the MP4's bytes to the upload URL the container came back with;
3. wait while Instagram transcodes it (status_code IN_PROGRESS -> FINISHED);
4. publish the container, which makes it a post.

The file goes up directly, so the video never has to sit at a public URL.

The access token travels in an Authorization header, never in a URL, so it
does not end up in an exception message, a proxy log or a traceback pasted
into an issue.
"""
from __future__ import annotations

import pathlib
import time

import requests

DEFAULT_VERSION = "v23.0"
# graph.instagram.com takes a token from "Instagram API with Instagram Login";
# a token from the Facebook Login flow needs graph.facebook.com instead.
DEFAULT_HOST = "graph.instagram.com"
UPLOAD_HOST = "rupload.facebook.com"

# Graph error codes that mean "try again shortly" rather than "you are wrong":
# 1/2 temporary, 4/17/32/613 rate limits.
TRANSIENT_CODES = {1, 2, 4, 17, 32, 613}


class InstagramError(RuntimeError):
    def __init__(self, message: str, *, code: int | None = None):
        super().__init__(message)
        self.code = code


class Instagram:
    def __init__(self, user_id: str, access_token: str, *,
                 api_version: str = DEFAULT_VERSION, host: str = DEFAULT_HOST,
                 session: requests.Session | None = None,
                 sleep=time.sleep, clock=time.monotonic):
        if not user_id or not access_token:
            raise InstagramError("IG_USER_ID and IG_ACCESS_TOKEN must both be set")
        self.user_id = user_id
        self._auth = {"Authorization": f"OAuth {access_token}"}
        self.version = api_version
        self.base = f"https://{host}/{api_version}"
        self.http = session or requests.Session()
        self.sleep = sleep
        self.clock = clock

    # ── plumbing ────────────────────────────────────────────────

    def _call(self, method: str, path: str, *, retries: int = 0, **kw) -> dict:
        url = path if path.startswith("https://") else f"{self.base}/{path}"
        headers = {**self._auth, **kw.pop("headers", {})}
        for attempt in range(retries + 1):
            try:
                resp = self.http.request(method, url, headers=headers, timeout=120, **kw)
            except requests.RequestException as exc:
                if attempt < retries:
                    self.sleep(2 ** attempt * 5)
                    continue
                raise InstagramError(f"could not reach Instagram: {exc}") from None
            try:
                body = resp.json()
            except ValueError:
                body = {}
            err = body.get("error") if isinstance(body, dict) else None
            if resp.ok and not err:
                return body
            code = err.get("code") if err else None
            transient = (resp.status_code >= 500 or code in TRANSIENT_CODES
                         or bool(err and err.get("is_transient")))
            if transient and attempt < retries:
                self.sleep(2 ** attempt * 5)
                continue
            raise InstagramError(_describe(resp.status_code, err, resp.text), code=code)
        raise AssertionError("unreachable")

    # ── what you can ask ────────────────────────────────────────

    def account(self) -> dict:
        """Who the token posts as, and how much of today's quota is used."""
        me = self._call("GET", self.user_id, params={"fields": "id,username"}, retries=2)
        try:
            limit = self._call("GET", f"{self.user_id}/content_publishing_limit",
                               params={"fields": "quota_usage,config"}, retries=2)
            row = (limit.get("data") or [{}])[0]
            me["quota_usage"] = row.get("quota_usage")
            me["quota_total"] = (row.get("config") or {}).get("quota_total")
        except InstagramError:
            # Not every token type may read the quota; the account still is.
            pass
        return me

    def container_status(self, container_id: str) -> tuple[str, str]:
        body = self._call("GET", container_id, params={"fields": "status_code,status"},
                          retries=2)
        return body.get("status_code", ""), body.get("status", "")

    # ── publishing ──────────────────────────────────────────────

    def create_container(self, caption: str, *, share_to_feed: bool = True,
                         thumb_offset_ms: int | None = None) -> tuple[str, str]:
        data = {
            "media_type": "REELS",
            "upload_type": "resumable",
            "caption": caption,
            "share_to_feed": "true" if share_to_feed else "false",
        }
        if thumb_offset_ms is not None:
            data["thumb_offset"] = str(thumb_offset_ms)
        body = self._call("POST", f"{self.user_id}/media", data=data)
        cid = body["id"]
        uri = body.get("uri") or f"https://{UPLOAD_HOST}/ig-api-upload/{self.version}/{cid}"
        return cid, uri

    def upload(self, upload_uri: str, video: pathlib.Path) -> None:
        data = pathlib.Path(video).read_bytes()
        body = self._call("POST", upload_uri, data=data, retries=2, headers={
            "offset": "0",
            "file_size": str(len(data)),
            "Content-Type": "application/octet-stream",
        })
        if body.get("success") is False:
            raise InstagramError(f"upload was not accepted: {body}")

    def wait_until_ready(self, container_id: str, *, timeout: float = 600,
                         poll: float = 5, log=print) -> None:
        deadline = self.clock() + timeout
        last = None
        while True:
            code, status = self.container_status(container_id)
            if code != last:
                log(f"  instagram: {code.lower() or 'waiting'}")
                last = code
            if code == "FINISHED":
                return
            if code in ("ERROR", "EXPIRED"):
                raise InstagramError(
                    f"Instagram could not process the video ({code}): {status or 'no reason given'}"
                )
            if code == "PUBLISHED":
                raise InstagramError("this container has already been published")
            if self.clock() >= deadline:
                raise InstagramError(
                    f"Instagram was still processing after {timeout:.0f}s "
                    f"(container {container_id}); run the bot again to resume"
                )
            self.sleep(poll)

    def publish(self, container_id: str) -> str:
        body = self._call("POST", f"{self.user_id}/media_publish",
                          data={"creation_id": container_id})
        return body["id"]

    def permalink(self, media_id: str) -> str | None:
        try:
            return self._call("GET", media_id, params={"fields": "permalink"},
                              retries=2).get("permalink")
        except InstagramError:
            return None


def _describe(status: int, err: dict | None, text: str) -> str:
    if not err:
        return f"Instagram answered HTTP {status}: {text[:300]}"
    msg = err.get("error_user_msg") or err.get("message") or "unknown error"
    code = err.get("code")
    hint = {
        190: " (the access token is invalid or has expired; make a new one)",
        10: " (the token lacks the content-publish permission; see README, step 2)",
        200: " (the token lacks the content-publish permission; see README, step 2)",
        9004: " (Instagram could not fetch or read the video)",
        4: " (rate limited; try again later)",
        17: " (rate limited; try again later)",
        32: " (rate limited; try again later)",
        613: " (rate limited; try again later)",
    }.get(code, "")
    return f"Instagram error {code}: {msg}{hint}"
