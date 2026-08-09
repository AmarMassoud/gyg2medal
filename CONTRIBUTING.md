# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

[DEV.md](DEV.md) covers setup, dev mode and the tests. This file is about where
things live and what to be careful with.

## Layout

```
electron/
  main.js         window, IPC handlers, sign-in window
  preload.js      the only surface the renderer gets, everything is listed here
  gyg.js          GYG API client, scanning, concurrency
  downloader.js   resumable downloads
  medal.js        everything that touches Medal: detection, profiles, writes
  medalcodec.js   reference JSONB decoder, used by tests only
renderer/
  index.html      all six screens
  app.js          screen flow and the Medal step machine
  styles.css      design tokens at the top, then components
test/
  run.js          unit tests, no account or install needed
  medal_ops.js    integration tests, needs MEDAL_DB set
  screens.js      renders every screen to test/shots/
```

## Things to be careful with

**Writes to Medal's database.** This is somebody's clip library and there is no
undo beyond the backups the app makes. Every write goes through
`beginWrite` / `commitWrite` / `rollback` in `medal.js`, which handles the
backup, the WAL checkpoint, the local working copy and the read back. If you add
an operation, use those rather than opening the database yourself.

**Don't hand-encode JSONB.** Read and write through SQLite's `json()`,
`jsonb()` and `jsonb_set()` so that a change touches one path and leaves the
rest of the blob untouched. `medalcodec.js` exists to document the format and to
give the tests an independent check, not to be used at runtime.

**Process detection.** `parseTasklist` matches image names exactly for a reason.
An earlier substring check meant `GYG2Medal.exe` matched `Medal.exe`, so the app
saw itself running and refused every write. There are regression tests for this.

**The preload is the security boundary.** `contextIsolation` is on and the
renderer has no Node. Anything new the UI needs has to be added explicitly to
`preload.js`, and it should go through the `call()` wrapper so a thrown error
comes back as data the UI can display rather than a rejected promise nothing
catches.

**Keep errors visible.** If a step can fail, it needs to say so on screen. A
silent failure here looks exactly like a slow import, and people wait for hours.

## Style

No build step, no TypeScript, no framework. Plain JS, 2 space indent, single
quotes. Comments should explain why something is the way it is, especially when
it's odd, since most of the odd parts are working around undocumented behaviour
in Medal or GYG.

## Before opening a pull request

```bash
npm test
npm run shots     # if you changed the UI, so the screens can be eyeballed
```

If you changed something about how Medal behaves, say how you verified it.
"Imported two clips with different file dates and both landed as today" is worth
more than a paragraph of reasoning.

## Please don't commit

* `test/fixtures.json` or any clip manifest. Both contain personal data.
* Anything with your Windows username, Medal user id or email in it. The test
  fixtures use `you`, `1234567` and `you@example.com` on purpose.
