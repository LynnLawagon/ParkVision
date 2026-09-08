import React from "react";
import { COLORS, FONTS } from "../styles/tokens";
import { STATUS } from "../data/mockData";

export default function SummaryBar({ stalls, dark }) {
  const vacant = stalls.filter((s) => s.status === STATUS.VACANT).length;
  const occupied = stalls.filter((s) => s.status === STATUS.OCCUPIED).length;
  const blocked = stalls.filter((s) => s.status === STATUS.BLOCKED).length;
  const cells = [
    { n: vacant, l: "Vacant", c: COLORS.vacant },
    { n: occupied, l: "Occupied", c: COLORS.occupied },
    { n: blocked, l: "Blocked", c: COLORS.blocked },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 1,
        borderRadius: 10,
        overflow: "hidden",
        border: `1px solid ${dark ? COLORS.asphaltLine : COLORS.surfaceLine}`,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.l}
          style={{
            flex: 1,
            padding: "16px 18px",
            background: dark ? COLORS.asphaltCard : COLORS.surfaceCard,
            borderTop: `3px solid ${c.c}`,
          }}
        >
          <div style={{ fontFamily: FONTS.display, fontSize: 30, fontWeight: 700, color: dark ? "#fff" : COLORS.ink, lineHeight: 1 }}>
            {c.n}
          </div>
          <div style={{ fontSize: 13, color: dark ? "#8A9099" : COLORS.inkSoft, marginTop: 6 }}>{c.l}</div>
        </div>
      ))}
    </div>
  );
}
