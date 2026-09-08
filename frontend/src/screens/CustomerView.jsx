import React, { useState } from "react";
import SummaryBar from "../components/SummaryBar";
import Legend from "../components/Legend";
import LotGrid from "../components/LotGrid";
import { COLORS, FONTS } from "../styles/tokens";
import { ZONES, STATUS } from "../data/mockData";

export default function CustomerView({ stalls }) {
  const [zone, setZone] = useState("all");
  const [selected, setSelected] = useState(null);

  return (
    <div style={{ background: COLORS.surface, minHeight: 600, fontFamily: FONTS.body, color: COLORS.ink }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px 60px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: FONTS.display, fontSize: 24, fontWeight: 700 }}>ParkVision</div>
            <div style={{ fontSize: 13, color: COLORS.inkSoft, marginTop: 2 }}>Luzano Compound parking</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: COLORS.inkSoft }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.vacant, boxShadow: `0 0 0 4px ${COLORS.vacant}33` }} />
            Updated 6 seconds ago
          </div>
        </div>

        <SummaryBar stalls={stalls} dark={false} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "26px 0 16px" }}>
          <div style={{ display: "flex", gap: 8 }}>
            {["all", ...ZONES].map((z) => (
              <button
                key={z}
                onClick={() => setZone(z)}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "7px 14px",
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: FONTS.body,
                  background: zone === z ? COLORS.ink : "transparent",
                  color: zone === z ? "#fff" : COLORS.inkSoft,
                }}
              >
                {z === "all" ? "All zones" : `Zone ${z}`}
              </button>
            ))}
          </div>
          <Legend dark={false} />
        </div>

        <LotGrid stalls={stalls} dark={false} activeZone={zone} onSelect={setSelected} />

        {selected && (
          <div
            onClick={() => setSelected(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(30,33,36,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          >
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 24, width: 300 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontFamily: FONTS.display, fontSize: 20, fontWeight: 700 }}>Space {selected.id}</div>
              </div>
              <div style={{ fontSize: 13, color: COLORS.inkSoft, marginTop: 10 }}>
                Zone {selected.zone} · updated {selected.updated}
              </div>
              {selected.status === STATUS.BLOCKED && (
                <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "#FCEBE7", color: "#9C3A26", fontSize: 13 }}>
                  A non-vehicle object was detected in this space. Personnel have been notified.
                </div>
              )}
              <button
                onClick={() => setSelected(null)}
                style={{ marginTop: 16, width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: COLORS.ink, color: "#fff", fontSize: 13, cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
