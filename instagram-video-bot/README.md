# Instagram Reels bot

This folder holds two tools that post to the lab's Instagram through the official API:

- **The daily pipeline** (`pipeline.py`) makes a new Reel every day with no
  one at the keyboard. Claude writes the idea, an AI video model animates the
  lab's character, ffmpeg turns the clip into a Reel, and the pipeline
  publishes it. A small Node.js scheduler runs it once a day.
- **The slide bot** (`bot.py`) makes Reels from photos and text you choose,
  described in a small file. See [Slide Reels](#slide-reels-botpy) at the end.

```
            node-cron (scheduler/)  ── once a day ──►  python pipeline.py run
                                                                │
 ┌──────────────────────────┬──────────────────────────┬────────┴──────────────┬──────────────────────────┐
 │ 1. plan                  │ 2. video                 │ 3. edit               │ 4. post                  │
 │ Claude writes the video  │ PiAPI or Kling renders   │ ffmpeg: crop to 9:16, │ Instagram Graph API:     │
 │ prompt, subtitles,       │ the clip; it is          │ music underneath,     │ upload, wait, publish,   │
 │ caption, hashtags        │ downloaded as raw.mp4    │ subtitles burned in   │ record in posted.json    │
 └──────────────────────────┴──────────────────────────┴───────────────────────┴──────────────────────────┘
      out/daily/<date>/plan.json      raw.mp4                 reel.mp4               posted.json
```

Each stage saves its result before the next one starts. If a run fails
anywhere (a provider is down, the video takes too long, the internet drops),
the next run continues from that point. It does not ask Claude again, does
not pay for a second video, and never posts twice on the same day.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Install](#2-install)
3. [Get the API keys](#3-get-the-api-keys)
4. [Set up the character and the posts](#4-set-up-the-character-and-the-posts)
5. [Add background music](#5-add-background-music)
6. [First run, step by step](#6-first-run-step-by-step)
7. [Run it every day](#7-run-it-every-day)
8. [Day-to-day](#8-day-to-day)
9. [Troubleshooting](#9-troubleshooting)
10. [How it is built](#10-how-it-is-built)
11. [Slide Reels (bot.py)](#slide-reels-botpy)

---

## 1. What you need

| | |
|---|---|
| **A computer that stays on** | It runs the schedule. A lab PC, a Mac mini, or a small cloud server ($5/month) all work. |
| **Python 3.11+** | `python3 --version` |
| **Node.js 20.12+** | `node --version`. Used only for the scheduler. |
| **ffmpeg** | `ffmpeg -version` |
| **An Instagram professional account** | Business or Creator. Switching is free: *Settings → Account type and tools*. |
| **Three paid API accounts** | Claude (Anthropic), a video generator (PiAPI *or* Kling), and Meta (the Meta API itself is free). |

**What it costs per day:** one Claude request costs a few cents. One 5-second
video is billed by PiAPI or Kling in credits, and the price depends on the
model version and `std`/`pro` mode, so check their pricing pages. Instagram
publishing is free.

## 2. Install

```bash
cd instagram-video-bot

# ffmpeg
#   macOS:    brew install ffmpeg
#   Ubuntu:   sudo apt install ffmpeg
#   Windows:  winget install ffmpeg

# Python packages, in a private environment
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install -r requirements.txt        # requests, anthropic, PyJWT

# The scheduler
cd scheduler && npm install && cd ..   # node-cron

# Prove it all works (no API is called, nothing is posted)
python check_bot.py                    # 32 checks: slides, Instagram client
python check_pipeline.py               # 25 checks: generator, Claude, editing, daily run, scheduler
```

Both check scripts should end with `… checks passed`.

## 3. Get the API keys

```bash
cp .env.example .env
```

Fill in `.env` as you go through the steps below. **Never commit `.env`.**
This repository is public, and these keys can spend money and post to the
account. `.env` is already git-ignored.

### 3a. Claude (writes the posts)

1. Sign in at [platform.claude.com](https://platform.claude.com) and add a
   payment method under *Billing*.
2. Open *API keys*, click *Create key*, and paste the key into `.env`:
   `ANTHROPIC_API_KEY=sk-ant-...`

### 3b. The video generator: pick one

**PiAPI** is the easiest. It's a single API key, it resells Kling, and it
charges per video.

1. Sign up at [piapi.ai](https://piapi.ai) and top up credits.
2. Copy the key from the workspace and paste it into `.env`: `PIAPI_API_KEY=...`
3. In `pipeline.toml`, keep `provider = "piapi"`. Set `model` to the Kling
   version you want, such as `"1.6"` or `"2.1"`. PiAPI's Kling page lists the
   current versions.

**Kling directly** means you buy credits from Kling itself.

1. Sign up at the [Kling AI developer console](https://app.klingai.com/global/dev)
   and buy an API resource pack.
2. Create an API key. Kling gives you an **Access Key** and a **Secret Key**.
   Paste both into `.env`:
   `KLING_ACCESS_KEY=...` and `KLING_SECRET_KEY=...`
3. In `pipeline.toml`, set `provider = "kling"` and set `model` to a Kling
   `model_name`, such as `"kling-v1-6"`.
4. If your console shows a regional API address (for example
   `api-singapore.klingai.com`), set `KLING_BASE_URL` to it.

The secret key never leaves your computer. The pipeline uses it to sign a
short-lived token for each request.

### 3c. Instagram (publishes the Reel)

1. Make sure the lab's account is a **professional** account (see above).
2. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
   and click **Create app**. Choose the use case *Manage messaging & content on
   Instagram*. If that option is missing, choose *Other*, then *Business*.
3. In the app, open **Instagram → API setup with Instagram login**.
4. Under *Generate access tokens*, click *Add account*, log in as the lab's
   Instagram account, and allow the permissions. The token needs
   `instagram_business_basic` and `instagram_business_content_publish`.
5. Copy the **access token** and the numeric **Instagram user ID** into `.env`:

   ```
   IG_USER_ID=17841400000000000
   IG_ACCESS_TOKEN=IGAA...
   ```

The app can stay in *Development* mode while it only posts to accounts you
added in step 4. Meta's App Review is required only to post to other
people's accounts.

<details>
<summary>Already use the Facebook Login flow (Instagram linked to a Facebook Page)?</summary>

The token needs `instagram_basic`, `instagram_content_publish` and
`pages_read_engagement`. `IG_USER_ID` is the Page's
`instagram_business_account` id. Then add the following line to `.env`:

```
IG_GRAPH_HOST=graph.facebook.com
```
</details>

**The Instagram token expires after 60 days.** Before it does, refresh it
(you can do this any time after the first 24 hours):

```bash
curl "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$IG_ACCESS_TOKEN"
```

Put the new `access_token` from the answer into `.env`. Set a calendar
reminder for every 50 days. Once it has expired, `check` says so and you
generate a new one as in step 4.

### 3d. Check everything

```bash
python pipeline.py check
```

```
  ok    pipeline.toml: Inty, piapi 1.6
  ok    ffmpeg and a font
  ok    3 music track(s) in music/
  ok    piapi key is set
  ok    ANTHROPIC_API_KEY is set
  ok    Instagram: logged in as @eliaslab
```

## 4. Set up the character and the posts

Everything that isn't a secret is in **`pipeline.toml`**:

```toml
[character]          # who appears in every Reel
name        = "Inty"
look        = "a small round mint-green enzyme creature with ... a teal lab coat ..."
personality = "curious, cheerful, a little clumsy"
style       = "stylized 3D animation, soft studio lighting, pastel colours"

[content]            # what the posts are about
brand    = "the Elias Lab, a molecular biology and gene therapy lab"
audience = "students and science-curious people ..."
themes   = ["how an enzyme finds one exact spot in DNA", "..."]
hashtag_count   = 8
always_hashtags = ["eliaslab"]

[video]
provider  = "piapi"   # or "kling"
model     = "1.6"
mode      = "std"     # or "pro"
duration  = 5         # 5 or 10 seconds
```

Tips:

- **Make `look` concrete:** colours, shape, clothing, one prop. The video
  model starts from nothing every day, so the character only looks the same
  if the description is specific. Claude repeats it word for word in every
  prompt.
- **Themes steer the topics; they aren't a schedule.** Claude picks one each
  day and is shown the last 14 days' topics so it doesn't repeat them.
- **Check the result before posting:** run `python pipeline.py run
  --plan-only` to see the plan Claude would write, at the cost of one Claude
  request.

## 5. Add background music

Put audio files in **`music/`**. Each day uses one:

- **the newest file not used yet.** To follow a trend, add the track this
  week and it goes out next.
- once all have been used, **the track used longest ago**.

The track is cut to the clip's length and faded in and out. The clip's own
generated sound is dropped unless you raise `original_volume` in
`pipeline.toml`.

> **Use only music you have the rights to.** No API offers Instagram's
> "trending audio" to third-party apps. The API can't attach songs from
> Instagram's music library, and Reels with copyrighted songs uploaded this
> way get muted or taken down. Use royalty-free or licensed tracks, for
> example from the YouTube Audio Library, Pixabay Music, Epidemic Sound or
> Artlist. Pick ones in the style of what is trending. The `music/` folder
> is git-ignored, so the files are not published with this repository.

With no music, the Reel keeps the generated clip's sound, or silence if it
has none.

## 6. First run, step by step

Run these once, by hand, and look at each result before turning on the
schedule:

```bash
python pipeline.py run --plan-only   # 1. Claude's plan for today (a few cents)
python pipeline.py run --no-post     # 2. render + edit the video (costs one video), don't post
```

Open `out/daily/<today>/reel.mp4` and watch it. If you like it:

```bash
python pipeline.py run               # 3. post it (picks up from step 2, no new video)
```

To test only the ffmpeg step, on any video and with no API calls:

```bash
python pipeline.py edit some-clip.mp4 -s "First subtitle" -s "Second one" -m music/track.mp3
```

## 7. Run it every day

```bash
cd scheduler
npm start              # stays running; posts every day at CRON_SCHEDULE
npm run now            # or: run the pipeline once, right now
```

The schedule is set in `.env`:

```
CRON_SCHEDULE=45 17 * * *      # minute hour day month weekday: 17:45 daily
CRON_TIMEZONE=Asia/Jerusalem
```

Examples: `0 9 * * *` (09:00 daily), `30 18 * * 1-5` (18:30 on weekdays),
`0 12 * * 2,4,6` (noon on Tue/Thu/Sat). If a run fails, the scheduler tries
again after `CRON_RETRY_HOURS` (default 2). The retry continues where the
failed run stopped, so it does not pay again.

The scheduler has to keep running. Pick one way to keep it alive:

<details>
<summary><b>Linux server: systemd</b> (restarts it on crash and on reboot)</summary>

`/etc/systemd/system/reelbot.service`:

```ini
[Unit]
Description=Elias Lab daily Reel
After=network-online.target

[Service]
WorkingDirectory=/home/YOU/elias-lab/instagram-video-bot/scheduler
ExecStart=/usr/bin/node index.js
Restart=always
User=YOU

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now reelbot
journalctl -u reelbot -f          # watch the log
```
</details>

<details>
<summary><b>Any OS: pm2</b></summary>

```bash
npm install -g pm2
cd scheduler && pm2 start index.js --name reelbot
pm2 save && pm2 startup           # start again after a reboot
pm2 logs reelbot
```
</details>

<details>
<summary><b>Without Node: system cron</b></summary>

The scheduler only runs `python pipeline.py run`, so plain cron does the
same job:

```cron
45 17 * * *  cd /path/to/instagram-video-bot && .venv/bin/python pipeline.py run >> daily.log 2>&1
```
</details>

## 8. Day-to-day

```
out/daily/2026-10-20/
├── plan.json     what Claude wrote: topic, video prompt, subtitles, caption, hashtags
├── state.json    progress: the video task id, the music track used
├── raw.mp4       the clip as the video generator made it
└── reel.mp4      the finished Reel that was posted
posted.json       every post: date, link, topic, track
```

| To… | Do this |
|---|---|
| See what went out | `posted.json`, or open the permalink in it |
| Skip a day | Stop the scheduler for the day (`pm2 stop reelbot` / `systemctl stop reelbot`) and start it again tomorrow |
| Redo today's plan | delete `out/daily/<today>/` (before it is posted) and run again |
| Re-edit without a new video | delete `reel.mp4` only, then run again |
| Make a past or future day | `python pipeline.py run --date 2026-10-25` |
| Change the character or topics | edit `pipeline.toml`; it applies from the next plan |

`posted.json` is the bot's memory of what went out. Back it up. Commit it
if you move the bot to another computer.

## 9. Troubleshooting

| Message | Meaning and fix |
|---|---|
| `ANTHROPIC_API_KEY is missing or not valid` | Check the key in `.env` and that billing is set up. |
| `PiAPI answered HTTP 401 (check the API key …)` | Wrong `PIAPI_API_KEY`, or no credits left. |
| `Kling error 1102: …balance…` | Buy more Kling credits. |
| `… could not make the video: …` | The provider refused or failed the prompt (often content moderation). The next run asks again with a fresh task. If it keeps failing, soften the character or the themes. |
| `… still not finished after 30 min` | The provider is busy. The next run picks up the **same** task. Raise `timeout_minutes` if it happens often. |
| `completed, but no video URL was found (keys: […])` | PiAPI changed its response shape. Open an issue with the keys listed. |
| `the access token is invalid or has expired` | Refresh or regenerate the Instagram token (section 3c). |
| `the token lacks the content-publish permission` | Regenerate the token and allow publishing. |
| `Instagram could not process the video (ERROR)` | Rare with this pipeline's output. Run `python pipeline.py edit` on `raw.mp4` and check the result. |
| `rate limited` | Instagram allows a fixed number of API posts per account per day. Wait and run again. |
| `Claude declined to write this plan` | A safety check stopped the request. Reword the themes in `pipeline.toml`. |

## 10. How it is built

```
instagram-video-bot/
├── pipeline.py          # the daily run (plan → video → edit → post) and its CLI
├── pipeline.toml        # character, topics, video and music settings
├── scheduler/
│   ├── index.js         # node-cron: runs `pipeline.py run` daily, retries failures
│   └── package.json
├── reelbot/
│   ├── writer.py        # Claude (claude-opus-5-5) → validated Plan JSON
│   ├── generator.py     # PiAPI / Kling: submit, poll, download
│   ├── edit.py          # ffmpeg: 9:16 crop, music, burned-in subtitles
│   ├── instagram.py     # Graph API: resumable upload, wait, publish
│   ├── publish.py       # post once; resume a publish that was cut off
│   ├── ledger.py        # posted.json
│   ├── render.py        # slide renderer (bot.py) and shared ffmpeg helpers
│   └── spec.py          # slide Reel files (bot.py)
├── music/               # your licensed tracks (git-ignored)
├── check_pipeline.py    # 25 checks, fake APIs, real ffmpeg
├── check_bot.py         # 32 checks for the slide bot and the Instagram client
└── bot.py               # slide Reels
```

Some details:

- **Claude** is called once a day through the official `anthropic` SDK, with
  structured output: the reply must match the `Plan` schema. If Claude's
  safety checks decline the request, the API retries it on a recommended
  fallback model (`fallbacks: "default"`). Set `ANTHROPIC_MODEL` in `.env`
  to use a different model.
- **The video** is requested in 9:16. The edit still crops whatever comes
  back to 9:16, so a model that ignores the aspect ratio doesn't break the
  post.
- **The Reel** is H.264/AAC 1080×1920 at 30 fps, which Instagram accepts.
  It goes up by **resumable upload**, so it never needs a public URL.
- **Subtitles** sit above the area Instagram covers with its caption and
  buttons. Each one stays on screen for a time that grows with its length.
- **Secrets** are read from `.env` only. The Instagram token is sent in a
  header, never in a URL, so it does not end up in logs.

---

## Slide Reels (bot.py)

Use this when you want to choose the pictures and words yourself: a lab
photo, a new paper, a welcome to a new member. Write one small file per Reel
in `reels/`:

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

The bot renders a 1080×1920 MP4 from it: a slow zoom on each picture, text in
the lab's colours, crossfades between slides, and optional music. It posts
with the same Instagram setup as above.

```bash
python bot.py render reels/01-meet-the-lab.toml         # make the MP4, post nothing
python bot.py post   reels/01-meet-the-lab.toml --dry-run  # render + show the exact caption
python bot.py post   reels/01-meet-the-lab.toml         # post it now
python bot.py next                                      # post the first reel in reels/ not yet posted
python bot.py status                                    # what is posted, what is queued
python bot.py check                                     # validate every spec, and the login
```

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

Slide Reels and daily Reels share `posted.json`, so neither tool posts
anything twice. Ask everyone who appears in a photo before posting it.
