import React from "react";
import { COLORS } from "../styles/tokens";
import { STATUS } from "../data/mockData";

export default function StatusChip({ status }) {
  const map = {
    [STATUS.VACANT]: { color: COLORS.vacant, label: "Vacant" },
    [STATUS.OCCUPIED]: { color: COLORS.occupied, label: "Occupied" },
    [STATUS.BLOCKED]: { color: COLORS.blocked, label: "Blocked" },
  };
  const m = map[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: COLORS.inkSoft }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: m.color, display: "inline-block" }} />
      {m.label}
    </span>
  );
}
