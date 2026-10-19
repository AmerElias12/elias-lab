"""posted.json: which reels have gone out, so none goes out twice.

Each reel is keyed by its spec's file name without .toml. Renaming a spec
makes it a new reel as far as the bot is concerned.

An entry is written *before* the publish call, as status "publishing" with
the container id, and rewritten as "published" after. If the bot dies in
between, the next run finds the container and asks Instagram what became of
it, instead of uploading the same video again.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import pathlib


class Ledger:
    def __init__(self, path: str | pathlib.Path):
        self.path = pathlib.Path(path)
        if self.path.exists():
            self.entries: dict[str, dict] = json.loads(self.path.read_text(encoding="utf-8"))
        else:
            self.entries = {}

    def get(self, name: str) -> dict | None:
        return self.entries.get(name)

    def is_published(self, name: str) -> bool:
        return (self.entries.get(name) or {}).get("status") == "published"

    def publishing(self, name: str, container_id: str) -> None:
        self.entries[name] = {"status": "publishing", "container_id": container_id,
                              "started_at": _now()}
        self._save()

    def published(self, name: str, *, container_id: str, media_id: str | None,
                  permalink: str | None) -> None:
        self.entries[name] = {"status": "published", "container_id": container_id,
                              "media_id": media_id, "permalink": permalink,
                              "posted_at": _now()}
        self._save()

    def forget(self, name: str) -> None:
        if self.entries.pop(name, None) is not None:
            self._save()

    def _save(self) -> None:
        # Write then rename: a crash mid-write leaves the old file, not half a
        # file that would make every reel look unposted.
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.entries, indent=2, sort_keys=True) + "\n",
                       encoding="utf-8")
        os.replace(tmp, self.path)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
