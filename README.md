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

They didn't. The clips are still there. There just wasn't a door out.

This is the door. Sign in, wait a bit, and your clips are in Medal with the
right dates, the right game, and their tags.

## What it actually does

1. Signs you in on GYG's real login page, so email, Discord, Google and Steam
   all work exactly like they do on the website.
2. Finds every clip on your account, including old ones that stopped showing up
   in GYG's own interface years ago.
3. Downloads all of them at full 720p60. If it gets interrupted, running it
   again picks up where it stopped.
4. Hands the folder to Medal so the clips import automatically.
5. Makes sure each clip ends up dated when you actually captured it.
6. Files each clip under its real game instead of dumping everything in
   "Imported".
7. Brings your GYG tags across as Medal hashtags.

Nothing on your GYG account is changed or deleted. The app only reads, and it
does it the same way the website always did.

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

Once the import has finished, this app puts the real capture dates back. My own
library went from a single undifferentiated block to this:

```
2021: 557    2022: 434    2023: 244    2024: 91    2025: 7    2026: 1
```

That's the part no manual workaround gets right, and it's why this exists.

## Games and tags

Medal drops everything it imports into one category called **Imported**. This
app re-files your clips under the game they were actually recorded in, going by
the game list already present in your own Medal install. Anything it can't
match with confidence is deliberately left as Imported rather than guessed at.
Lunar Client and friends get mapped to their parent game.

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
app introduces the folder to Medal *before* it starts downloading, and why it
can feed existing files in one batch at a time if you already downloaded them
some other way.

## Your library is safe

Every change on the Medal side happens with Medal closed, and the app takes its
own backup of your Medal library beforehand, once per step. Each step is
checked after it runs, and if anything doesn't come back the way it should, the
backup goes straight back.

Folders you added yourself are always kept. Every step is idempotent, so running
it again changes nothing. Backups are named after the step they came before
(`...gyg2medal-datefix-...`, `-games-`, `-tags-`), and you restore one by closing
Medal and putting it back in place of `medal-<userId>.db`.

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

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the
layout of the code and what to watch out for.

If something goes wrong while you're using it, the Medal screen has a **Copy
diagnostics** button. Paste that into an issue and it saves a lot of guessing.

## Disclaimer

Unofficial, and not affiliated with Medal or Gif Your Game. It reads your own
account, at a deliberately modest request rate, and writes nothing back to it.
Use it to get your own clips back.

## License

MIT. See [LICENSE](LICENSE).
