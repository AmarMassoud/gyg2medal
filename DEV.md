# Running from source

Rebuilding a 78 MB installer for every change is painful, and re-downloading
1,334 clips just to reach the Medal steps is worse. This is the short loop.

## Setup

```bash
cd gyg2medal
npm run setup
```

**Use `npm run setup`, not `npm install`.**

The app runs on Electron, which bundles its own Node. The one native module
here (`better-sqlite3`) therefore has to be built for *Electron's* ABI, not
yours. A plain `npm install` builds it for your Node instead, and if no prebuilt
binary exists for that version (Node 24 had none at the time of writing) npm
falls back to compiling from source, which wants Visual Studio with the C++
workload. That's several GB of tooling for a binary the app would never load.

`npm run setup` skips install scripts, fetches Electron, then pulls the prebuilt
`better-sqlite3` for Electron's ABI. No compiler needed.

Node 18 or newer, from https://nodejs.org. Any version works, it's only used to
run npm.

## Run it

```bash
npm start          # normal
npm run dev        # dev mode, skips sign-in, scan and download
```

## Dev mode

A **Dev mode** panel shows up on the first screen. It loads a saved scan
manifest and asks which folder your clips are already in, then jumps straight to
the Medal steps. Two seconds instead of twenty minutes.

Every real scan gets cached automatically to:

```
%APPDATA%\GYG2Medal\last-scan.json
```

so once you've scanned once, dev mode always has something to replay. You can
also point it at a specific manifest file.

## Tests

```bash
npm test
```

The codec tests run anywhere. Two extra suites turn on when you give them data:

* `test/fixtures.json` enables byte-exactness checks against blobs captured from
  a real Medal install. It's not in the repo because it's personal data.
  `test/README.md` has the snippet to make your own.
* `MEDAL_DB=<path to a copy of a Medal database>` enables the integration tests
  for the database writes. They always work on a temp copy and never touch your
  real library.

One caveat: the tests run under plain Node, so they need a Node ABI build of
`better-sqlite3`, which may not exist for whatever Node you have. The codec
tests still pass either way. That's expected on a dev machine and doesn't affect
the app.

## Screenshots

```bash
npm run shots      # writes test/shots/*.png
```

Renders every screen against a fake preload with made up data, so the docs can
be regenerated without a real account.

## Building the installer

```bash
npm run build
```

Output lands in `dist/`. `npm run build:cross` is only for producing Windows
binaries from Linux. It swaps the native module out and restores it afterwards.

Pushing a `v*` tag builds on GitHub's Windows runners and attaches the installer
to the release.
