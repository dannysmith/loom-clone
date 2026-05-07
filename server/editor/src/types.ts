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

// Mirrors edits.json on disk so accepted suggestions can be merged into
// the EDL without transformation. Generated server-side once at
// post-processing and dropped after the first commit.
export type SuggestedEdits = {
  version: 1;
  source: string;
  edits: Edit[];
};
