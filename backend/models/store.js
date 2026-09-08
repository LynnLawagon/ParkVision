// DRAFT in-memory store — swap this for a real database (e.g. Postgres,
// MongoDB) once the schema is settled. Kept here as a single module so
// every route reads/writes through the same object.

const bcrypt = require("bcryptjs");

const store = {
  // FR-04: each stall's current classification.
  // status: "vacant" | "occupied" | "blocked"
  stalls: [
    { id: "A1", zone: "A", status: "vacant", confidence: null, updatedAt: new Date().toISOString() },
    { id: "A2", zone: "A", status: "occupied", confidence: 0.97, updatedAt: new Date().toISOString() },
    { id: "A3", zone: "A", status: "blocked", confidence: 0.89, updatedAt: new Date().toISOString() },
    { id: "B1", zone: "B", status: "occupied", confidence: 0.95, updatedAt: new Date().toISOString() },
    { id: "B2", zone: "B", status: "vacant", confidence: null, updatedAt: new Date().toISOString() },
  ],

  // FR-10 / SR-06: parking-space regions mapped onto a camera frame.
  // Each region tells the detection pipeline where to look, and which
  // stall id/zone that area of the frame corresponds to.
  regions: [
    { id: "A1", zone: "A", cameraId: "CAM-04", x: 40, y: 30, w: 70, h: 100 },
    { id: "A2", zone: "A", cameraId: "CAM-04", x: 120, y: 30, w: 70, h: 100 },
  ],

  // SR-01: only Parking Administrators can reach admin-only routes.
  // Passwords are hashed — never store them in plain text (SR-03).
  users: [
    {
      username: "j.cruz",
      passwordHash: bcrypt.hashSync("change-me", 10),
      role: "parking_administrator",
    },
  ],

  // SR-06: audit trail of region changes (who changed what, and when).
  regionChangeLog: [],
};

module.exports = store;
