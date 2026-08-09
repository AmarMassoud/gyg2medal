<div align="center">

# GYG2Medal

**Move your whole Gif Your Game clip library into Medal, dated the day you actually clipped it.**

[![Download](https://img.shields.io/github/v/release/AmarMassoud/gyg2medal?label=Download%20for%20Windows&style=for-the-badge)](https://github.com/AmarMassoud/gyg2medal/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

![The app](docs/screens.png)

</div>

## The problem

Medal bought Gif Your Game and never built a way to move your clips over. The
feature request for it sat on their feedback board and got archived without
being done. GYG's clip library is gone from the web, so most people assume
their clips went with it.

They didn't. The clips are still sitting on GYG's servers. There just wasn't a
door out.

This is the door. Sign in, wait a bit, and your clips are in Medal with the
right dates, the right game, and their tags.

## What it actually does

1. Signs you in on GYG's real login page, so email, Discord, Google and Steam
   all work exactly like they do on the website.
2. Finds every clip on your account, including old ones that stopped showing up
   in GYG's own interface years ago. It gets through about 200 clips a second.
3. Downloads all of them at full 720p60. If it gets interrupted, running it
   again picks up where it stopped.
4. Hands the folder to Medal so the clips import automatically.
5. Rewrites every clip's date to when you actually captured it.
6. Files each clip under its real game instead of dumping everything in
   "Imported".
7. Brings your GYG tags across as Medal hashtags.

Nothing on your GYG account is changed or deleted. The app only reads.

## Install

Grab the installer from [Releases](https://github.com/AmarMassoud/gyg2medal/releases/latest)
and run it. Windows only, since Medal's desktop app is Windows only.

Windows will put up a blue "Windows protected your PC" box because the app
isn't code signed. A signing certificate costs a few hundred a year and this is
a free tool, so: click **More info**, then **Run anyway**. If you'd rather not
take my word for it, the whole thing is here and you can
[build it yourself](#building-it-yourself).

There's also a portable .exe on the releases page if you don't want an
installer.

## The date thing, which is the whole point

You can already download your clips by hand and drop them in a folder Medal
watches. Plenty of people have. The problem is what happens next.

Medal stamps every imported clip with **the moment it scanned the file**. Not
the file's date. Not anything in the file. The moment it noticed it. I checked
this by importing two identical clips, one with a 2021 timestamp and one from
that morning, and both landed in Medal as today.

So five years of clips import as one enormous day, in whatever order Medal felt
like. Your 2021 highlights sit next to last week's, and there's no way to tell
them apart.

After Medal has finished importing, this app goes back through and rewrites
each clip's stored date with the real capture time from GYG, matched up by the
unique slug that's in every filename. My own library went from a single
undifferentiated block to this:

```
2021: 557    2022: 434    2023: 244    2024: 91    2025: 7    2026: 1
```

That's the part no manual workaround gets right, and it's why this exists.

## Games and tags

Medal drops everything it imports into one category called **Imported**. This
app re-files your clips under the game they were actually recorded in.

It reads the game list out of your own Medal install rather than shipping one,
because those category ids are Medal's server side identifiers and can't be
made up. Anything it can't match with confidence is deliberately left as
Imported instead of being given an id that might point somewhere wrong. Lunar
Client and friends get mapped to their parent game.

GYG tagged your clips automatically as you played, and those come across as
Medal hashtags:

```
#goal #save #assist            what kind of clip it is
#2v2 #ranked #casual #hoops     playlist
#mannfield #dfh-stadium ...     31 arenas
#champion2 #diamond1 ...        the rank you were at the time
```

A 1,334 clip library produced about 4,760 hashtags. The year, month, week and
day auto tags get dropped, because Medal already groups by month and they'd
just add four junk hashtags to every single clip.

## Two things worth knowing

**Medal only scans the top level of a folder.** If you put clips in per game
subfolders, Medal silently imports nothing. No error, no warning, just an empty
library. The app defaults to a flat folder for this reason. The subfolder
option is still there if you want them organised on disk, and it's labelled
with what it costs you.

**Medal only notices files that arrive.** It watches the folder, it never goes
back and enumerates what's already in it. Add a folder that already has 1,334
clips in it and Medal will happily ignore all of them forever. That's why the
app registers the folder with Medal *before* it starts downloading, and why it
can hand existing files over one batch at a time if you already downloaded them
some other way.

## Building it yourself

```bash
git clone https://github.com/AmarMassoud/gyg2medal
cd gyg2medal
npm run setup      # not npm install, see DEV.md for why
npm start          # run it
npm test           # the test suite
npm run build      # produces dist/GYG2Medal-Setup-<version>.exe
```

Node 18 or newer. No compiler needed, `npm run setup` pulls a prebuilt native
module for Electron's ABI. [DEV.md](DEV.md) has the dev mode that lets you work
on the Medal steps without re-downloading anything.

Pushing a `v*` tag builds the installer on GitHub's Windows runners and attaches
it to the release. See [.github/workflows/build.yml](.github/workflows/build.yml).

## How it works

None of this is documented anywhere, so it seems worth writing down.

### Gif Your Game

GYG runs a [Parse Server](https://parseplatform.org/) at
`api.gifyourgame.com/parse` with application id `badpanda`. Your clips are rows
in the `Clip` class, but `Clip` doesn't hold a usable video URL. That lives on a
related `Gyg` object, and the `Gyg` class blocks both `find` and `get` for
normal users.

The way through is the `fetchClip` cloud function, which runs with elevated
rights and returns the `Gyg` inline. Its `name` field is the media slug:

```
https://media.gifyourgame.com/<slug>_720p.mp4
```

Those media URLs are unsigned and don't expire. `fetchClips` (plural) hands back
the 100 newest clips already populated, so the app seeds from that and only pays
a per clip request for the rest.

There's no batch endpoint. `fetchClip` rejects arrays and `fetchGyg` is also one
at a time, so concurrency is the only lever there is. I measured it against the
live service instead of guessing:

| concurrency | throughput | median latency |
|---|---|---|
| 6 | 28.7 req/s | 189 ms |
| **16** | **74.1 req/s** | **197 ms** |
| 32 | 81.1 req/s | 385 ms |

16 is where extra throughput stops being free. A 1,334 clip library resolves in
about 7 seconds.

### Medal

Medal's desktop settings live in `%APPDATA%\Medal\medal-<userId>.db`, in a table
called `key_values`. Your local clip library is the `contents` table. Both store
their values as BLOBs, and those BLOBs are **SQLite JSONB**, which is SQLite's
own binary JSON format.

That is very easy to miss. The bytes look proprietary: a tag byte carrying the
payload length in the high nibble and the type in the low nibble, with `0xc` and
`0xd` length escapes. I reverse engineered the whole thing from scratch before
the penny dropped that it's simply the documented JSONB layout. The giveaway is
a trigger on `contents`:

```sql
CREATE TRIGGER content_counts_au AFTER UPDATE OF metadata ON contents
WHEN json_extract(OLD.metadata, '$.isFavorited') = 1 ...
```

SQLite will only apply `json_extract` to a BLOB if that BLOB is JSONB.

So the app does all of its reading and writing through SQLite's own `json()`,
`jsonb()` and `jsonb_set()`. A write touches exactly one JSON path and leaves
every other field byte identical, and getting the encoding right is SQLite's
problem rather than this app's. JSONB needs SQLite 3.45 or newer, and the app
checks the version and refuses rather than corrupting anything. Worth knowing if
you script against this yourself: Python's bundled SQLite is often older and
will fail with "malformed JSON" on these blobs.

`electron/medalcodec.js` is kept around as a standalone reference decoder. The
tests use it to check the format understanding against real bytes and against
SQLite's own encoder, but the app itself doesn't use it.

External recorder folders live under `ExternalFileSources`:

```json
{"folders":[{"label":"GYG-Clips",
             "value":"C:\\Users\\you\\Videos\\GYG-Clips",
             "enabled":true,"freeUpSpace":false}]}
```

Clip hashtags are a plain string array at `metadata.tags`.

### Not breaking your library

Every write to Medal's database refuses to run while Medal is open, backs up the
database and its write ahead log, works on a local copy (because `%APPDATA%` is
sometimes a mount that can't do SQLite's file locking), folds the WAL in so no
stale journal can resurrect old values, re-encodes and re-decodes before
committing, installs the result, then reads it back to confirm it took. If
anything goes wrong the backup goes back.

Folders you added yourself are always kept. Every step is idempotent, so running
it again changes nothing. Backups are named after the step they came before
(`...gyg2medal-datefix-...`, `-games-`, `-tags-`), and you restore one by closing
Medal and swapping it over `medal-<userId>.db`.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the
layout of the code and what to watch out for.

If something goes wrong while you're using it, the Medal screen has a **Copy
diagnostics** button. Paste that into an issue and it saves a lot of guessing.

## Disclaimer

Unofficial, and not affiliated with Medal or Gif Your Game. It reads your own
account through the same endpoints their own website uses, at a deliberately
modest request rate. Use it to get your own clips back.

## License

MIT. See [LICENSE](LICENSE).
