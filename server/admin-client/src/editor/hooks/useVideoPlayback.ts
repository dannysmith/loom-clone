import { useCallback, useEffect, useRef, useState } from "react";
import type { Edit } from "../types";

export function useVideoPlayback(edits: Edit[]) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const rafRef = useRef<number>(0);
  const editsRef = useRef(edits);
  editsRef.current = edits;

  // RAF loop for smooth time tracking + cut region skipping.
  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const t = video.currentTime;
        setCurrentTime(t);

        // Skip over cut regions during playback.
        const cuts = editsRef.current.filter((e) => e.type === "cut");
        for (const cut of cuts) {
          if (t >= cut.startTime && t < cut.endTime) {
            video.currentTime = cut.endTime;
            break;
          }
        }

        // Stop at trim end.
        const trim = editsRef.current.find((e) => e.type === "trim");
        if (trim && t >= trim.endTime) {
          video.pause();
          video.currentTime = trim.endTime;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  }, []);

  const onPlay = useCallback(() => setIsPlaying(true), []);
  const onPause = useCallback(() => setIsPlaying(false), []);

  const play = useCallback(() => videoRef.current?.play(), []);
  const pause = useCallback(() => videoRef.current?.pause(), []);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // If at trim end, wrap to trim start.
      const trim = editsRef.current.find((e) => e.type === "trim");
      if (trim && video.currentTime >= trim.endTime) {
        video.currentTime = trim.startTime;
      }
      video.play();
    } else {
      video.pause();
    }
  }, []);

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const stepForward = useCallback(
    (seconds: number) => {
      if (videoRef.current) seek(videoRef.current.currentTime + seconds);
    },
    [seek],
  );

  const stepBackward = useCallback(
    (seconds: number) => {
      if (videoRef.current) seek(Math.max(0, videoRef.current.currentTime - seconds));
    },
    [seek],
  );

  return {
    videoRef,
    currentTime,
    duration,
    isPlaying,
    onLoadedMetadata,
    onPlay,
    onPause,
    play,
    pause,
    togglePlayPause,
    seek,
    stepForward,
    stepBackward,
  };
}
