# Features

> Note: This is a working doc on the features of this project, which will probs eventually be used as the basis of a blog article and/or a project website (and/or a decent README.md etc)

## Why I built this

## Overview: The fundamental Requirements

1. macOS menubar app
2. Backend API (for the menubar app)
3. Admin Web app (and its own API)
4. Viewer-facing surface

### Visibility/Permissions

- Unlisted
- Public
- Private

## The Menubar App UI

- Source Selection
- Perviews (Video/Audio etc)
- Camera Adjustments
- Starting Mode & Stream Quality

## The Recording UI

- Mode Switching
- The Preview Overlay
- Pausing & Cancelling

## The Backend API

- Brief overview

## The Basic Recording Lifecycle

[Mainly from the macOS app's POV...]

### Sources & Previews & Warming Up

### Hitting Record

### What get's streamed up and why

### Hitting Stop

### Editing the last video's details in the mac app

## The Basic Viewer-Facing Players

### `/:slug`

### `/:slug/embed`

## What get's stored locally


## Server-Side Post-Processing

### Audio Processing

### Basic Derivitives

### Thumbnaiils

### Storyboard & Scrubber Generation

## Mid-Recording Resilliance & Recovery

## Healing

## Transcription & Subtitles

## The Admin Interface

### The Dashboard

### The Video Page

### Slugs & Redirects

### The Activity Log

### Video Actions

### Settings & Trash Bin

### The Admin API

## Viewer-Facing Niceties

- `/:slug` SEO & OEmbed stuff
- `/:slug/embed` stuff including `/oembed` URL.
- The player, versions, poster, subtitles, storyboard, transcriptions etc.
- `/:slug.json`
- `/:slug.md`
- `/feed.xml` (and `/rss`)
- `/feed.json`
- `/llms.txt`
- `/` hints for LLMs and machines etc

## Deployment

- Blah

### Archiving & Backup

## Performant Capture & Audio Sync
