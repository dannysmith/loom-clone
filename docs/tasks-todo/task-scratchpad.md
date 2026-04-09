# Scratchpad for Notes on things to do

- [x] Fix laggy video preview when recording
- [ ] Write out a JSON file which contains some representation of the data being recorded with timestamps, what changed (change mode, pause, resume etc), chunks recorded with size etc. All with timestamps. If we write this out to the files on disk, then we can send that up to the server when the video is finished recording. I figure that might be useful if we have to do some server side stuff to rebuild videos or debug videos or whatever that is, you know. 
- [ ] Make it behave properly if the server isn't running when the app opens and disable recording if server is unreachable.
- [ ] Consider how we handle temporarry drops in connectivity, and also if the server doesn't reciev every chunk streamed to it.
- [ ] Make it handle cameras and mics (and screens) which come online while the app is running/open - probably need polling for these?
