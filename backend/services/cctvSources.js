const fs = require('node:fs');
const path = require('node:path');
const { UUID } = require('../validation');

function loadSources(filename) {
  if (!fs.existsSync(filename)) return [];
  let entries;
  try { entries = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('CCTV configuration is not valid JSON. Check the server-only source file.'); }
  if (!Array.isArray(entries) || entries.length > 16) throw new Error('CCTV configuration must be an array with at most 16 cameras.');
  const ids = new Set();
  return entries.map((entry, index) => {
    const invalid = () => new Error(`CCTV entry ${index + 1} needs a unique camera UUID, type rtsp/file, a valid source, and boolean options.`);
    if (!entry || !UUID.test(entry.cameraId || '') || ids.has(entry.cameraId) || !['rtsp', 'file'].includes(entry.type)
      || typeof entry.source !== 'string' || !entry.source.trim() || entry.source.includes('\0')
      || ['autoStart', 'publish'].some(key => entry[key] !== undefined && typeof entry[key] !== 'boolean')) throw invalid();
    ids.add(entry.cameraId);
    let source = entry.source;
    if (entry.type === 'rtsp') {
      let url;
      try { url = new URL(source); } catch { throw invalid(); }
      if (url.protocol !== 'rtsp:' || !url.hostname) throw invalid();
    } else {
      source = path.resolve(path.dirname(filename), source);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`CCTV replay file for entry ${index + 1} does not exist.`);
    }
    return { cameraId: entry.cameraId, type: entry.type, source, autoStart: entry.autoStart === true, publish: entry.publish === true };
  });
}
module.exports = { loadSources };
