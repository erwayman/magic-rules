// eslint-disable-next-line import/no-unresolved -- bun built-in module
import { Database } from 'bun:sqlite';
import os from 'os';
import path from 'path';
import { mkdirSync } from 'fs';
import picocolors from 'picocolors';
import { traceSync } from './trace-runner';

const identity = (x: any) => x;

// eslint-disable-next-line sukka-ts/no-const-enum -- bun is smart, right?
const enum CacheStatus {
  Hit = 'hit',
  Stale = 'stale',
  Miss = 'miss'
}

export interface CacheOptions {
  cachePath?: string,
  tbd?: number
}

interface CacheApplyNonStringOption<T> {
  ttl?: number | null,
  serializer: (value: T) => string,
  deserializer: (cached: string) => T,
  temporaryBypass?: boolean
}

interface CacheApplyStringOption {
  ttl?: number | null,
  temporaryBypass?: boolean
}

type CacheApplyOption<T> = T extends string ? CacheApplyStringOption : CacheApplyNonStringOption<T>;

const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
// Add some randomness to the cache ttl to avoid thundering herd
export const TTL = {
  humanReadable(ttl: number) {
    if (ttl >= ONE_DAY) {
      return `${Math.round(ttl / 24 / 60 / 60 / 1000)}d`;
    }
    if (ttl >= 60 * 60 * 1000) {
      return `${Math.round(ttl / 60 / 60 / 1000)}h`;
    }
    return `${Math.round(ttl / 1000)}s`;
  },
  THREE_HOURS: () => randomInt(1, 3) * ONE_HOUR,
  TWLVE_HOURS: () => randomInt(8, 12) * ONE_HOUR,
  ONE_DAY: () => randomInt(23, 25) * ONE_HOUR,
  THREE_DAYS: () => randomInt(1, 3) * ONE_DAY,
  ONE_WEEK: () => randomInt(4, 7) * ONE_DAY,
  TEN_DAYS: () => randomInt(7, 10) * ONE_DAY,
  TWO_WEEKS: () => randomInt(10, 14) * ONE_DAY
};

export class Cache {
  db: Database;
  tbd = 60 * 1000; // time before deletion
  cachePath: string;

  constructor({ cachePath = path.join(os.tmpdir() || '/tmp', 'hdc'), tbd }: CacheOptions = {}) {
    this.cachePath = cachePath;
    mkdirSync(this.cachePath, { recursive: true });
    if (tbd != null) this.tbd = tbd;

    const db = new Database(path.join(this.cachePath, 'cache.db'));
    db.exec('PRAGMA journal_mode = WAL');

    db.prepare('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, ttl REAL NOT NULL);').run();
    db.prepare('CREATE INDEX IF NOT EXISTS cache_ttl ON cache (ttl);').run();

    // perform purge on startup

    // ttl + tbd < now => ttl < now - tbd
    const now = Date.now() - this.tbd;
    db.prepare('DELETE FROM cache WHERE ttl < ?').run(now);

    this.db = db;
  }

  set(key: string, value: string, ttl = 60 * 1000): void {
    const insert = this.db.prepare(
      'INSERT INTO cache (key, value, ttl) VALUES ($key, $value, $valid) ON CONFLICT(key) DO UPDATE SET value = $value, ttl = $valid'
    );

    insert.run({
      $key: key,
      $value: value,
      $valid: Date.now() + ttl
    });
  }

  get(key: string, defaultValue?: string): string | undefined {
    const rv = this.db.prepare<{ value: string }, string>(
      'SELECT value FROM cache WHERE key = ?'
    ).get(key);

    if (!rv) return defaultValue;
    return rv.value;
  }

  has(key: string): CacheStatus {
    const now = Date.now();
    const rv = this.db.prepare<{ ttl: number }, string>('SELECT ttl FROM cache WHERE key = ?').get(key);

    return !rv ? CacheStatus.Miss : (rv.ttl > now ? CacheStatus.Hit : CacheStatus.Stale);
  }

  del(key: string): void {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  }

  async apply<T>(
    key: string,
    fn: () => Promise<T>,
    opt: CacheApplyOption<T>
  ): Promise<T> {
    const { ttl, temporaryBypass } = opt;

    if (temporaryBypass) {
      return fn();
    }
    if (ttl == null) {
      this.del(key);
      return fn();
    }

    const cached = this.get(key);
    let value: T;
    if (cached == null) {
      console.log(picocolors.yellow('[cache] miss'), picocolors.gray(key), picocolors.gray(`ttl: ${TTL.humanReadable(ttl)}`));
      value = await fn();

      const serializer = 'serializer' in opt ? opt.serializer : identity;
      this.set(key, serializer(value), ttl);
    } else {
      console.log(picocolors.green('[cache] hit'), picocolors.gray(key));

      const deserializer = 'deserializer' in opt ? opt.deserializer : identity;
      value = deserializer(cached);
    }
    return value;
  }

  destroy() {
    this.db.close();
  }
}

export const fsCache = traceSync('initializing filesystem cache', () => new Cache({ cachePath: path.resolve(import.meta.dir, '../../.cache') }));
// process.on('exit', () => {
//   fsCache.destroy();
// });

const separator = '\u0000';
// const textEncoder = new TextEncoder();
// const textDecoder = new TextDecoder();
// export const serializeString = (str: string) => textEncoder.encode(str);
// export const deserializeString = (str: string) => textDecoder.decode(new Uint8Array(str.split(separator).map(Number)));
export const serializeSet = (set: Set<string>) => Array.from(set).join(separator);
export const deserializeSet = (str: string) => new Set(str.split(separator));
export const serializeArray = (arr: string[]) => arr.join(separator);
export const deserializeArray = (str: string) => str.split(separator);
