import { DurableObject } from 'cloudflare:workers';

// One SQLite-backed Durable Object instance ("main") holds the site's own data: who used how
// many minutes (and how much of it came from packs bought in reem.bi), and email limits. Plans, payments and coupons live in reem.bi (login.reembir.com).
// Calls into it run one at a time, so quota checks cannot race.
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY, name TEXT, first_seen INTEGER, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, ts INTEGER,
        model TEXT, seconds REAL, credits REAL
      );
      CREATE INDEX IF NOT EXISTS usage_email_ts ON usage(email, ts);
      CREATE TABLE IF NOT EXISTS emails (email TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, usd REAL, ts INTEGER);
      CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    `);
    // usage.pack_credits: the part of a row paid from packs instead of the monthly quota.
    const cols = this.sql.exec('PRAGMA table_info(usage)').toArray().map(c => c.name);
    if (!cols.includes('pack_credits')) this.sql.exec('ALTER TABLE usage ADD COLUMN pack_credits REAL NOT NULL DEFAULT 0');
  }

  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0] || null;
  }

  touchUser(email, name) {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO users (email, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      email, name || '', now, now);
  }

  // Monthly quota used (without what was paid from packs).
  usedSince(email, since) {
    return this.one('SELECT COALESCE(SUM(credits - pack_credits), 0) AS used FROM usage WHERE email = ? AND ts >= ?', email, since).used;
  }

  // Pack minutes left: `bought` (the total from reem.bi) minus what was used here.
  packBalance(email, bought) {
    const spent = this.one('SELECT COALESCE(SUM(pack_credits), 0) AS n FROM usage WHERE email = ?', email).n;
    return Math.max(0, bought - spent);
  }

  // Atomically checks the quota and records the usage: from the monthly quota first, the
  // rest from packs (packsBought = 0 when the plan can't use them). Returns the row id to
  // release() if the transcription then fails, which gives back both parts.
  reserve(email, since, limit, model, seconds, credits, packsBought = 0) {
    const used = this.usedSince(email, since);
    const fromPlan = Math.min(credits, Math.max(0, limit - used));
    let fromPacks = credits - fromPlan;
    if (fromPacks < 1e-9) fromPacks = 0;
    const balance = packsBought > 0 ? this.packBalance(email, packsBought) : 0;
    if (fromPacks > balance + 1e-9) return { ok: false, used, packs: balance };
    this.sql.exec('INSERT INTO usage (email, ts, model, seconds, credits, pack_credits) VALUES (?, ?, ?, ?, ?, ?)',
      email, Date.now(), model, seconds, credits, fromPacks);
    const id = this.one('SELECT last_insert_rowid() AS id').id;
    return { ok: true, id, used: used + fromPlan, packs: Math.max(0, balance - fromPacks) };
  }


  release(id) {
    this.sql.exec('DELETE FROM usage WHERE id = ?', id);
  }

  // Returns false when the user already sent `max` emails in the last 24 hours.
  allowEmail(email, max) {
    const dayAgo = Date.now() - 86400000;
    this.sql.exec('DELETE FROM emails WHERE ts < ?', dayAgo);
    const n = this.one('SELECT COUNT(*) AS n FROM emails WHERE email = ?', email).n;
    if (n >= max) return false;
    this.sql.exec('INSERT INTO emails (email, ts) VALUES (?, ?)', email, Date.now());
    return true;
  }

  // ---------- for the reem.bi dashboard (admin.js) ----------

  // Minutes of audio per model since `from` (and before `to`), e.g. { fast: 12.5, strong: 3 }.
  minutesByModel(from, to = 8.64e15) {
    const out = { fast: 0, strong: 0 };
    for (const r of this.sql.exec('SELECT model, SUM(seconds) AS s FROM usage WHERE ts >= ? AND ts < ? GROUP BY model', from, to).toArray()) {
      if (r.model in out) out[r.model] = (r.s || 0) / 60;
    }
    return out;
  }

  adminData({ month, from30, day, readingTs, readingDayEnd }) {
    return {
      users: this.one('SELECT COUNT(*) AS n FROM users').n,
      newUsers: this.one('SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?', month).n,
      activeUsers: this.one('SELECT COUNT(DISTINCT email) AS n FROM usage WHERE ts >= ?', month).n,
      monthChunks: this.one('SELECT COUNT(*) AS n FROM usage WHERE ts >= ?', month).n,
      monthMinutes: this.minutesByModel(month),
      packMinutes: this.one('SELECT COALESCE(SUM(pack_credits), 0) AS n FROM usage WHERE ts >= ?', month).n,
      emails24: this.one('SELECT COUNT(*) AS n FROM emails WHERE ts >= ?', day).n,
      daily: this.sql.exec(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, model, SUM(seconds) AS seconds
         FROM usage WHERE ts >= ? GROUP BY day, model`, from30 - 86400000).toArray(),
      topUsers: this.sql.exec(
        `SELECT email, SUM(seconds) AS seconds, SUM(credits) AS credits FROM usage WHERE ts >= ?
         GROUP BY email ORDER BY credits DESC LIMIT 10`, month).toArray(),
      sinceReading: readingTs ? this.minutesByModel(readingTs) : null,
      readingDayRest: readingTs ? this.minutesByModel(readingTs, readingDayEnd) : null,
    };
  }

  // The OpenAI balance as the admin typed it ('balance') and top-ups after it ('topup'), newest first.
  ledger() {
    return this.sql.exec('SELECT kind, usd, ts FROM ledger ORDER BY ts DESC, id DESC LIMIT 50').toArray();
  }
  addLedger(kind, usd) {
    this.sql.exec('INSERT INTO ledger (kind, usd, ts) VALUES (?, ?, ?)', kind, usd, Date.now());
  }
  hasBalance() {
    return !!this.one("SELECT 1 AS x FROM ledger WHERE kind = 'balance'");
  }

  cacheGet(k, maxAgeMs) {
    const r = this.one('SELECT v, ts FROM cache WHERE k = ?', k);
    return r && Date.now() - r.ts < maxAgeMs ? JSON.parse(r.v) : null;
  }
  cachePut(k, v) {
    this.sql.exec('INSERT INTO cache (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts', k, JSON.stringify(v), Date.now());
  }

  stats(monthStart) {
    return {
      users: this.one('SELECT COUNT(*) AS n FROM users').n,
      activeUsers: this.one('SELECT COUNT(DISTINCT email) AS n FROM usage WHERE ts >= ?', monthStart).n,
      usage: this.sql.exec(
        `SELECT model, COUNT(*) AS chunks, SUM(seconds) AS seconds FROM usage WHERE ts >= ? GROUP BY model`,
        monthStart).toArray(),
      topUsers: this.sql.exec(
        `SELECT email, SUM(seconds) AS seconds, SUM(credits) AS credits FROM usage WHERE ts >= ?
         GROUP BY email ORDER BY credits DESC LIMIT 20`, monthStart).toArray(),
      packMinutes: this.one('SELECT COALESCE(SUM(pack_credits), 0) AS n FROM usage WHERE ts >= ?', monthStart).n,
    };
  }
}
