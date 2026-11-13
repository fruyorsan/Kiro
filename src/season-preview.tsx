// TEMPORARY preview harness. Delete together with season-preview.html.
const w = window as any;
w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(1), transformCallback: () => 0, metadata: {} };

import { createRoot } from "react-dom/client";
import { SeasonLayer } from "./components/SeasonLayer";

const params = new URLSearchParams(location.search);
const season = params.get("season") || "snow";
const view = params.get("view") || "dock";
localStorage.setItem("kiro-season-theme", season);

const surface = (width: number, height: number, radius: number) => ({
  position: "relative" as const,
  width,
  height,
  borderRadius: radius,
  background: "rgba(26, 27, 33, 0.96)",
  boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
  overflow: "visible" as const,
});

createRoot(document.getElementById("root")!).render(
  <div
    style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "linear-gradient(160deg, #151a22, #241a20 60%, #2a1c16)",
    }}
  >
    {view === "notch" ? (
      <div className="screen" style={{ position: "relative", width: 240, height: 44 }}>
        <div className="kiro" style={surface(240, 44, 20)}>
          <SeasonLayer radius={20} edge="bottom" />
        </div>
      </div>
    ) : (
      <div style={surface(560, 60, 20)}>
        <SeasonLayer radius={20} />
      </div>
    )}
  </div>
);
