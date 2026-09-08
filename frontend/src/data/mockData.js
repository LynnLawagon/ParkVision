// Placeholder data so the frontend can be built and demoed before the
// real backend/CV pipeline exists. Replace seedStalls() with a fetch to
// GET /api/stalls once the backend is ready (see backend/routes/stalls.js).

export const ZONES = ["A", "B", "C"];
export const STATUS = { VACANT: "vacant", OCCUPIED: "occupied", BLOCKED: "blocked" };

export function seedStalls() {
  let stalls = [];
  let counter = 1;
  ZONES.forEach((zone, zi) => {
    const count = zi === 0 ? 18 : zi === 1 ? 16 : 14;
    for (let i = 1; i <= count; i++) {
      const r = Math.random();
      let status = STATUS.OCCUPIED;
      if (r < 0.32) status = STATUS.VACANT;
      else if (r > 0.95) status = STATUS.BLOCKED;
      stalls.push({
        id: `${zone}${i}`,
        zone,
        status,
        confidence: status === STATUS.BLOCKED ? 82 + Math.round(Math.random() * 15) : null,
        updated: `${Math.round(Math.random() * 50) + 3}s ago`,
        n: counter++,
      });
    }
  });
  return stalls;
}

export const TREND = [
  { t: "6a", occ: 12 }, { t: "8a", occ: 34 }, { t: "10a", occ: 58 },
  { t: "12p", occ: 71 }, { t: "2p", occ: 68 }, { t: "4p", occ: 74 },
  { t: "6p", occ: 52 }, { t: "8p", occ: 31 },
];
