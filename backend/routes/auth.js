const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const store = require("../models/store");
const { JWT_SECRET } = require("../middleware/requireAuth");

const router = express.Router();

// POST /api/auth/login  { username, password } -> { token }
// SR-01: only an authenticated Parking Administrator may open settings.
// SR-03: the stored password is a bcrypt hash, never plain text.
router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find((u) => u.username === username);

  const isValid = user && bcrypt.compareSync(password || "", user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, username: user.username, role: user.role });
});

module.exports = router;
