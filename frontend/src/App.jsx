import React, { useState, useMemo } from "react";
import { useFonts } from "./useFonts";
import { COLORS, FONTS } from "./styles/tokens";
import { seedStalls } from "./data/mockData";
import CustomerView from "./screens/CustomerView";
import LoginView from "./screens/LoginView";
import AdminView from "./screens/AdminView";

// This top bar is only here so the three screens can be clicked through
// in one preview. In the real app, CustomerView is its own public route,
// and LoginView/AdminView sit behind /personnel with an auth guard.
export default function App() {
  useFonts();
  const [screen, setScreen] = useState("customer");
  const stalls = useMemo(() => seedStalls(), []);

  const screens = [
    { id: "customer", label: "Customer view" },
    { id: "login", label: "Personnel sign-in" },
    { id: "admin", label: "Personnel dashboard" },
  ];

  return (
    <div style={{ fontFamily: FONTS.body }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: "#F5F4F0", borderBottom: "1px solid #DEDACC" }}>
        <span style={{ fontSize: 12, color: "#8A8578" }}>Prototype — pick a screen:</span>
        <div style={{ display: "flex", gap: 6 }}>
          {screens.map((s) => (
            <button
              key={s.id}
              onClick={() => setScreen(s.id)}
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                padding: "5px 11px",
                borderRadius: 6,
                background: screen === s.id ? COLORS.ink : "transparent",
                color: screen === s.id ? "#fff" : "#6B6F76",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {screen === "customer" && <CustomerView stalls={stalls} />}
      {screen === "login" && <LoginView onSignIn={() => setScreen("admin")} />}
      {screen === "admin" && <AdminView stalls={stalls} onSignOut={() => setScreen("login")} />}
    </div>
  );
}
