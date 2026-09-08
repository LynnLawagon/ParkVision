// DRAFT backend — enough structure to unblock frontend development.
// Not production-ready: swap the in-memory store for a real database,
// add role checks, rate limiting, and HTTPS before deploying.
//
// Endpoints map to the requirements doc as follows:
//   /api/auth      -> SR-01, SR-03            (personnel login)
//   /api/stalls    -> FR-04, FR-05, FR-07/08  (space status, live updates)
//   /api/alerts    -> FR-06                   (non-vehicle obstruction warnings)
//   /api/regions   -> FR-10, SR-02, SR-05/06  (parking-space configuration)
//
// FR-01/02/03 (receiving camera frames, detecting objects, classifying
// vehicle vs non-vehicle) belong to a separate CV/ML service — this API
// just exposes its results (via PUT /api/stalls/:id) to the frontend.

const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const stallRoutes = require("./routes/stalls");
const alertRoutes = require("./routes/alerts");
const regionRoutes = require("./routes/regions");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/stalls", stallRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/regions", regionRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`ParkVision backend (draft) listening on port ${PORT}`));
