export const OBSERVATION_TTL_MS = 10_000;
const knownStatuses = new Set(['vacant', 'occupied', 'blocked']);

export function isRecentFrame(capturedAt, now = Date.now()) {
  const time = Date.parse(capturedAt);
  return Number.isFinite(time) && time <= now + 1000 && now - time < OBSERVATION_TTL_MS;
}

export function effectiveStatus(space, now = Date.now()) {
  if (space.is_stale || !knownStatuses.has(space.status) || !isRecentFrame(space.observed_at, now)) return 'unknown';
  return space.status;
}

export const statusLabels = { vacant: 'Available', occupied: 'Occupied', blocked: 'Blocked', unknown: 'Unverified' };
