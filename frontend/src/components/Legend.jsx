import React from "react";
import { COLORS } from "../styles/tokens";

export default function Legend({ dark }) {
  const items = [
    { c: COLORS.vacant, l: "Vacant" },
    { c: COLORS.occupied, l: "Occupied by vehicle" },
    { c: COLORS.blocked, l: "Non-vehicle obstruction" },
  ];
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
      {items.map((it) => (
        <span
          key={it.l}
          style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: dark ? "#A9AEB4" : COLORS.inkSoft }}
        >
          <span style={{ width: 12, height: 12, borderRadius: 3, background: it.c }} />
          {it.l}
        </span>
      ))}
    </div>
  );
}
