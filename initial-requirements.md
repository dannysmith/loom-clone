# Danny's Loom Clone - Research & Initial Requirements

I routinely use Loom for recording videos. I I've recently experimented with replacing this with [Cap](https://cap.so/) because it's open source. But in reality, I would love to have my own tooling to handle this.

## Use Cases

I use asynchronous videos like this all the time. Here are some examples of use cases:

- Quick one-off "talking-head" videos which I share on Slack in place of a text message. Also quick "Hey man here's how you do this" screenshares in a similar vein. These are often intended to be very, very fast ways of communicating with individuals. These are often throw away once the other person has watched them. 
- Asynchronous announcements/presentations/briefings - these will often go out in public Slack channels Or be embedded in Gogle docs or Notion docs (eg "pre-brief for senior leadership meeting <date>" or "welcoming <new hire> to the company" etc).
- Intros to documents - I regularly include a short talking head video at the top of longer documents, whether they're internal or whether they're things like client proposals, because I just think it's a good way of personally introducing what's in the document below.
- Evergreen videos embedded in Notion docs, google docs, github docs etc. Sometimes these are intro's as above, but often these are screen shares or talking head videos which form part of the lessons and learning. you know, these are often tutorials or evergreen internal documents explaining how to do certain things or why we do things in a certain way. I guess the key difference with these is that they are evergreen. And so I usually take a little bit more care over over them than I may for some of the more ephemeral things I mentioned above. It's worth noting that some of these types of videos historically I've actually exported from Loom and uploaded to YouTube just because they'll always be there on YouTube. Some of these kinds of documents, if they are in internal knowledge bases that my clients use, are likely to still be in those knowledge bases many years into the future. So they need to remain publicly available.
- This isn't really a separate use case, but sometimes I have much longer videos I need to put together. Maybe like a bit of a product demo or like a help document or or just a much longer tutorial video explaining some involved process. and in this case They almost certainly involve more than one loom video edited together.

## Why I Love Loom

Fundamentally, Loom gives me two things which I did not have before Loom existed:

1. Instant Share URLs - Loom streams up and encodes the video recording on the fly so that immediately I hit the stop button I have a URL to the video available on my clipboard. I can't overstate how important the speed of this is. The ability for me to hit record, speak into my camera or screen share, hit stop, and then immediately play paste a URL into Slack or anywhere else, and just have that video there. So that like in Slack the other person can immediately watch it. That's super important.
2. "Unfurling" support everywhere. Because Loom got pretty fast adoption in 2020, tools like Slack, Notion, Discord etc etc etc All very quickly supported unfurling/embedding and in many cases playing directly in those tools in the same manner they did for YouTube. This is particularly important when it comes to business tools like Slack and Notion.
3. Reliability for me - In the early days of Loom it wasn't always reliable. But very quickly Loom realised that the most frustrating thing in the world is recording a five minute video and something going wrong with the upload or the encoding and you loosing it. Loon is currently very good at ensuring that at the very minimum there is a local version of that recording which can be re-uploaded, re-encoded, etc. So we don't lose anything. 
4. Reliability for viewers - Loon is a big company. And even if a hundred thousand people all decide to watch one particular Loon video of mine at the same time, it's not gonna fall over.

## My Problems

I have always had these problems with Loom:

- I don't own my URLs - I have hundreds and hundreds of Loom videos on loom domains. I would much prefer these to be on a domain I control.
- No way to "hot-swap" from Camera-only to Screen+camera-in-corner while you record. I routinely want to start recordings as a talking head, then cut from that to a screen share with my head in the corner or not, and then at certain points cut back to my talking head. There's no way in Loom to achieve this without making seperate recordings and cutting them together in the online Editor.
- User-facing features I don't need - Although it's possible to disable comments and likes on public videos. This isn't the default and generally the interface that people get when they go to a public URL for my video includes a bunch of liking and commenting and adding notes and all sorts of things which I I just don't need. I want the page for a video to just be the video with a little metadata.
- Me-facing features I don;t need - Loon is increasingly shoving video management features in my face which I don't necessarily want or need. Some of them are cool, such as Automated Transcription and AI title generation, But as I VC-backed company they're gonna keep pushing this stuff (with more and more AI Crap).
- Loom is expensive for what I need from it.
- The Loom desktop app is kinda janky a lot of the time (it feels like a Electron or Tauri app) Which isn't ideal for a menu bar app.

