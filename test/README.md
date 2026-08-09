# Tests

```bash
npm test
```

`run.js` needs nothing. It checks the JSONB codec against SQLite's own encoder,
covers the edge cases, and has regressions for Medal process detection and
profile ranking.

Two suites turn on when you give them data.

## fixtures.json

Byte-exactness against blobs captured from a real Medal install. Not in the repo
because it's personal data. To make your own, with Medal closed:

```js
// node makefixtures.js  (from a copy of your database, not the original)
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('medal-<yourId>.db', { readonly: true });

const settings = {};
for (const r of db.prepare('select key, value from key_values').all()) {
  if (Buffer.isBuffer(r.value)) settings[r.key] = r.value.toString('hex');
}
const metadata = db.prepare('select metadata from contents limit 40').all()
  .map((r) => r.metadata).filter(Buffer.isBuffer).map((b) => b.toString('hex'));

fs.writeFileSync('test/fixtures.json', JSON.stringify({ settings, metadata }));
```

It's gitignored. Keep it that way, the blobs contain your clip titles and paths.

## medal_ops.js

Integration tests for the database writes. Point them at a **copy** of a real
database:

```bash
MEDAL_DB=/path/to/copy/medal-<yourId>.db npm test
```

```bat
set MEDAL_DB=%APPDATA%\Medal\medal-<yourId>.db
npm test
```

They copy it into a temp directory first and never write to the file you give
them.

## Screenshots

```bash
npm run shots
```

Renders every screen with `fake-preload.js`, which serves made up data, into
`test/shots/`. On Linux it needs a display, so `xvfb-run -a npm run shots`.
