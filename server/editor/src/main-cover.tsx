import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./cover/App";
import "./cover/styles.css";
import type { VideoInputs } from "./cover/state";

const root = document.getElementById("cover-root");
if (!root) throw new Error("Missing #cover-root element");

const videoId = root.dataset.videoId;
const slug = root.dataset.videoSlug;
const publicUrl = root.dataset.videoPublicUrl;
const currentThumbnailUrl = root.dataset.videoThumbnailUrl;
const title = root.dataset.videoTitle ?? "";

if (!videoId) throw new Error("Missing data-video-id on #cover-root");
if (!slug) throw new Error("Missing data-video-slug on #cover-root");
if (!publicUrl) throw new Error("Missing data-video-public-url on #cover-root");
if (!currentThumbnailUrl) throw new Error("Missing data-video-thumbnail-url on #cover-root");

const inputs: VideoInputs = {
  videoId,
  slug,
  title,
  publicUrl,
  currentThumbnailUrl,
};

createRoot(root).render(
  <StrictMode>
    <App inputs={inputs} />
  </StrictMode>,
);