I partially switched to Cap.so because it's open-source and let me put videos on my own domain. But increasingly it feels extremely clunky and feature-bloated, and I get the feeling much of the code is AI-generated (which is not necessarily a bad thing, but it doesn't feel very cared-for as a product). I have not run my own Cap server, but have paid Cap a subscription so I can have videos on my own subdomain (v.danny.is). I've not been especially impressed. Things break randomly. And it doesn't feel like Cap is ready to be a production grade SaaS product yet.

## What I want to Explore

I want to explore the possibility of building my own tooling for this. This will almost certainly include the following parts:

1. Desktop app - A native macOS app for recording/streaming video, and potentially for making minor edits as I go.
2. Server app - To recieve/encode/store etc the recordings.
3. Management app - Web app for me to manage my recordings. Probably part of (2).
4. Content-delivery platfrom - a way to serve these videos to other people in a reliable, performant and scaleable way. I'm listing this as a separate thing here because if I'm gonna self host (2) and (3) This part should almost certainly not be on the same infra. And even if I do decide to use scalable infra, We're gonna need some proper CDN/caching layer in front of it.

## Desktop App Requirements

- The desktop app only needs to work on macOS.
- I must be able to record my screen, camera and microphone in any combination. Sometimes I will want to record just my camera and microphone. Like when I'm doing a talking head video. Sometimes I'll only want to record my screen and microphone. If I'm doing like a quick demo. And sometimes I want to record my screen with my camera inset in the corner and my microphone, which is many of the videos where I'm screen sharing.
- I must be able to easily chop between "camera+mic" and "screen+mic+head-in-corner", Either by hitting a button or key combination as I am recording. or less ideally by pausing or stopping local recording, switching to the like a different view, like a camera and mic only, and then starting recording and have that appended on the end.
- I must be able to choose which monitor to record from when screen sharing. I do not need to be able to record sections of monitors or individual windows (for now).
- I must be able to choose which camera input device to record from, and which microphone input device to record from.
- When screensharing with a camera on, I must be able to place the camera feed in a circle in the corner, and ideally be able to move and resize it while recording or paused (and choose between square/circle etc).
- When recording I must be able to pause and resume recording easily.
- Full or very high resolution inputs must be captured from camera, mic and screen-recoding input streams. these may not necessarily be immediately streamed up to the server, but they should be captured locally (and ideally streamed later?).
- full local versions of the recordings should be captured and stored at least until I've given some indication that the end result that's online is good enough and we haven't lost anything or got any issues in the encoding process. This is basically me saying that I don't ever want to spend twenty minutes recording something and then find that there's no possible way of recovering the footage.
- The desktop app should be simple and reliable, and not hog resources when not recording. It should obviously also be as performant as possible when I am recording.

### Nice To Haves

- A quick way of editing the title and slug of the video that's just been uploaded (and getting the URL) without oprning a browser.
- A basic video editor interface which helps me trim the start and end of clips, chop out any errors, perhaps automatically remove silent bits etc. This one really is a stretch goal. This may be better done as part of the web app.
- Simple audio enhancement - Things like basic noise reduction, basic gating, pot reduction, m all of the the very simple things that y you would expect to find in an app like this. It may be better to do this on the server side. But it may prove easier and better to do this before or as the audio is being streamed. All of these things, if they happen client side, should be configurable in the client.
- Some controls to adjust the tone and white balance (for talking head videos) directly in the app. I'm only interested in doing this if we can somehow hook into native Mac OS tooling or existing libraries to help us do this. My main use case for this is making extremely small tweaks before I hit record. which I sometimes need to do depending on how sunny it is or or where I am when I'm recording from the camera.

