# Task 4 — AI Title & Slug Suggestions

Depends on: Task 3 (Better Default Slugs)

**AI title & slug suggestions**: Suggest a title and slug based on the video content. The only viable way of doing this simply would be to use the transcript and use my mac's apple intellience. I don;t want to have the server calling out to external LLM APIs, and the server isn't beefy enough to run even a small LLM (or rather it'd be a stupid use of resource to do so). Maybe something like:
  1. If local transcription runs, when the transcription is finished send the transcript and a short suitable propt to Apple Intelligence. Apple intelligence is not good at dealing with complex stuff so the prompt should be very clear, short and ask only for a sugested title for the video. For long transcripts we should probably only include the first `n` words - many videos are likeley to have the most relevant info in the first minute or so anyway. Perhaps we could help by including other info we already know like "short screenshare video" or "12-minute talking head video with ~2 mins of screensharing" or whatever. We can obviously generate this kind of thing using deterministic code based on some rules and what we already know from recording.json etc and inject it into the prompt along with the transcript.
  2. Independantly of the transcription upload (which should continue independantly of this): sanity check whatever Apple Intelligence returns against some simple rules to weed out malformed or obviously insane suggestions (these will probably become apparent through actual testing with the model).
  3. Pass the "possibly sane" suggestion(s?) to the server as suggested title(s?) via a specific type of PUT and:
  4. If the title hasn't already been updated by the user, update it and also update the slug to an appropriately slugified version of the title (after checking it hasn't been changed by the user yet). ALTERNATIVELY we could instead offer the title and slug as a "suggestion" to the user in the admin web UI and the equivilent "Edit" bit of the macOS popover panel rather than actually updating it.

## Phases

Phases TBD — depends on Task 3 settling the slug generation approach first. Implementation planning deferred until then.
