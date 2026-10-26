const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateRegions(regions) {
  if (!Array.isArray(regions) || !regions.length || regions.length > 100) throw badRequest('Draw at least one parking region (maximum 100).');
  const seen = new Set();
  return regions.map(region => {
    if (!region || !UUID.test(region.id) || seen.has(region.id)) throw badRequest('Regions need unique UUIDs.');
    seen.add(region.id);
    const { x, y, width, height } = region;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.00000001 || y + height > 1.00000001) throw badRequest('Each region must be inside the image with positive dimensions.');
    return { id: region.id, x, y, width, height };
  });
}
function geometryMatches(left, right) {
  return left.id === right.id && ['x', 'y', 'width', 'height'].every(key => Math.abs(Number(left[key]) - Number(right[key])) < 0.000001);
}
module.exports = { UUID, badRequest, validateRegions, geometryMatches };