## Server Requirements - Backend

- Can reliably recieve a stream from the desktop app, process on the fly, store appropriatley etc.
- Correct, Performant and Reliable - that's basically it!
- All videos are backed up to some third-party storage (S3 etc)

## Server Requirements - Admin Side

Web app I can log into to manage my recordings. Much like Loom's backend but simpler:

- Can see all my videos in a list/grid. Can view, delete, dowload etc
- Basic sorting/filtering
- Some simple form of organisation, probably just via tags.
- Can edit certain settings/properties for each video: title, slug, description, private notes etc.
- Can set videos as either unlisted (URL contains long UUID, suitable robots.txt/meta rules etc) or public (short slug, indexable etc). Potentially also "private" which means they have no public URL at all.
- Can upload an mp4 video directly if needed (allows me to import my exported loom/cap/youtube videos if needed)

### Nice-to-haves

- Automatic transcription & subtitleing
- Simple AI title/slug generation/suggestion

## Server Requirements - Public Side

Given a video URL eg "v.danny.is/welcoming-bob-to-the-company" or "v.danny.is/ef0de89916f047b8bb983fbc12884ce6cfa790bee3f64d269fdb015e1be56f4f-private-welcome-for-bob"...

- When a user **visits** the URL in a browser, they get a nice clean page with the video player embedded and appropriate info for a "video landing page". Has appropriate meta, OG, SEO data etc.
- When an **iframe requests** the URL, it just renders the video player and nothing else. Essentially, let's make embedding as easy as possible for people.
- When a user **shares** the URL in a tool like Slack/Notion/wherever, it unfurls properly and ideally shows an inline player. This might require us to hijack another service/domain for which these apps already do that.
- URLs are permenant (changing a slug makes the old one a 301 redirect).

By far the ost important thing is that these pages and their videos:

- Load & play reliably etc.
- Are always available (ie high uptime)
- Can handle sparodic high-traffic if needed.
- Are hosted close to their consumers, wherever they are.
- Buffer quickly for as many users as possble.
- Don't rely on the backend/admin server resources when viewers hit them.
- Etc.

### Nice-to-haves

- The video player streams down at an appropriate wuality for the clients's conntection.
- Requesting the URL with a `.mp4` suffix returns the actual mp4 video.
- Requesting the URL with a `.json` suffix returns a JSOn object containing the URL, raw video URL, metadata and a transcript. Likewise a `.md` suffix returns similar in an appropriate format.

## Other Key Context

- This only for me to use (as an admin/recorder etc) - no social/team features
- Many videos will only have 1-2 views (coz one-off-on-slack etc). Some videos can expect 30-100 views per day for a while. While we don't need to cater for random "1.2mil views in 6 hours" moments: if I'm going to rely on this system as a place to keep my publically-available videos, I'd like to have the confidence that a popular linkedin post, Notion page etc isn't gonna break.
- I suspect the "reliably managing, hosting & distributing vidoes" bit of this has been solved for a long time and there are well-established services/products/OSS projects we can lean heavily on here.
- The somewhat seperate "easily record how Danny wants to on a mac and have that streamed up to a loom-like place immediatly" bit of this is less-well sloved. AFAIK only Loom and Cap.so are close to what I want here. But I may be wrong.
- While I've build a number of Tauri apps, the macOS part of this feels like it should be proper native (ie Swift) so it can take full advantage of OS-level libraries & APIs. [I guess there's even potential to do transcription (& "AI title generation") on-device with Apple Inteligence (or a better local model) and send that up?]
- I obviously expect the server/CDN elements of this to cost me some money, but remember this is a personal thing.
