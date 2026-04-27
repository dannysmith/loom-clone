# Task 1 — Better Default Slugs

**Better default slugs**: Replace the current 8-char hex slugs (e.g. `f28cee40`) with human-readable word-based slugs (e.g. `calm-dogs-dream`). These are easier for people to remember and share verbally, while providing comparable unguessability for unlisted videos.

## Design Decisions

**Library**: [`human-id`](https://www.npmjs.com/package/human-id) (v4.1.3, 2.46M weekly downloads, actively maintained, MIT). Generates adjective-noun-verb combinations from curated short, common English words (200 adjectives, 300 nouns, 250 verbs). Output configured as lowercase kebab-case with `-` separator.

**Word count**: 3 words. Pool of 15M unique combinations (~23.8 bits of entropy). Lower than the current 32-bit hex (~4.3B combinations) but adequate for a personal tool — brute-forcing a valid slug among a few hundred videos would take days even without rate limiting.

**No visibility-dependent slug length**: All auto-generated slugs use the same 3-word format regardless of visibility. Tying slug format to visibility would mean all videos start with long slugs (since all start as unlisted) and need auto-shortening on visibility change, creating redirect debris and added complexity for negligible security gain.

**No auto-mutation on visibility change**: Slugs are stable once generated. Only manual edits change them. This avoids redirect chains from visibility toggles and keeps shared URLs stable.

**Existing videos unaffected**: The slug validation regex (`[a-z0-9](-?[a-z0-9])*`) already accepts both hex and word-based formats. Old hex slugs remain as-is; no migration needed.

**Scope**: Only `generateSlug()` in `server/src/lib/store.ts` changes. No client changes, no API changes, no schema changes, no redirect logic changes.

## Phases

### Phase 1: Replace slug generation

1. Add `human-id` as a server dependency.
2. Replace `generateSlug()` in `store.ts` to call `humanId({ separator: '-', capitalize: false })` in a loop that checks reserved words and slug availability.
3. Update the `findAvailableSlug()` fallback (used by `duplicateVideo()`) to use the new generator instead of raw hex.
4. Update tests that assert the old 8-char hex format to match the new word-based pattern.
5. Update `server-routes-and-api.md` doc to reflect the new slug format.
