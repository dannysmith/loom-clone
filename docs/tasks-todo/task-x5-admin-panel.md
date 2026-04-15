# Task: Admin Interface

Goal: Add a proper admin interface to the Hono App for managing Videos etc

## Dashboard / All Videos

- Video Card / Grid View
- Row/Table View
- Pagination
- Filter / Sort
- Quick Search

## Settings

A simple settings page for global settings etc.

- API key stuff?
- Tag management

## Video Page

The page for an individual video which allows me to view its data, view the video and edit certain things. 

### Video Player & Embeded Data

Video Player & basic video data (length, framerate, metadata, whatever makes sense here)

### Video Info

Can edit fields like:

- **Title**: Editable. Used as the page heading on the public video page.
- **Slug**: Editable. Determines the URL path (e.g. `v.danny.is/my-video`). When changed, the old slug becomes a 301 redirect.
- **Description**: Editable. Shown on the public video page. Optional.
- **Tags**: Add/remove tags for organisation.
- **Visibility**: One of three states:
  - **Public** — Short, readable slug. Indexable by search engines. Appropriate meta tags.
  - **Unlisted** — Long hash-based URL. Not indexable (`noindex` meta tag, excluded from sitemap). Accessible to anyone with the link.
  - **Private** — No public URL at all. Only visible in admin. Can be changed to public or unlisted later.
  - New videos default to **Unlisted** — they get a working URL immediately (for the instant-share workflow) but aren't indexed until explicitly made public.

### File "Browser"

Shows all server-side files for this video inclding derivetives, recording.json, backups etc etc. Text files can be viewed.

## Video event log system

Record all events which happen to a video (initially from server events and recording.json, afterwards record things like renames, data changes, backups etc etc). The main point of this feature is so that if anything goes wrong or a little bit weird, it's possible for me to see everything which occurred to a particular video object. This should be viewable as a kind of log on the admin video page. 

## Tagging

The simple ability to tag videos from a list of tags managed in the settings.

## Trashing Videos (Trash Bin)

The ability to mark files as "trashed" in the database. This should immediatly make them private and inacessible to the public. The slug should return a 404. It should also move the video folder to a special "trash" folder/bucket on disk AND intentionally invalidate any caches and the Cloudflare/view layer immediatly.

Note: As with any soft-deletion, it would be ideal if database calls to eg. `Videos.all` did NOT return trashed videos by default, so as to prevent accidents in the future.

There should be a "Trash Bin" page in the admin interface which shows all trashed videos and allows me to play them.

Emptying the "Trash Bin" is out of scope for now.

## Video Actions

These actions can be triggered from the video page, or the card on the dashboard (via menu)

- **View**: Watch the video in the admin interface.
- **Open URL**: Open the public/unlisted URL.
- **Copy URL**: Copy the public/unlisted URL to clipboard.
- **Download**: Download the source.mp4. If derivitives exist, choose which.
- **Duplicate**: Duplicates a whole video with a new ID and a number appended to the title and slug. Unlikely to be used until we begin to build editing features, but worth baking in now. 
- **Change Visibility** - Change view permissions (public/unlisted/private)
- **Trash**: "Soft" Delete the video.

## Upload Video

The ability to upload a video file and have it in the system - primarily be used for historical videos which I have downloaded from loom/youtube etc.
