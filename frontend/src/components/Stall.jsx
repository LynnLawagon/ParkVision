import React from "react";
import { Car, TriangleAlert, CircleCheck } from "lucide-react";
import { COLORS, FONTS } from "../styles/tokens";
import { STATUS } from "../data/mockData";

export default function Stall({ s, onClick, dark }) {
  const bg =
    s.status === STATUS.VACANT ? COLORS.vacant : s.status === STATUS.OCCUPIED ? COLORS.occupied : COLORS.blocked;

  return (
    <button
      onClick={() => onClick && onClick(s)}
      title={`Space ${s.id} — ${s.status}`}
      style={{
        width: 44,
        height: 60,
        borderRadius: 5,
        border: "none",
        cursor: onClick ? "pointer" : "default",
        background: bg,
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 0",
        boxShadow:
          s.status === STATUS.BLOCKED
            ? `0 0 0 2px ${dark ? COLORS.asphaltCard : "#fff"}, 0 0 0 4px ${COLORS.blocked}`
            : "none",
        transition: "transform .12s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-2px)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0)")}
    >
      {s.status === STATUS.OCCUPIED && <Car size={16} strokeWidth={2} />}
      {s.status === STATUS.BLOCKED && <TriangleAlert size={16} strokeWidth={2} />}
      {s.status === STATUS.VACANT && <CircleCheck size={16} strokeWidth={2} />}
      <span style={{ fontFamily: FONTS.display, fontSize: 11, fontWeight: 600 }}>{s.id}</span>
    </button>
  );
}
