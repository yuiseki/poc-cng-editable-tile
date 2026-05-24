'use strict';

const Database = require('better-sqlite3');

function openMbtiles(mbtilesPath) {
  const db = new Database(mbtilesPath, { readonly: true });
  return db;
}

function getTile(db, z, x, y) {
  // MBTiles uses TMS y (flipped): tms_y = (2^z - 1) - y
  const tmsY = (1 << z) - 1 - y;
  const row = db.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
  ).get(z, x, tmsY);
  return row ? row.tile_data : null;
}

module.exports = { openMbtiles, getTile };
