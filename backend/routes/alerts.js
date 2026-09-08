const express = require("express");
const store = require("../models/store");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

// GET /api/alerts -> stalls currently blocked by a non-vehicle object
// (FR-06). Personnel-only, since this feeds the admin dashboard's
// alert panel.
router.get("/", requireAuth, (req, res) => {
  const alerts = store.stalls
    .filter((s) => s.status === "blocked")
    .map((s) => ({ ...s, acknowledged: !!s.acknowledged }));
  res.json(alerts);
});

// POST /api/alerts/:id/acknowledge -> personnel confirms they've seen
// the warning. Doesn't change the underlying stall status — that only
// changes when the CV service reports a new classification.
router.post("/:id/acknowledge", requireAuth, (req, res) => {
  const stall = store.stalls.find((s) => s.id === req.params.id);
  if (!stall) return res.status(404).json({ error: "Unknown parking space." });

  stall.acknowledged = true;
  stall.acknowledgedBy = req.user.username;
  stall.acknowledgedAt = new Date().toISOString();
  res.json(stall);
});

module.exports = router;
