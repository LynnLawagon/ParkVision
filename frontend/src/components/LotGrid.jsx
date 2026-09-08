import React from "react";
import Stall from "./Stall";
import { COLORS, FONTS } from "../styles/tokens";
import { ZONES } from "../data/mockData";

export default function LotGrid({ stalls, dark, onSelect, activeZone }) {
  const zones = activeZone === "all" ? ZONES : [activeZone];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {zones.map((zone) => (
        <div key={zone}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
              color: dark ? "#8A9099" : COLORS.inkSoft,
              fontSize: 13,
            }}
          >
            <span style={{ fontFamily: FONTS.display, fontWeight: 600, color: dark ? "#fff" : COLORS.ink }}>
              Zone {zone}
            </span>
            <span
              style={{
                flex: 1,
                height: 1,
                backgroundImage: `repeating-linear-gradient(to right, ${dark ? "#4A5058" : "#C9C4B4"} 0 8px, transparent 8px 14px)`,
              }}
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {stalls.filter((s) => s.zone === zone).map((s) => (
              <Stall key={s.id} s={s} dark={dark} onClick={onSelect} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
