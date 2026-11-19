import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { Projector } from "./views/Projector";

// The host opens the projector window on the same page with ?projector=<scene>&song=<id>.
const q = new URLSearchParams(location.search);
const projector = q.get("projector");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{projector ? <Projector view={projector} songId={q.get("song") ?? ""} /> : <App />}</StrictMode>,
);
