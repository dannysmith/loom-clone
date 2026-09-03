import type { RefObject } from "react";
import { videoSrcUrl } from "../api";

type Props = {
  videoId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  onLoadedMetadata: () => void;
  onPlay: () => void;
  onPause: () => void;
};

export function VideoPreview({ videoId, videoRef, onLoadedMetadata, onPlay, onPause }: Props) {
  return (
    <div className="editor-preview">
      <video
        ref={videoRef}
        src={videoSrcUrl(videoId)}
        preload="auto"
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onPlay={onPlay}
        onPause={onPause}
      />
    </div>
  );
}
