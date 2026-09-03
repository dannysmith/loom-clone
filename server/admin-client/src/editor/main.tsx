import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/editor.css";

const root = document.getElementById("editor-root");
if (!root) throw new Error("Missing #editor-root element");

const videoId = root.dataset.videoId;
const videoDuration = parseFloat(root.dataset.videoDuration || "0");
const videoTitle = root.dataset.videoTitle || "Untitled";

if (!videoId) throw new Error("Missing data-video-id on #editor-root");

createRoot(root).render(
  <StrictMode>
    <App videoId={videoId} videoTitle={videoTitle} videoDuration={videoDuration} />
  </StrictMode>,
);
