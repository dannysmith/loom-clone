# Task 5: Storage & Backups

Goal: Move video files off the Hetzner box's local disk onto proper object storage, and set up a backup strategy for the canonical `source.mp4` files and important metadata.

## Proper Storage on Hertzner File Store (same API as R3)

It is obviously not sensible for us to actually be storing all of our video files and data on the Hertzner box - which is why we are writing our files to a shared volume. But we should should probably be using proper file storage system like Amazon R3 or Hertzner File Object Store or similar. So let's think arefully about that and how we could do so in a way that it's easy to work with.

## Backup Strategy

We should probably have backups of the final source.mp4 videos and their important metadata (url, title, date etc) automatically backed up to some long-term storage which is seperate from our main storage, just in case of emergencies etc. Let's consider options and approaches for this.
