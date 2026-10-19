# Instagram Reels bot

Makes short vertical videos (Reels) for the lab's Instagram from a few lines
of text and some pictures, then posts them. One small file per Reel:

```toml
caption  = "Meet the Elias Lab."
hashtags = ["genetherapy", "molecularbiology"]

[[slide]]
image    = "../../assets/team/Hala-Kassis.jpg"
text     = "Meet Hala"
duration = 3.5

[[slide]]
text     = "We engineer tyrosine integrases"
position = "center"
duration = 3
```

The bot turns that into a 1080×1920 MP4 (slow zoom on each picture, text in
the lab's colours, crossfades, optional music) and publishes it through
Instagram's official API. It does not log in with a password or drive a
browser, so it does not break Instagram's rules.

```
instagram-video-bot/
├── bot.py            # the command you run
├── reels/            # one .toml per Reel, posted in file-name order
├── reelbot/
│   ├── spec.py       # reads and checks a .toml
│   ├── render.py     # ffmpeg: slides -> MP4
│   ├── instagram.py  # Graph API: upload -> publish
│   └── ledger.py     # posted.json: what has gone out
├── check_bot.py      # 32 checks; posts nothing
├── out/              # rendered videos (git-ignored)
└── posted.json       # created on the first post
```

## 1. Install

You need **Python 3.11+** and **ffmpeg**.

```bash
# ffmpeg — macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg
cd instagram-video-bot
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python check_bot.py                                   # should end "32 checks passed"
```

Make your first video without any Instagram setup:

```bash
python bot.py render reels/01-meet-the-lab.toml       # -> out/01-meet-the-lab.mp4
```

Open the MP4 and watch it. Rendering never posts anything.

## 2. Connect Instagram (once)

Instagram only lets apps post to **professional** accounts (Business or
Creator). Switching is free: in the Instagram app, open *Settings → Account type
and tools → Switch to professional account*.

1. Go to [developers.facebook.com](https://developers.facebook.com/apps) and
   click **Create app**. Choose the use case *Manage messaging & content on
   Instagram*. If that option is missing, choose *Other*, then *Business*.
2. In the app, add the **Instagram** product. Choose **API setup with Instagram
   login**.
3. Under *Generate access tokens*, add the lab's Instagram account. Log in and
   allow the permissions. The token needs `instagram_business_basic` and
   `instagram_business_content_publish`.
4. Copy the **access token** and the account's numeric **Instagram user ID**,
   both shown on that page.
5. Copy `.env.example` to `.env`, and paste both values in:

   ```
   IG_USER_ID=17841400000000000
   IG_ACCESS_TOKEN=IGAA...
   ```

6. Check the setup:

   ```bash
   python bot.py check
   ```

   It validates every spec in `reels/`, finds ffmpeg and a font, and logs in.
   It prints the account name and how many API posts you have used in the last
   24 hours. It posts nothing.

`.env` is git-ignored, and has to stay that way: **this repository is public**,
and anyone with the token can post to the account.

The app can stay in *Development* mode while it only posts to accounts you
added in step 3. Meta's App Review is required only to post to other
people's accounts.

<details>
<summary>Using the older Facebook Login flow instead</summary>

If the Instagram account is already linked to a Facebook Page and your app
uses *Instagram API with Facebook Login*, the token needs
`instagram_basic`, `instagram_content_publish` and `pages_read_engagement`.
`IG_USER_ID` is the Page's `instagram_business_account` id. Then add the
following line to `.env`:

```
IG_GRAPH_HOST=graph.facebook.com
```
</details>

### The token expires after 60 days

When it expires, `check` and every post fail with *"the access token is
invalid or has expired"*. Generate a new one as in step 3. You can also
refresh a token that has not expired yet, at least 24 hours after it was
issued:

```bash
curl "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$IG_ACCESS_TOKEN"
```

Put the new `access_token` from the answer into `.env`. Set a calendar
reminder for every 50 days.

## 3. Make and post Reels

```bash
python bot.py render reels/02-new-paper.toml          # look at it first
python bot.py post   reels/02-new-paper.toml --dry-run  # render + show the exact caption
python bot.py post   reels/02-new-paper.toml          # post it now
python bot.py next                                    # post the first reel in reels/ not yet posted
python bot.py status                                  # what is posted, what is queued
```

`posted.json` records every Reel that went out, with its link, so no Reel is
ever posted twice. Commit it if you run the bot from more than one computer.
Reels are tracked by file name, so a renamed file counts as a new Reel.

If the bot is interrupted after Instagram has the video, the next run checks
the upload with Instagram first. It finishes the post or records it, and
does not upload the video again.

### Post on a schedule

Write a batch of specs, number them (`02-…`, `03-…`), and let `next` post one
per run. For example, at 18:00 every Tuesday and Friday:

```cron
0 18 * * 2,5  cd /path/to/elias-lab/instagram-video-bot && .venv/bin/python bot.py next >> bot.log 2>&1
```

(`crontab -e` on macOS/Linux; Task Scheduler on Windows.) The computer has to
be on at that time. When the queue is empty, `next` says so and does nothing.

## Spec reference

Paths are relative to the `.toml` file. The bot checks everything before it
renders, so a typo is reported with the file and slide number and does not
end up as a broken post.

**Reel settings** (top of the file)

| Setting | Default | |
|---|---|---|
| `caption` | `""` | The post text. A line ending in `\` joins the next line. |
| `hashtags` | `[]` | Added on their own line. A tag already in the caption is not repeated. Max 30. |
| `music` | none | Audio file, looped or cut to fit, faded out at the end. Without it, the Reel has a silent track. |
| `music_volume` | `0.8` | 0–2 |
| `crossfade` | `0.5` | Seconds of fade between slides. `0` = hard cuts. |
| `cover_at` | Instagram picks | Second of the video to use as the cover frame. |
| `share_to_feed` | `true` | Also show it on the profile grid, not only in Reels. |

**Slide settings** (each `[[slide]]`)

| Setting | Default | |
|---|---|---|
| `duration` | required | Seconds, at least 1. |
| `text` | none | Wrapped to fit. Your own line breaks are kept. |
| `image` | none | JPG/PNG/WebP. Without one, the slide is a flat colour. |
| `fit` | `"cover"` | `cover` fills the screen (crops the edges). `contain` shows the whole image on the background colour, for logos and figures. |
| `position` | `"bottom"` | Text at `top`, `center` or `bottom`, inside the area Instagram's buttons do not cover. |
| `background` | `"#0c4a44"` | Lab teal. Used when there is no image, or around a `contain` image. |
| `text_color` | `"#f4f1e8"` | Lab paper-white. Dark text gets a light band behind it over photos. |
| `zoom` | `true` | Slow push-in. `false` holds still. |

A Reel must run at least 3 seconds. Each crossfade overlaps two slides, so
the length is the sum of the durations minus one crossfade per join.
`check` and `render` print the length.

## Before you post

- **People:** ask everyone who appears in a Reel before it goes up, even if
  their photo is already on the lab website.
- **Music:** use only tracks you have the rights to. Instagram mutes or
  removes Reels with unlicensed audio, and the API cannot use Instagram's own
  music library.
- **Limits:** Instagram allows a fixed number of API posts per account in
  any 24 hours. `check` shows how many are used.
