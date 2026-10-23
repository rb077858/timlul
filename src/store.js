import { DurableObject } from 'cloudflare:workers';

// One SQLite-backed Durable Object instance ("main") holds the site's own data: who used how
// many minutes, and email limits. Plans, payments and coupons live in reem.bi (login.reembir.com).
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
    `);
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

  usedSince(email, since) {
    return this.one('SELECT COALESCE(SUM(credits), 0) AS used FROM usage WHERE email = ? AND ts >= ?', email, since).used;
  }

  // Atomically checks the quota and records the usage. Returns the row id to
  // release() if the transcription then fails.
  reserve(email, since, limit, model, seconds, credits) {
    const used = this.usedSince(email, since);
    if (used + credits > limit + 1e-9) return { ok: false, used };
    this.sql.exec('INSERT INTO usage (email, ts, model, seconds, credits) VALUES (?, ?, ?, ?, ?)',
      email, Date.now(), model, seconds, credits);
    const id = this.one('SELECT last_insert_rowid() AS id').id;
    return { ok: true, id, used: used + credits };
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
    };
  }
}
