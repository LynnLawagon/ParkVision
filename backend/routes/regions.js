const express = require("express");
const store = require("../models/store");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

// All region routes require sign-in (SR-01) and, per SR-02, only the
// Parking Administrator role should reach them — add a role check here
// once more roles exist.
router.use(requireAuth);

// GET /api/regions -> current parking-space regions (FR-10).
router.get("/", (req, res) => {
  res.json(store.regions);
});

// POST /api/regions  { id, zone, cameraId, x, y, w, h }
// SR-05: reject invalid input before saving.
router.post("/", (req, res) => {
  const { id, zone, cameraId, x, y, w, h } = req.body || {};
  if (!id || !zone || !cameraId || [x, y, w, h].some((n) => typeof n !== "number")) {
    return res.status(400).json({ error: "id, zone, cameraId, x, y, w, h are all required." });
  }
  if (store.regions.some((r) => r.id === id)) {
    return res.status(409).json({ error: `Region ${id} already exists.` });
  }

  const region = { id, zone, cameraId, x, y, w, h };
  store.regions.push(region);
  logChange(req.user.username, "create", region);
  res.status(201).json(region);
});

// PATCH /api/regions/:id -> edit an existing region.
router.patch("/:id", (req, res) => {
  const region = store.regions.find((r) => r.id === req.params.id);
  if (!region) return res.status(404).json({ error: "Region not found." });

  Object.assign(region, req.body || {});
  logChange(req.user.username, "update", region);
  res.json(region);
});

// DELETE /api/regions/:id
router.delete("/:id", (req, res) => {
  const index = store.regions.findIndex((r) => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Region not found." });

  const [removed] = store.regions.splice(index, 1);
  logChange(req.user.username, "delete", removed);
  res.status(204).end();
});

// GET /api/regions/log -> audit trail (SR-06).
router.get("/log", (req, res) => {
  res.json(store.regionChangeLog);
});

function logChange(username, action, region) {
  store.regionChangeLog.push({
    username,
    action,
    region,
    at: new Date().toISOString(),
  });
}

module.exports = router;
