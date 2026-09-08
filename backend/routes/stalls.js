const express = require("express");
const store = require("../models/store");

const router = express.Router();

// GET /api/stalls  -> current status of every parking space (FR-05).
// The frontend should poll this every few seconds, or you can upgrade
// this route to a WebSocket push to satisfy the "updates automatically"
// requirement (FR-08) and the 5-second freshness target (NFR-01).
router.get("/", (req, res) => {
  res.json(store.stalls);
});

// GET /api/stalls/summary -> totals for the summary bar (FR-07).
router.get("/summary", (req, res) => {
  const summary = store.stalls.reduce(
    (acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1;
      return acc;
    },
    { vacant: 0, occupied: 0, blocked: 0 }
  );
  res.json(summary);
});

// PUT /api/stalls/:id  { status, confidence }
// Called by the CV/ML service (not a person) each time it re-classifies
// a space (FR-04). Kept separate from person-facing auth since this is
// a machine-to-machine call — protect it with a service token in
// production rather than the personnel JWT.
router.put("/:id", (req, res) => {
  const stall = store.stalls.find((s) => s.id === req.params.id);
  if (!stall) return res.status(404).json({ error: "Unknown parking space." });

  const { status, confidence } = req.body || {};
  if (!["vacant", "occupied", "blocked"].includes(status)) {
    return res.status(400).json({ error: "status must be vacant, occupied, or blocked." });
  }

  stall.status = status;
  stall.confidence = confidence ?? null;
  stall.updatedAt = new Date().toISOString();
  res.json(stall);
});

module.exports = router;
