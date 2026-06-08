const { getDb } = require('../db/database');

const INSERT_SQL = `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, detail, ip_address, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function log({ userId, userEmail, action, targetType, targetId, detail, ip, userAgent }) {
  const db = getDb();
  db.prepare(INSERT_SQL).run(
    userId || null,
    userEmail || '',
    action,
    targetType || '',
    String(targetId || ''),
    typeof detail === 'object' ? JSON.stringify(detail) : (detail || '{}'),
    ip || '',
    userAgent || ''
  );
}

function query({ userId, action, from, to, limit = 100, offset = 0 }) {
  const db = getDb();
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];

  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (from) { sql += ' AND timestamp >= ?'; params.push(from); }
  if (to) { sql += ' AND timestamp <= ?'; params.push(to); }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);

  let countSql = 'SELECT COUNT(*) as total FROM audit_logs WHERE 1=1';
  const countParams = [];
  if (userId) { countSql += ' AND user_id = ?'; countParams.push(userId); }
  if (action) { countSql += ' AND action = ?'; countParams.push(action); }
  if (from) { countSql += ' AND timestamp >= ?'; countParams.push(from); }
  if (to) { countSql += ' AND timestamp <= ?'; countParams.push(to); }

  const { total } = db.prepare(countSql).get(...countParams);

  return { rows, total };
}

function getActions() {
  const db = getDb();
  return db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map(r => r.action);
}

module.exports = { log, query, getActions };
