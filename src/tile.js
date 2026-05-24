'use strict';

const { VectorTile } = require('@mapbox/vector-tile');
const Pbf = require('pbf');
const vtpbf = require('vt-pbf');
const { gunzipSync, gzipSync } = require('node:zlib');

/**
 * Merge edits into a raw MVT buffer.
 * Applies to all layers that carry osm_id/osm_type properties.
 * @param {Buffer} tileBuffer - raw tile data (possibly gzipped)
 * @param {Map} editsMap - Map keyed by "osm_type:osm_id" → {action, tags}
 * @returns {Buffer} gzipped MVT
 */
function mergeTile(tileBuffer, editsMap) {
  let data = tileBuffer;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    data = gunzipSync(data);
  }

  const tile = new VectorTile(new Pbf(data));
  const modifiedLayers = {};

  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    const features = [];

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties;
      const osmId = props.osm_id;
      const osmType = props.osm_type || 'way';
      const key = `${osmType}:${osmId}`;
      const edit = osmId != null ? editsMap.get(key) : undefined;

      if (edit && edit.action === 'delete') continue;

      const mergedProps = (edit && edit.action === 'upsert_tags')
        ? { ...props, ...edit.tags }
        : { ...props };

      // Capture geometry reference before loop iteration advances
      const captured = feature;
      features.push({
        id: feature.id,
        type: feature.type,
        properties: mergedProps,
        loadGeometry: () => captured.loadGeometry(),
      });
    }

    modifiedLayers[name] = {
      name,
      version: layer.version,
      extent: layer.extent,
      length: features.length,
      feature: (i) => features[i],
    };
  }

  const encoded = vtpbf({ layers: modifiedLayers });
  return gzipSync(encoded);
}

module.exports = { mergeTile };
