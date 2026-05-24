'use strict';

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { openEditsDb, getAllCurrentEdits, getFeatureEdit, buildApplyEdit } = require('./db');
const { openMbtiles, getTile } = require('./mbtiles');
const { mergeTile } = require('./tile');

const BASE_MBTILES_PATH = process.env.BASE_MBTILES_PATH || '/data/base.mbtiles';
const EDITS_SQLITE_PATH = process.env.EDITS_SQLITE_PATH || '/data/edits.sqlite';
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const VALID_ACTIONS = new Set(['upsert_tags', 'delete', 'restore']);

function buildApp({ mbtilesPath, editsPath } = {}) {
  const editsDb = openEditsDb(editsPath || EDITS_SQLITE_PATH);
  const applyEdit = buildApplyEdit(editsDb);

  let mbtilesDb = null;
  try {
    mbtilesDb = openMbtiles(mbtilesPath || BASE_MBTILES_PATH);
  } catch {
    // base.mbtiles may not exist at startup (e.g. in tests or before data is mounted)
  }

  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/tiles/:z/:x/:y', async (req, reply) => {
    if (!mbtilesDb) {
      try {
        mbtilesDb = openMbtiles(mbtilesPath || BASE_MBTILES_PATH);
      } catch {
        return reply.code(503).send({ error: 'base.mbtiles not available' });
      }
    }

    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    // strip optional .mvt extension from y
    const y = parseInt(req.params.y, 10);

    const rawTile = getTile(mbtilesDb, z, x, y);
    if (!rawTile) return reply.code(404).send({ error: 'tile not found' });

    const editsMap = getAllCurrentEdits(editsDb);
    const merged = mergeTile(rawTile, editsMap);

    reply
      .header('Content-Type', 'application/vnd.mapbox-vector-tile')
      .header('Content-Encoding', 'gzip')
      .header('Cache-Control', 'no-cache')
      .send(merged);
  });

  app.post('/edit', {
    schema: {
      body: {
        type: 'object',
        required: ['osm_type', 'osm_id', 'action'],
        properties: {
          osm_type: { type: 'string' },
          osm_id: { type: 'integer' },
          action: { type: 'string', enum: ['upsert_tags', 'delete', 'restore'] },
          tags: { type: 'object', additionalProperties: { type: 'string' } },
          source_imagery_id: { type: 'string' },
          user_id: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { osm_type, osm_id, action, tags, source_imagery_id, user_id } = req.body;

    if (!VALID_ACTIONS.has(action)) {
      return reply.code(400).send({ error: `invalid action: ${action}` });
    }

    applyEdit({ osm_type, osm_id, action, tags: tags || {}, source_imagery_id, user_id });

    reply.code(200).send({ ok: true, osm_type, osm_id, action });
  });

  app.get('/edits/:osm_type/:osm_id', async (req, reply) => {
    const { osm_type, osm_id } = req.params;
    const row = getFeatureEdit(editsDb, osm_type, parseInt(osm_id, 10));
    if (!row) return reply.code(404).send({ error: 'not found' });
    return {
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      action: row.action,
      tags: JSON.parse(row.tags_json),
      source_imagery_id: row.source_imagery_id,
      updated_at: row.updated_at,
      version: row.version,
    };
  });

  return { app, editsDb };
}

if (require.main === module) {
  const { app } = buildApp();
  app.listen({ port: PORT, host: HOST }, (err) => {
    if (err) { app.log.error(err); process.exit(1); }
  });
}

module.exports = { buildApp };
