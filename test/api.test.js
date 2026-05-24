'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const vtpbf = require('vt-pbf');
const { gzipSync } = require('node:zlib');

const { buildApp } = require('../src/index');

// ── helpers ────────────────────────────────────────────────────────────────

function makeTestTile(features) {
  const layer = {
    name: 'buildings',
    version: 2,
    extent: 4096,
    length: features.length,
    feature: (i) => features[i],
  };
  return gzipSync(vtpbf({ layers: { buildings: layer } }));
}

function makeFeature(osmId, extraProps = {}) {
  return {
    id: osmId,
    type: 3, // Polygon
    properties: { osm_id: osmId, osm_type: 'way', name: `building_${osmId}`, ...extraProps },
    loadGeometry: () => [[
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 },
    ]],
  };
}

function createTestMbtiles(tmpDir) {
  const mbPath = path.join(tmpDir, 'base.mbtiles');
  const db = new Database(mbPath);
  db.exec(`
    CREATE TABLE tiles (
      zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
    CREATE TABLE metadata (name TEXT, value TEXT);
    INSERT INTO metadata VALUES ('format', 'pbf');
  `);

  // z=14, x=14552, y=6451 → tms_y = (2^14 - 1) - 6451 = 16383 - 6451 = 9932
  const tmsY = (1 << 14) - 1 - 6451;
  const tileData = makeTestTile([makeFeature(111111), makeFeature(222222)]);
  db.prepare('INSERT INTO tiles VALUES (14, 14552, ?, ?)').run(tmsY, tileData);
  db.close();
  return mbPath;
}

// ── test setup ─────────────────────────────────────────────────────────────

let tmpDir, mbtilesPath, editsPath, app, editsDb;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-editable-tile-test-'));
  mbtilesPath = createTestMbtiles(tmpDir);
  editsPath = path.join(tmpDir, 'edits.sqlite');

  const built = buildApp({ mbtilesPath, editsPath });
  app = built.app;
  editsDb = built.editsDb;
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

test('GET /healthz returns ok:true', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('GET /tiles/:z/:x/:y returns 200 for existing tile', async () => {
  const res = await app.inject({ method: 'GET', url: '/tiles/14/14552/6451' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.mapbox-vector-tile');
});

test('GET /tiles/:z/:x/:y returns 404 for missing tile', async () => {
  const res = await app.inject({ method: 'GET', url: '/tiles/1/0/0' });
  assert.equal(res.statusCode, 404);
});

test('POST /edit upserts current_feature_edits', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/edit',
    payload: {
      osm_type: 'way',
      osm_id: 111111,
      action: 'upsert_tags',
      tags: { 'disaster:damage': 'major', 'disaster:confidence': '0.8' },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  const row = editsDb.prepare(
    'SELECT * FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  ).get('way', 111111);
  assert.ok(row);
  assert.equal(row.action, 'upsert_tags');
  const tags = JSON.parse(row.tags_json);
  assert.equal(tags['disaster:damage'], 'major');
});

test('POST /edit appends to edit_events (audit log)', async () => {
  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 333333, action: 'upsert_tags', tags: { foo: 'bar' } },
  });
  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 333333, action: 'upsert_tags', tags: { foo: 'baz' } },
  });

  const count = editsDb.prepare(
    'SELECT COUNT(*) as c FROM edit_events WHERE osm_type = ? AND osm_id = ?'
  ).get('way', 333333).c;
  assert.equal(count, 2);

  const cur = editsDb.prepare(
    'SELECT tags_json FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  ).get('way', 333333);
  assert.equal(JSON.parse(cur.tags_json).foo, 'baz');
});

test('restore removes edit from current_feature_edits', async () => {
  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 444444, action: 'upsert_tags', tags: { x: '1' } },
  });
  let row = editsDb.prepare(
    'SELECT * FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  ).get('way', 444444);
  assert.ok(row);

  const res = await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 444444, action: 'restore' },
  });
  assert.equal(res.statusCode, 200);

  row = editsDb.prepare(
    'SELECT * FROM current_feature_edits WHERE osm_type = ? AND osm_id = ?'
  ).get('way', 444444);
  assert.equal(row, undefined);
});

test('GET /edits/:osm_type/:osm_id returns edit', async () => {
  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 555555, action: 'upsert_tags', tags: { note: 'test' } },
  });

  const res = await app.inject({ method: 'GET', url: '/edits/way/555555' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.osm_id, 555555);
  assert.equal(body.tags.note, 'test');
});

test('GET /edits/:osm_type/:osm_id returns 404 when not found', async () => {
  const res = await app.inject({ method: 'GET', url: '/edits/way/9999999' });
  assert.equal(res.statusCode, 404);
});

test('delete action hides feature from tile response', async () => {
  const { VectorTile } = require('@mapbox/vector-tile');
  const Pbf = require('pbf');
  const { gunzipSync } = require('node:zlib');

  // Confirm feature 222222 is in the tile before delete
  const before = await app.inject({ method: 'GET', url: '/tiles/14/14552/6451' });
  const beforeTile = new VectorTile(new Pbf(gunzipSync(before.rawPayload)));
  const beforeIds = [];
  const beforeLayer = beforeTile.layers['buildings'];
  for (let i = 0; i < beforeLayer.length; i++) {
    beforeIds.push(beforeLayer.feature(i).properties.osm_id);
  }
  assert.ok(beforeIds.includes(222222));

  // Delete feature 222222
  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: { osm_type: 'way', osm_id: 222222, action: 'delete' },
  });

  const after = await app.inject({ method: 'GET', url: '/tiles/14/14552/6451' });
  const afterTile = new VectorTile(new Pbf(gunzipSync(after.rawPayload)));
  const afterIds = [];
  const afterLayer = afterTile.layers['buildings'];
  for (let i = 0; i < afterLayer.length; i++) {
    afterIds.push(afterLayer.feature(i).properties.osm_id);
  }
  assert.ok(!afterIds.includes(222222), 'deleted feature should be absent');
  assert.ok(afterIds.includes(111111), 'other features should remain');
});

test('upserted tags appear in tile response properties', async () => {
  const { VectorTile } = require('@mapbox/vector-tile');
  const Pbf = require('pbf');
  const { gunzipSync } = require('node:zlib');

  await app.inject({
    method: 'POST',
    url: '/edit',
    payload: {
      osm_type: 'way',
      osm_id: 111111,
      action: 'upsert_tags',
      tags: { 'disaster:damage': 'major', 'disaster:confidence': '0.9' },
    },
  });

  const res = await app.inject({ method: 'GET', url: '/tiles/14/14552/6451' });
  const tile = new VectorTile(new Pbf(gunzipSync(res.rawPayload)));
  const layer = tile.layers['buildings'];
  let found = null;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.properties.osm_id === 111111) { found = f.properties; break; }
  }
  assert.ok(found, 'feature 111111 should exist');
  assert.equal(found['disaster:damage'], 'major');
  assert.equal(found['disaster:confidence'], '0.9');
});

test('edits.sqlite auto-initializes when missing', () => {
  const freshPath = path.join(tmpDir, 'fresh-edits.sqlite');
  assert.ok(!fs.existsSync(freshPath));
  const { openEditsDb } = require('../src/db');
  const db = openEditsDb(freshPath);
  assert.ok(fs.existsSync(freshPath));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('edit_events'));
  assert.ok(tables.includes('current_feature_edits'));
  db.close();
});
