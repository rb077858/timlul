import { DurableObject } from 'cloudflare:workers';

// One SQLite-backed Durable Object instance ("main") holds all the data.
// Calls into it run one at a time, so quota checks cannot race.
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY, name TEXT, first_seen INTEGER, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS subs (
        email TEXT PRIMARY KEY, sub_id TEXT, plan_key TEXT, status TEXT,
        period_start INTEGER, paid_until INTEGER, checked_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, ts INTEGER,
        model TEXT, seconds REAL, credits REAL
      );
      CREATE INDEX IF NOT EXISTS usage_email_ts ON usage(email, ts);
      CREATE TABLE IF NOT EXISTS emails (email TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS plan_map (paypal_plan_id TEXT PRIMARY KEY, plan_key TEXT);
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

  getSub(email) {
    return this.one('SELECT * FROM subs WHERE email = ?', email);
  }

  saveSub(s) {
    this.sql.exec(
      `INSERT INTO subs (email, sub_id, plan_key, status, period_start, paid_until, checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET sub_id = excluded.sub_id, plan_key = excluded.plan_key,
         status = excluded.status, period_start = excluded.period_start, paid_until = excluded.paid_until,
         checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
      s.email, s.sub_id, s.plan_key, s.status, s.period_start ?? null, s.paid_until ?? null,
      Date.now(), Date.now());
    return this.getSub(s.email);
  }

  findSubOwner(subId) {
    return this.one('SELECT email FROM subs WHERE sub_id = ?', subId)?.email || null;
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

  getSetting(key) {
    const row = this.one('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : null;
  }

  setSetting(key, value) {
    this.sql.exec(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value));
  }

  mapPlan(paypalPlanId, planKey) {
    this.sql.exec(
      'INSERT INTO plan_map (paypal_plan_id, plan_key) VALUES (?, ?) ON CONFLICT(paypal_plan_id) DO UPDATE SET plan_key = excluded.plan_key',
      paypalPlanId, planKey);
  }

  planKeyFor(paypalPlanId) {
    return this.one('SELECT plan_key FROM plan_map WHERE paypal_plan_id = ?', paypalPlanId)?.plan_key || null;
  }

  stats(monthStart) {
    return {
      users: this.one('SELECT COUNT(*) AS n FROM users').n,
      activeUsers: this.one('SELECT COUNT(DISTINCT email) AS n FROM usage WHERE ts >= ?', monthStart).n,
      subs: this.sql.exec(
        `SELECT plan_key, status, COUNT(*) AS n FROM subs GROUP BY plan_key, status ORDER BY plan_key`).toArray(),
      usage: this.sql.exec(
        `SELECT model, COUNT(*) AS chunks, SUM(seconds) AS seconds FROM usage WHERE ts >= ? GROUP BY model`,
        monthStart).toArray(),
      recentSubs: this.sql.exec(
        `SELECT email, plan_key, status, paid_until, updated_at FROM subs ORDER BY updated_at DESC LIMIT 50`).toArray(),
    };
  }
}
