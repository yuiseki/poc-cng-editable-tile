'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS edit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source_imagery_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS current_feature_edits (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source_imagery_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS idx_current_feature_edits_osm
ON current_feature_edits (osm_type, osm_id);
`;

function openEditsDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.pragma('synchronous=NORMAL');
  db.pragma('busy_timeout=5000');
  db.pragma('foreign_keys=ON');
  db.exec(SCHEMA);
  return db;
}

function getAllCurrentEdits(db) {
  const rows = db.prepare('SELECT osm_type, osm_id, action, tags_json FROM current_feature_edits').all();
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.osm_type}:${row.osm_id}`, {
      action: row.action,
      tags: JSON.parse(row.tags_json),
    });
  }
  return map;
}

function getFeatureEdit(db, osmType, osmId) {
  return db.prepare(
    'SELECT osm_type, osm_id, action, tags_json, source_imagery_id, updated_at, version FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  ).get(osmType, osmId);
}

function buildApplyEdit(db) {
  const insertEvent = db.prepare(`
    INSERT INTO edit_events (osm_type, osm_id, action, tags_json, source_imagery_id, user_id)
    VALUES (@osm_type, @osm_id, @action, @tags_json, @source_imagery_id, @user_id)
  `);

  const upsertCurrent = db.prepare(`
    INSERT INTO current_feature_edits (osm_type, osm_id, action, tags_json, source_imagery_id, updated_at, version)
    VALUES (@osm_type, @osm_id, @action, @tags_json, @source_imagery_id, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(osm_type, osm_id) DO UPDATE SET
      action = excluded.action,
      tags_json = excluded.tags_json,
      source_imagery_id = excluded.source_imagery_id,
      updated_at = CURRENT_TIMESTAMP,
      version = current_feature_edits.version + 1
  `);

  const deleteCurrent = db.prepare(
    'DELETE FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  );

  return db.transaction((params) => {
    const eventRow = {
      osm_type: params.osm_type,
      osm_id: params.osm_id,
      action: params.action,
      tags_json: JSON.stringify(params.tags || {}),
      source_imagery_id: params.source_imagery_id || null,
      user_id: params.user_id || null,
    };
    insertEvent.run(eventRow);

    if (params.action === 'restore') {
      deleteCurrent.run(params.osm_type, params.osm_id);
    } else {
      upsertCurrent.run({
        osm_type: params.osm_type,
        osm_id: params.osm_id,
        action: params.action,
        tags_json: JSON.stringify(params.tags || {}),
        source_imagery_id: params.source_imagery_id || null,
      });
    }
  });
}

module.exports = { openEditsDb, getAllCurrentEdits, getFeatureEdit, buildApplyEdit };
