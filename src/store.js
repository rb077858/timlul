import { DurableObject } from 'cloudflare:workers';

// One SQLite-backed Durable Object instance ("main") holds the site's own data: who used how
// many minutes, extra-minute packs bought, and email limits. Plans, payments and coupons live in reem.bi (login.reembir.com).
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
      CREATE TABLE IF NOT EXISTS packs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, order_id TEXT UNIQUE,
        pack TEXT, credits REAL, price REAL, currency TEXT, ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS packs_email ON packs(email);
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

  // Pack minutes bought and not used yet.
  packBalance(email) {
    const bought = this.one('SELECT COALESCE(SUM(credits), 0) AS n FROM packs WHERE email = ?', email).n;
    const spent = this.one('SELECT COALESCE(SUM(pack_credits), 0) AS n FROM usage WHERE email = ?', email).n;
    return Math.max(0, bought - spent);
  }

  // Atomically checks the quota and records the usage: from the monthly quota first, the
  // rest from packs (only when usePacks). Returns the row id to release() if the
  // transcription then fails, which gives back both parts.
  reserve(email, since, limit, model, seconds, credits, usePacks = false) {
    const used = this.usedSince(email, since);
    const fromPlan = Math.min(credits, Math.max(0, limit - used));
    let fromPacks = credits - fromPlan;
    if (fromPacks < 1e-9) fromPacks = 0;
    const balance = usePacks ? this.packBalance(email) : 0;
    if (fromPacks > balance + 1e-9) return { ok: false, used, packs: balance };
    this.sql.exec('INSERT INTO usage (email, ts, model, seconds, credits, pack_credits) VALUES (?, ?, ?, ?, ?, ?)',
      email, Date.now(), model, seconds, credits, fromPacks);
    const id = this.one('SELECT last_insert_rowid() AS id').id;
    return { ok: true, id, used: used + fromPlan, packs: Math.max(0, balance - fromPacks) };
  }

  // Records a paid pack once per PayPal order. Returns false if this order was already added.
  addPack(email, orderId, pack, credits, price, currency) {
    if (this.one('SELECT id FROM packs WHERE order_id = ?', orderId)) return false;
    this.sql.exec('INSERT INTO packs (email, order_id, pack, credits, price, currency, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      email, orderId, pack, credits, price, currency, Date.now());
    return true;
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
      packs: this.one('SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS revenue FROM packs WHERE ts >= ?', monthStart),
    };
  }
}
