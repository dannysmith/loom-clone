export type Edit = {
  type: "trim" | "cut";
  startTime: number;
  endTime: number;
};

export type Edl = {
  version: 1;
  source: string;
  edits: Edit[];
};

export type PeaksData = {
  length: number;
  sampleRate: number;
  data: number[];
};

export type Word = {
  word: string;
  start: number;
  end: number;
};

export type StoryboardCue = {
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
