# Audio Models

RNNoise model files for the `arnndn` ffmpeg filter, used in the audio post-processing pipeline.

## cb.rnnn (conjoined-burgers)

Source: [richardpl/arnndn-models](https://github.com/richardpl/arnndn-models) (archived)

Trained on "Recording" signal (close-mic speech) with "General" noise category. Best general-purpose choice for screen recording / talking-head audio where the noise is a mix of fan hum, room ambience, keyboard clicks, and other environmental sounds.

Other models in the repository optimise for narrower noise profiles (e.g. `bd.rnnn` targets background voices specifically). `cb.rnnn` covers the broadest range of real-world recording conditions.

License: the model weight files are not subject to copyright per the repository's own statement. The underlying RNNoise library (Mozilla/Xiph) is BSD-licensed.

## Usage

The pipeline in `server/src/lib/derivatives.ts` references this file by resolving `server/assets/audio-models/cb.rnnn` at runtime. The path is resolved absolutely so it survives test `chdir()` calls.
