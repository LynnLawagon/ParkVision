import React from "react";
import { Camera, Plus, Pencil, Trash2 } from "lucide-react";
import { COLORS } from "../styles/tokens";

// Regions define where each parking space sits within the camera frame
// (FR-10 / SR-06). This screen only edits coordinates + labels; it never
// touches the detection model itself. Wire the buttons to:
//   POST   /api/regions        (create)
//   PATCH  /api/regions/:id    (edit)
//   DELETE /api/regions/:id    (delete)
export default function RegionsTab() {
  const regions = [
    { id: "A1", zone: "A", x: 40, y: 30, w: 70, h: 100 },
    { id: "A2", zone: "A", x: 120, y: 30, w: 70, h: 100 },
    { id: "A3", zone: "A", x: 200, y: 30, w: 70, h: 100 },
    { id: "B1", zone: "B", x: 40, y: 150, w: 70, h: 100 },
    { id: "B2", zone: "B", x: 120, y: 150, w: 70, h: 100 },
  ];

  return (
    <div style={{ padding: 26, display: "flex", gap: 24 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "#8A9099", marginBottom: 10 }}>Camera feed — Zone A &amp; B</div>
        <div style={{ position: "relative", width: "100%", maxWidth: 480, height: 280, borderRadius: 10, overflow: "hidden", border: `1px solid ${COLORS.asphaltLine}` }}>
          <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(45deg, #24272B, #24272B 10px, #1E2124 10px, #1E2124 20px)" }} />
          <div style={{ position: "absolute", top: 10, left: 10, display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#8A9099" }}>
            <Camera size={13} /> CAM-04 · live
          </div>
          {regions.map((r) => (
            <div
              key={r.id}
              style={{
                position: "absolute",
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                border: `2px dashed ${COLORS.paint}`,
                borderRadius: 4,
              }}
            >
              <span style={{ background: COLORS.paint, color: COLORS.asphalt, fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: "0 0 4px 0" }}>
                {r.id}
              </span>
            </div>
          ))}
        </div>
        <button style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6, border: `1px solid ${COLORS.asphaltLine}`, background: "transparent", color: "#fff", padding: "9px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>
          <Plus size={14} /> Draw new region
        </button>
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "#8A9099", marginBottom: 10 }}>Defined parking-space regions</div>
        <div style={{ background: COLORS.asphaltCard, borderRadius: 12, border: `1px solid ${COLORS.asphaltLine}`, overflow: "hidden" }}>
          {regions.map((r, i) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: i ? `1px solid ${COLORS.asphaltLine}` : "none", fontSize: 13 }}>
              <div>
                <span style={{ fontWeight: 600 }}>Space {r.id}</span>
                <span style={{ color: "#8A9099", marginLeft: 10 }}>Zone {r.zone}</span>
              </div>
              <div style={{ display: "flex", gap: 10, color: "#8A9099" }}>
                <Pencil size={15} style={{ cursor: "pointer" }} />
                <Trash2 size={15} style={{ cursor: "pointer" }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "#6B7178", marginTop: 12 }}>
          Changing a region here doesn't touch the detection model — it only tells ParkVision where to look.
        </div>
      </div>
    </div>
  );
}
