// Self-hosted webfonts for the cover canvas (and this tool's own chrome).
// Bundled rather than fetched from Google at runtime: the fonts bake into an
// exported cover, which becomes a published thumbnail — see
// docs/developer/admin-client.md for the dependency policy.
import "@fontsource-variable/fira-code";
import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import type { Author, VideoInputs } from "./state";

const root = document.getElementById("cover-root");
if (!root) throw new Error("Missing #cover-root element");

const videoId = root.dataset.videoId;
const slug = root.dataset.videoSlug;
const publicUrl = root.dataset.videoPublicUrl;
const currentThumbnailUrl = root.dataset.videoThumbnailUrl;
const title = root.dataset.videoTitle ?? "";
const authorName = root.dataset.authorName;
const authorHandle = root.dataset.authorHandle;
const authorAvatar = root.dataset.authorAvatar;

if (!videoId) throw new Error("Missing data-video-id on #cover-root");
if (!slug) throw new Error("Missing data-video-slug on #cover-root");
if (!publicUrl) throw new Error("Missing data-video-public-url on #cover-root");
if (!currentThumbnailUrl) throw new Error("Missing data-video-thumbnail-url on #cover-root");
if (!authorName) throw new Error("Missing data-author-name on #cover-root");
if (!authorHandle) throw new Error("Missing data-author-handle on #cover-root");
if (!authorAvatar) throw new Error("Missing data-author-avatar on #cover-root");

const inputs: VideoInputs = {
  videoId,
  slug,
  title,
  publicUrl,
  currentThumbnailUrl,
};

const author: Author = {
  name: authorName,
  handle: authorHandle,
  avatarUrl: authorAvatar,
};

createRoot(root).render(
  <StrictMode>
    <App inputs={inputs} author={author} />
  </StrictMode>,
);
