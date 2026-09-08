import React, { useState, useMemo } from "react";
import { LayoutGrid, Settings, LogOut, TriangleAlert } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import SummaryBar from "../components/SummaryBar";
import Legend from "../components/Legend";
import LotGrid from "../components/LotGrid";
import RegionsTab from "./RegionsTab";
import { COLORS, FONTS } from "../styles/tokens";
import { ZONES, STATUS, TREND } from "../data/mockData";

// Replace `stalls` with data from GET /api/stalls (polled every few
// seconds, or pushed over a socket) and `alerts` with GET /api/alerts
// once the backend is wired up.
export default function AdminView({ stalls, onSignOut }) {
  const [tab, setTab] = useState("overview");
  const [zone, setZone] = useState("all");
  const alerts = useMemo(() => stalls.filter((s) => s.status === STATUS.BLOCKED), [stalls]);
  const [acked, setAcked] = useState({});

  return (
    <div style={{ background: COLORS.asphalt, minHeight: 640, fontFamily: FONTS.body, color: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 26px", borderBottom: `1px solid ${COLORS.asphaltLine}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 18 }}>
            ParkVision <span style={{ color: "#8A9099", fontWeight: 500 }}>· Personnel</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { id: "overview", label: "Overview", icon: LayoutGrid },
              { id: "regions", label: "Manage regions", icon: Settings },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  background: tab === t.id ? COLORS.asphaltCard : "transparent",
                  color: tab === t.id ? "#fff" : "#8A9099",
                }}
              >
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 13, color: "#A9AEB4" }}>J. Cruz — Parking Administrator</span>
          <button onClick={onSignOut} style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: "#8A9099", cursor: "pointer", fontSize: 13 }}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      {tab === "overview" ? (
        <div style={{ display: "flex", gap: 24, padding: 26, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SummaryBar stalls={stalls} dark={true} />

            <div style={{ background: COLORS.asphaltCard, borderRadius: 12, padding: 20, marginTop: 20, border: `1px solid ${COLORS.asphaltLine}` }}>
              <div style={{ fontSize: 13, color: "#8A9099", marginBottom: 10 }}>Occupancy today</div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={TREND} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={COLORS.asphaltLine} vertical={false} />
                  <XAxis dataKey="t" stroke="#8A9099" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#8A9099" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: COLORS.asphalt, border: `1px solid ${COLORS.asphaltLine}`, borderRadius: 8, fontSize: 12 }} />
                  <Line type="monotone" dataKey="occ" stroke={COLORS.paint} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "22px 0 14px" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {["all", ...ZONES].map((z) => (
                  <button
                    key={z}
                    onClick={() => setZone(z)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      padding: "6px 13px",
                      borderRadius: 20,
                      fontSize: 13,
                      background: zone === z ? "#fff" : "transparent",
                      color: zone === z ? COLORS.asphalt : "#8A9099",
                    }}
                  >
                    {z === "all" ? "All zones" : `Zone ${z}`}
                  </button>
                ))}
              </div>
              <Legend dark={true} />
            </div>
            <LotGrid stalls={stalls} dark={true} activeZone={zone} />
          </div>

          <div style={{ width: 300, flexShrink: 0, background: COLORS.asphaltCard, borderRadius: 12, border: `1px solid ${COLORS.asphaltLine}`, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <TriangleAlert size={16} color={COLORS.blocked} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>Obstruction alerts</span>
            </div>
            <div style={{ fontSize: 12, color: "#8A9099", marginBottom: 14 }}>Non-vehicle objects detected in a parking space</div>
            {alerts.length === 0 && <div style={{ fontSize: 13, color: "#8A9099" }}>No active alerts.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {alerts.map((a) => (
                <div key={a.id} style={{ background: COLORS.asphalt, borderRadius: 10, padding: 12, border: `1px solid ${acked[a.id] ? COLORS.asphaltLine : COLORS.blocked}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Space {a.id}</span>
                    <span style={{ color: "#8A9099" }}>{a.updated}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#A9AEB4", marginTop: 4 }}>Confidence {a.confidence}% · Zone {a.zone}</div>
                  <button
                    onClick={() => setAcked((p) => ({ ...p, [a.id]: true }))}
                    disabled={!!acked[a.id]}
                    style={{
                      marginTop: 10,
                      width: "100%",
                      padding: "7px 0",
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: acked[a.id] ? "default" : "pointer",
                      border: "none",
                      background: acked[a.id] ? "transparent" : COLORS.paint,
                      color: acked[a.id] ? "#6B9C6B" : COLORS.asphalt,
                      fontWeight: 600,
                    }}
                  >
                    {acked[a.id] ? "Acknowledged" : "Acknowledge"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <RegionsTab />
      )}
    </div>
  );
}
