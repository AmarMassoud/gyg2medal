'use strict';
/**
 * REFERENCE IMPLEMENTATION -- not used by the app.
 *
 * Medal's blobs turned out to be SQLite JSONB, so the app reads and writes
 * them with SQLite's own json()/jsonb()/jsonb_set() (see medal.js) rather
 * than encoding by hand. This file is kept because it documents the format
 * independently, and `npm test` uses it to prove that understanding against
 * captured bytes from a real install.
 *
 * Medal keeps desktop settings as rows in %APPDATA%\Medal\medal-<userId>.db,
 * table `key_values`, and clip metadata in `contents`. Those BLOBs are SQLite
 * JSONB. This decoder was written from the bytes before that was recognised,
 * which is why it reads as a bespoke format -- it is in fact the JSONB spec,
 * and it reproduces every value in a real install byte-for-byte.
 *
 * Tag byte:  high nibble = payload length, low nibble = type.
 *
 *   0x0 null      (no payload)     0x8 string, JSON-escaped
 *   0x1 true      (no payload)     0xb array
 *   0x2 false     (no payload)     0xc map
 *   0x3 number, ASCII digits
 *   0x5 float,  ASCII digits
 *   0x7 string, verbatim
 *
 * When the payload is 12 bytes or more the high nibble escapes:
 *   0xc -> length in the next 1 byte
 *   0xd -> length in the next 2 bytes, big-endian
 */

const T_NULL = 0x0;
const T_TRUE = 0x1;
const T_FALSE = 0x2;
const T_NUM = 0x3;
const T_FLOAT = 0x5;
const T_RAW = 0x7;
const T_STR = 0x8;
const T_ARR = 0xb;
const T_MAP = 0xc;

const EXT1 = 0xc;
const EXT2 = 0xd;

class CodecError extends Error {}

function header(buf, pos) {
  if (pos >= buf.length) throw new CodecError(`ran off the end at byte ${pos}`);
  const tag = buf[pos];
  const hi = tag >> 4;
  const lo = tag & 0xf;
  if (hi === EXT1) {
    if (pos + 1 >= buf.length) throw new CodecError('truncated 1-byte length');
    return [lo, buf[pos + 1], 2];
  }
  if (hi === EXT2) {
    if (pos + 2 >= buf.length) throw new CodecError('truncated 2-byte length');
    return [lo, (buf[pos + 1] << 8) | buf[pos + 2], 3];
  }
  return [lo, hi, 1];
}

function decodeAt(buf, pos = 0) {
  if (pos >= buf.length) throw new CodecError('empty value');
  const nib = buf[pos] & 0xf;
  if (nib === T_NULL) return [null, pos + 1];
  if (nib === T_TRUE) return [true, pos + 1];
  if (nib === T_FALSE) return [false, pos + 1];

  const [lo, n, hdr] = header(buf, pos);
  const start = pos + hdr;
  const end = start + n;
  if (end > buf.length) throw new CodecError(`payload runs past the end (${end} > ${buf.length})`);
  const body = buf.subarray(start, end);

  switch (lo) {
    case T_NUM: {
      const v = Number(body.toString('ascii'));
      if (!Number.isFinite(v)) throw new CodecError(`bad number ${body}`);
      return [v, end];
    }
    case T_FLOAT: {
      const v = parseFloat(body.toString('ascii'));
      if (!Number.isFinite(v)) throw new CodecError(`bad float ${body}`);
      return [v, end];
    }
    case T_RAW:
      return [body.toString('utf8'), end];
    case T_STR:
      try {
        return [JSON.parse('"' + body.toString('utf8') + '"'), end];
      } catch {
        throw new CodecError(`bad escaped string ${body}`);
      }
    case T_ARR: {
      const out = [];
      let q = start;
      while (q < end) {
        const [item, next] = decodeAt(buf, q);
        out.push(item);
        q = next;
      }
      if (q !== end) throw new CodecError('array items overran their payload');
      return [out, end];
    }
    case T_MAP: {
      const out = {};
      let q = start;
      while (q < end) {
        const [key, afterKey] = decodeAt(buf, q);
        if (typeof key !== 'string') throw new CodecError('map key was not a string');
        const [value, afterVal] = decodeAt(buf, afterKey);
        out[key] = value;
        q = afterVal;
      }
      if (q !== end) throw new CodecError('map entries overran their payload');
      return [out, end];
    }
    default:
      throw new CodecError(`unknown type nibble 0x${lo.toString(16)} at byte ${pos}`);
  }
}

function decode(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const [value, end] = decodeAt(buf, 0);
  if (end !== buf.length) throw new CodecError(`trailing bytes: consumed ${end} of ${buf.length}`);
  return value;
}

function tagged(type, body) {
  const n = body.length;
  if (n < 12) return Buffer.concat([Buffer.from([(n << 4) | type]), body]);
  if (n < 256) return Buffer.concat([Buffer.from([(EXT1 << 4) | type, n]), body]);
  if (n < 65536) {
    return Buffer.concat([Buffer.from([(EXT2 << 4) | type, (n >> 8) & 0xff, n & 0xff]), body]);
  }
  throw new CodecError(`payload too large to encode: ${n} bytes`);
}

function encodeStr(value) {
  // Medal uses the verbatim form when nothing needs escaping, and the
  // JSON-escaped form when it does. Mirroring that reproduces real values.
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value
    ? tagged(T_RAW, Buffer.from(value, 'utf8'))
    : tagged(T_STR, Buffer.from(escaped, 'utf8'));
}

function encode(value) {
  if (value === null || value === undefined) return Buffer.from([0x00]);
  if (value === true) return Buffer.from([0x01]);
  if (value === false) return Buffer.from([0x02]);
  if (typeof value === 'string') return encodeStr(value);
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? tagged(T_NUM, Buffer.from(String(value), 'ascii'))
      : tagged(T_FLOAT, Buffer.from(String(value), 'ascii'));
  }
  if (Array.isArray(value)) {
    return tagged(T_ARR, Buffer.concat(value.map(encode)));
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      parts.push(encodeStr(String(k)), encode(v));
    }
    return tagged(T_MAP, Buffer.concat(parts));
  }
  throw new CodecError(`cannot encode ${typeof value}`);
}

/** Encode, decode again, and only return bytes that mean the same thing. */
function verifyRoundtrip(value) {
  const blob = encode(value);
  const again = decode(blob);
  if (JSON.stringify(again) !== JSON.stringify(value)) {
    throw new CodecError('value did not survive a round-trip; refusing to write');
  }
  return blob;
}

module.exports = { decode, encode, verifyRoundtrip, CodecError };
