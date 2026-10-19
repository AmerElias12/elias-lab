"""Post a video once, and only once, recording it in the ledger.

Shared by bot.py (Reels from spec files) and pipeline.py (the daily
generated Reel). See ledger.py for why the "publishing" entry exists.
"""
from __future__ import annotations

import pathlib
from typing import Callable

from .instagram import Instagram
from .ledger import Ledger


class AlreadyPosted(RuntimeError):
    pass


def publish(ig: Instagram, ledger: Ledger, key: str, video: Callable[[], pathlib.Path],
            caption: str, *, share_to_feed: bool = True, thumb_offset_ms: int | None = None,
            extra: dict | None = None, log=print) -> str | None:
    """Post `video()` under `key`; return the permalink (or None if unknown).

    `video` is called only when an upload is actually needed, so a run that
    resumes an interrupted publish does not render or edit anything again.
    """
    extra = extra or {}
    entry = ledger.get(key)
    if entry and entry["status"] == "published":
        raise AlreadyPosted(f"{key} was already posted "
                            f"({entry.get('permalink') or entry.get('media_id')})")

    # A previous run got as far as publishing and then stopped. Ask Instagram
    # what happened before doing anything that could post it twice.
    if entry and entry["status"] == "publishing":
        cid = entry["container_id"]
        code, _ = ig.container_status(cid)
        log(f"resuming {key}: container {cid} is {code or 'unknown'}")
        if code == "PUBLISHED":
            ledger.published(key, container_id=cid, media_id=None, permalink=None, **extra)
            log(f"{key} had in fact been posted; recorded it")
            return None
        if code in ("FINISHED", "IN_PROGRESS"):
            ig.wait_until_ready(cid, log=log)
            return _publish(ig, ledger, key, cid, extra, log)
        ledger.forget(key)  # expired or failed: start again

    path = video()
    log("uploading to Instagram")
    cid, uri = ig.create_container(caption, share_to_feed=share_to_feed,
                                   thumb_offset_ms=thumb_offset_ms)
    ig.upload(uri, path)
    ig.wait_until_ready(cid, log=log)
    return _publish(ig, ledger, key, cid, extra, log)


def _publish(ig: Instagram, ledger: Ledger, key: str, cid: str, extra: dict, log) -> str | None:
    ledger.publishing(key, cid)
    media_id = ig.publish(cid)
    link = ig.permalink(media_id)
    ledger.published(key, container_id=cid, media_id=media_id, permalink=link, **extra)
    log(f"posted {key}: {link or media_id}")
    return link
