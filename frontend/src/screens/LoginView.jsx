import React, { useState } from "react";
import { User, Lock } from "lucide-react";
import { COLORS, FONTS } from "../styles/tokens";

// onSignIn(username, password) should call POST /api/auth/login on the
// real backend (see backend/routes/auth.js) and store the returned token.
export default function LoginView({ onSignIn }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");

  function handleSubmit() {
    if (!user || !pass) {
      setError("Enter a username and password.");
      return;
    }
    setError("");
    onSignIn(user, pass);
  }

  return (
    <div style={{ background: COLORS.asphalt, minHeight: 600, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.body, padding: 20 }}>
      <div style={{ width: 340, background: COLORS.asphaltCard, borderRadius: 14, padding: 32, border: `1px solid ${COLORS.asphaltLine}` }}>
        <div style={{ fontFamily: FONTS.display, fontSize: 22, fontWeight: 700, color: "#fff" }}>ParkVision</div>
        <div style={{ fontSize: 13, color: "#8A9099", marginTop: 4, marginBottom: 26 }}>Personnel sign-in — Luzano Compound</div>

        <label style={{ fontSize: 12, color: "#A9AEB4" }}>Username</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: COLORS.asphalt, border: `1px solid ${COLORS.asphaltLine}`, borderRadius: 8, padding: "10px 12px", marginTop: 6, marginBottom: 16 }}>
          <User size={15} color="#8A9099" />
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="j.cruz" style={{ background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: 14, width: "100%" }} />
        </div>

        <label style={{ fontSize: 12, color: "#A9AEB4" }}>Password</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: COLORS.asphalt, border: `1px solid ${COLORS.asphaltLine}`, borderRadius: 8, padding: "10px 12px", marginTop: 6, marginBottom: 10 }}>
          <Lock size={15} color="#8A9099" />
          <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" placeholder="••••••••" style={{ background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: 14, width: "100%" }} />
        </div>

        {error && <div style={{ color: COLORS.blocked, fontSize: 12, marginBottom: 14 }}>{error}</div>}

        <button
          onClick={handleSubmit}
          style={{ width: "100%", padding: "11px 0", borderRadius: 8, border: "none", background: COLORS.paint, color: COLORS.asphalt, fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: error ? 0 : 14 }}
        >
          Sign in
        </button>
        <div style={{ fontSize: 12, color: "#6B7178", marginTop: 16, textAlign: "center" }}>Authorized parking personnel only.</div>
      </div>
    </div>
  );
}
