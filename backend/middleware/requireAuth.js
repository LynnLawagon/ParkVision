// DRAFT auth guard — protects everything under /api/admin/* (SR-01).
// Expects "Authorization: Bearer <token>" from the login response.

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Sign in required." });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid. Sign in again." });
  }
}

module.exports = { requireAuth, JWT_SECRET };
