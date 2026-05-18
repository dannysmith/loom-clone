# Admin styling — adopt cover editor's design language

We are going to:

1. Update the Hono app's styling to use my brand colours.
2. Update the styling for public-facing pages (video, embed and tag routes) to use my brand colours and generally look a little nicer and more on-brand.

We will also take this opportunity to do any CSS cleanup we can, especially when it comes to fundamental "design system"-ish stuff and consistency of styling accross the whole app.

## Current State

### The Hono admin app

The admin uses **vanilla CSS with `@layer`** (`reset`, `tokens`, `base`, `components`, `admin`, `utilities`), entry point `server/public/styles/app.css`. Page-/section-specific files (`admin.css`, `viewer.css`, `embed.css`, `player.css`) link via the layout's `head` slot rather than via the entry. Colours are defined in OKLCH and consumed through CSS custom properties. Both light and dark mode are supported via `light-dark()`.

#### Colour tokens (admin)

Primitives in `server/public/styles/tokens.css`:

**Neutrals** — 8-step OKLCH scale, all at hue `250` with tiny chroma (≈0.005–0.02). Effectively near-neutral grey with a *blue* tint.

- `--neutral-0`, `--neutral-50`, `--neutral-100`, `--neutral-200`, `--neutral-400`, `--neutral-600`, `--neutral-800`, `--neutral-900`

**Accent** — same hue `250`, single step. **Currently blue, not the brand coral.**

- `--accent-500`, `--accent-600`, `--accent-fg`

**Tag palette** — 10 OKLCH options used both for tag chips *and* as colour-coding elsewhere (file-type icons, the "edited" badge, the "warning" meta pill). All ~60–75% lightness, ~0.12–0.20 chroma.

- `--tag-gray`, `--tag-red`, `--tag-orange`, `--tag-yellow`, `--tag-green`, `--tag-teal`, `--tag-blue`, `--tag-indigo`, `--tag-purple`, `--tag-pink`

**Semantic mappings** — light/dark via `light-dark()`:

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--color-bg` | `neutral-0` | `neutral-900` | Page background |
| `--color-surface` | `neutral-50` | `neutral-800` | Sidebar, card surfaces, headers of lists |
| `--color-fg` | `neutral-900` | `neutral-50` | Primary text |
| `--color-fg-muted` | `neutral-600` | `neutral-400` | Secondary text, idle icons, placeholders |
| `--color-border` | `neutral-200` | `neutral-800` | Every border |
| `--color-accent` / `-hover` / `-fg` | `accent-500` / `-600` / `accent-fg` | (same) | Focus rings, links, filled primary CTAs |
| `--color-danger` + `-bg` + `-border` | low-chroma red | high-chroma red | Private badge, danger buttons, errors |
| `--color-success` + `-bg` + `-border` | green | green | Declared but **almost unused** — only the API-keys "new token" panel and the "Active" key badge |
| `--color-warning` + `-bg` | amber | amber | Healing / processing badges, warning pills |
| `--color-info` + `-bg` | blue | blue | Recording / public badges |

Border tokens exist only for `danger` and `success` — `warning` and `info` don't have a `-border` variant.

A separate **viewer-only palette** is hardcoded for dark mode (`--viewer-bg`, `--viewer-fg`, `--viewer-title`, `--viewer-details`, `--viewer-description`, `--viewer-muted`, `--viewer-border`, `--viewer-link`, `--viewer-link-hover`). Centralised in `tokens.css` but disconnected from the rest of the system (no `light-dark()`, no brand colours).

#### Typography

- `--font-sans` system stack (Apple → Segoe → Roboto → …).
- `--font-mono` system stack (SF Mono → Menlo → …).
- Type scale (~1.2 ratio): `xs` 0.75, `sm` 0.875, `base` 1, `lg` 1.125, `xl` 1.5, `2xl` 2 rem.
- Weights: `400`, `500`, `700`.
- Line heights: `tight` 1.15, `normal` 1.5.

Element styles (`base.css`):

- `h1` 2xl/bold/-0.02em, `h2` xl/bold/-0.01em, `h3` lg/medium.
- Links: `color: var(--color-accent)`, `text-decoration-color` faded to 30% currentColor unless hovered/focused.
- `code`, `kbd`, `samp`, `pre` use `--font-mono` at 95% size.

**Mono usage:** video slugs (`.video-slug`, `.video-card-slug`, `.editable-prefix`, the slug input itself), key token values, file paths, event timestamps, transcript meta times, inline `<code>` inside rendered markdown.

> Bug: `.video-card-slug` references `var(--font-family-mono, …)` — typo, should be `--font-mono`. Currently falls back silently to `ui-monospace`.

**Heading inconsistency:** Video-detail section headers (`<h3>` in `.video-description`/`.video-tags-section`/`.video-notes`) are `font-size-sm` + bold, while `.keys-section-title` is `font-size-lg` + bold. Two different "section heading" treatments.

**Label inconsistency** — four micro-label styles for similar roles:

- `.label` (form labels) — `sm`, medium weight
- `.filter-group-label` — `xs`, bold
- `.tag-edit-label` — `xs`, medium, **uppercase, letter-spaced**, fg-muted
- `.keys-header` — `xs`, bold, fg-muted

#### Spacing, radii, motion, shadows

- Spacing: `--space-1` … `--space-8` (0.25 → 4 rem, doubled-ish).
- Radii: `--radius-sm` 0.25 / `--radius-md` 0.5 / `--radius-lg` 1 rem, plus `--radius-full`. Most components use `md`; chips/badges use `full`; the preview dialog uses `lg`; small inner controls use `sm`.
- Motion: `--duration-fast` 120 ms, `--duration-normal` 200 ms, `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Shadow: single `--shadow-md` (`0 4px 12px oklch(0% 0 0 / 0.12)`).

> Bugs: `.thumbnail-badge` references `var(--space-0)` (undefined), `.thumbnail-candidate` uses `var(--transition-fast)` (undefined), `.transcript-text` uses `var(--line-height-relaxed)` (undefined). All silent fallbacks.

#### Iconography

Inlined **Lucide** icons (`server/src/views/admin/components/Icons.tsx`). All share `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap/linejoin="round"`, `aria-hidden="true"`. Default size 18 px.

Sizes that have emerged organically:

- **20** — sidebar nav + logout
- **16** — toolbar buttons (sort dir, view toggle), upload CTA, file-row icons
- **14** — action-row buttons (`btn--sm`), slug editor tools, popover items, meta pills
- **12** — inline pill icons (filter pills, visibility badges), grid-card meta

**File-type icons** (`FileTypeIcon`) colour-code by extension via the tag palette:

| Pattern | Icon | Colour |
| --- | --- | --- |
| Folder | `IconFolder` | `--tag-blue` |
| `recording.json` | `IconFileCog` | `--tag-orange` |
| `init.mp4` | `IconFileSegment` | `--color-fg-muted` |
| `.mp4`, `.mov` | `IconFileVideo` | `--tag-indigo` |
| `.m4s` | `IconFileSegment` | `--tag-purple` |
| `.m3u8` | `IconFileText` | `--tag-green` |
| `.json` | `IconFileCode` | `--tag-yellow` |
| `.jpg/.jpeg/.png/.webp` | `IconFileImage` | `--tag-teal` |
| `.mp3/.aac/.wav` | `IconFileAudio` | `--tag-pink` |
| `.txt/.md/.log` | `IconFileText` | `--color-fg-muted` |

**Visibility icons:** globe (public), link (unlisted), eye-off (private). Used in badges and filter pills.

#### UI components in use

(All in `admin.css`, layer `admin`.)

- **Buttons** — `.btn`, plus modifiers `--primary` (filled accent), `--sm`, `--danger` (outline), `--danger-solid` (filled red), `--icon` (square aspect). `--secondary` is referenced in `ThumbnailPicker.tsx` but **not defined in CSS** — currently renders as plain `.btn`.
- **Badges** — `.badge`, with variants `--public`, `--unlisted`, `--private`, `--recording`, `--healing`, `--failed`, `--processing`, `--edited`. There is **no `--complete` variant**; the dashboard hides the badge for complete videos, but Video Detail emits `badge--complete` and it lands on the default neutral style.
- **Inputs** — `.input` covers text, textarea, and select. Custom chevron via embedded SVG. `@supports (appearance: base-select)` block in place for Chrome 135+ customisable selects.
- **Filter pills** — `.filter-pill` with status/visibility modifiers, each setting `--pill-active-color/-bg/-border` so the pill's active state reuses the badge colour tokens.
- **Tag chips** — `.tag-chip` (filled at tag's colour, white text) and `.tag-chip--sm`. Colour applied two ways: inline style (`VideoTagsControl`, `VideoCard`) or via `--chip-color` (`.filter-tag-pill`, `.tag-picker-toggle`).
- **Tabs** — `.settings-tabs` + `.settings-tab` (active gets accent border-bottom). Reused for `.video-tabs`.
- **Cards** — `.video-card` lives in both `[data-view="grid"]` and `[data-view="table"]` containers; same DOM, layout switched via the `data-view` attribute on the wrapping list.
- **Popover menu** — `.video-card-popover` + `.popover-item` (incl. `--danger`), using native `popover="auto"` + anchor positioning (`position-area`, `position-try-fallbacks`).
- **Editable fields** — `.editable-field` family (`--editing`, `--inline`, `--block`) with `.editable-trigger` (Edit button) revealed on hover. Used for title, description, notes, slug, visibility, tag picker.
- **Meta pills** — `.meta-pill` (icon + text, fg-muted, tabular-nums), with `--warning` and `--id` modifiers.
- **Surfaces** — sidebar, settings tabs, keys-header, transcript meta, file-row directories, and the file-preview dialog header all use `--color-surface` for a soft elevation tier.
- **Soft hover** — most interactive elements use `light-dark(var(--neutral-100), var(--neutral-800))` as a hover background. Hand-rolled in ~15 places.
- **Dialog** — `.file-preview-dialog` native `<dialog>` with `::backdrop` (hard-coded `oklch(0% 0 0 / 0.4)`).

#### Layout

- Admin shell: CSS Grid, `3.5rem` sidebar + `1fr` main, `100dvh` tall.
- Sidebar is icon-only (no labels). Active state via `aria-current="page"`.
- Main content: `padding: var(--space-6)`.
- Dashboard grid: `repeat(auto-fill, minmax(min(100%, 16rem), 1fr))`.
- Dashboard table: flex column, each row is a 6-column inner grid (`3rem 1fr 1fr auto minmax(0, 1fr) auto`).
- Video detail: no max-width on text; player capped at 56rem.
- No container queries in use today.

### The cover editor & Editor

The cover editor's look (`server/editor/src/cover/styles.css`) is the most "on-brand" part at the moment when it comes to colours, because it was developed independently and then integrated. However, it is a very simple interface with few colours. It is also dark-mode only. The video editor (`server/editor/src/styles/editor.css`) already uses similar colours.

Both editors should remain "dark-mode only" but they currently maintain their own token set (hex literals, distinct radius scale 4/6/8 px, distinct spacing) parallel to the admin token system. Phase 2 should reconcile so both editors *consume* shared brand tokens from the central system while keeping their dark-only appearance.

The Cover Editor uses these colours:

| Token              | Hex       | Use                                                 |
| ------------------ | --------- | --------------------------------------------------- |
| `--bg`             | `#1a1a1a` | Page background, top bars                           |
| `--panel-bg`       | `#232527` | Cards, sidebars, dialogs, the main panel surface    |
| `--panel-bg-input` | `#1a1c1e` | Inputs, textareas, code/value tiles, toasts         |
| `--panel-border`   | `#34373a` | Every border in the UI                              |
| `--text`           | `#e8e8e8` | Primary text, active labels                         |
| `--text-dim`       | `#9aa0a6` | Secondary text, dim labels, placeholders, idle btns |
| `--accent`         | `#ff7369` | Coral. Brand colour. Focus rings, toggle on, hover  |
|                    |           | borders, filled primary CTAs                        |
| `--accent-fg`      | `#1a1a1a` | Text on filled accent buttons (Commit etc.)         |

Two ambient extras already in the editor — semantic categories, not brand:

- Amber `oklch(0.78 0.18 60)` — chapter markers, suggestion bands, "saving" status.
- Warm red `oklch(0.45 0.13 25)` / `oklch(0.85 0.1 25)` — destructive (cut, delete, danger).

### The public-facing pages

Dark-mode only. Consume the `--viewer-*` palette (hue 250, hardcoded — not the brand). Three pages today:

- **`/:slug` (`VideoPage`)** — preconnects + preloads to Vidstack CDN, loads `player.css` (currently an empty stub) and `viewer.css`. Centred 1280 px column. Above the player sits a tiny conditional "Admin" link (only shown when the admin hint cookie is present). The player renders, then title / duration / date / description block, then a single-line `.viewer-attribution` strip with the author's URL above a thin top border. Description is rendered through `marked`. Links in the description are at `--viewer-link` (chroma 0.015 — essentially grey).
- **`/:slug/embed` (`EmbedPage`)** — chromeless, full-viewport. Black background. Pre-play overlay: centred play button (56 px translucent circle, `backdrop-filter: blur(4px)`), title, duration. Overlay fades on `data-started`. All overlay colours hardcoded as `rgba(255 255 255 / …)` and `oklch(0% 0 0 / …)`.
- **`/:tagslug` (`TagPage`)** — reuses the viewer chrome. Header: tag swatch + name + optional markdown description. Body: grid of video tiles (220 px min), each with poster + duration badge + title + date. Footer: same `.viewer-attribution` strip.

`player.css` is an empty placeholder — no Vidstack chrome customisation today. Vidstack ships its default `theme.css` + `video.css` from the CDN.

Styling these may also involve styling parts of the Vidstack player. See https://vidstack.io/docs/player/styling/introduction/ and the Vidstack docs on Context7 for reference if needed.

### Inconsistencies & opportunities

Material findings from the audit; these will inform Phase 2 / 3 / 5.

1. **Brand colour mismatch.** Accent is blue (`oklch(60% 0.18 250)`), brand is coral `#FF7369`. The whole neutral scale is also at hue 250 (a blue tint) — a coral-hue brand probably wants warm-neutral primitives, not cool ones.
2. **Two parallel design systems.** Admin uses OKLCH + `light-dark()` + token scale; the editors use hex literals + dark-only + their own radii (4/6/8 px) and spacing. Editors should keep their dark-only appearance but consume the shared brand tokens.
3. **Viewer palette detached from the system.** Centralised but disconnected. The viewer link colour reads as plain grey rather than as a link.
4. **Missing `.btn--secondary`.** Used in `ThumbnailPicker.tsx`, not defined. Either add the variant or rename usages.
5. **Undefined tokens in use.** `var(--space-0)`, `var(--transition-fast)`, `var(--line-height-relaxed)`, `var(--font-family-mono)` are referenced but never declared. Silent fallbacks.
6. **No "soft hover" token.** `light-dark(var(--neutral-100), var(--neutral-800))` is hand-rolled in ~15 places. A `--color-surface-hover` (and matching `--color-surface-active`) would tighten this up.
7. **Four micro-label treatments.** `.label`, `.filter-group-label`, `.tag-edit-label`, `.keys-header` all play similar roles with different size/weight/case combinations. Converge on one or two patterns.
8. **Two "section heading" sizes coexist.** Video Detail uses `sm` bold; Settings (`.keys-section-title`) uses `lg` bold. Pick one, or formalise a minor/major pair.
9. **Tag palette doubles as semantic colour.** `--tag-blue` is used for the "edited" badge, `--tag-orange` for the "warning" recording-health pill, and file-type icons borrow seven of the ten tag hues. This conflates *user-pickable label colour* with *system-assigned semantic colour* — shifting a tag hue silently re-skins icons. Worth splitting (e.g. a separate `--icon-color-*` ramp, or icon aliases that point at semantic tokens).
10. **No `.badge--complete`.** Video Detail explicitly emits `badge badge--complete`; renders neutral.
11. **Tag chip colour application inconsistent.** Two equivalent paths — inline `background-color: var(--tag-X)` and `--chip-color: var(--tag-X)` via CSS var. Pick one.
12. **Border tokens missing for warning/info.** `--color-danger-border` and `--color-success-border` exist; `--color-warning-border` and `--color-info-border` don't.
13. **No "ghost" button variant.** Sidebar nav-link, sort-dir-btn, view-toggle-btn, color-picker-option, tag-chip-remove etc. each re-roll the same "transparent until hover" pattern.
14. **`player.css` is empty.** Phase 4 will need it.
15. **No tokenised icon-size scale.** 12 / 14 / 16 / 20 emerged from usage but aren't tokens.
16. **Hardcoded blacks** in `.video-player-container`, `.tag-video-duration`, `.file-preview-dialog::backdrop`, `.embed-overlay`. Could become a `--color-overlay` / `--color-scrim` token.
17. **Dashboard view toggle does a full-page navigation** (the Grid/Table `<a>` tags trigger an HTMX boost) rather than client-side swapping the list. Worth knowing; not necessarily a bug.

## Brand Colour Palette

### Primary Colours

- Brand Accent — red-500-standard (`#FF7369`)
- Brand BG Dark — bg-light-700 (`#2F3437`)
- Brand BG Darker — bg-light-800 (`#191919`)
- Brand BG Light — Brand White (`#FFFFFF`)
- Brand BG Lighter — `#FAFAFA` (off-white; one step below White for surfaces)
- Brand White — `#FFFFFF`
- Brand Black — `#191919`
- Brand Highlight 1 (Pink) — red-400 (`#FFD4D4`)
- Brand Highlight 2 (Orange) — orange-400 (`#FED9B7`)

### Full Palette

Each hue runs from 800 (darkest) → 300 (lightest). The `-500-standard` shade is the canonical/standard tone for that hue.

#### Pink

- pink-800 — `#533B4C`
- pink-700 — `#602D51`
- pink-600 — `#AD1A72`
- pink-500-standard — `#E255A1`
- pink-400 — `#FAC8E4`
- pink-300 — `#F4DFEB`

#### Red

- red-800 — `#594141`
- red-700 — `#B84848`
- red-600 — `#E03E3E`
- red-500-standard — `#FF7369`
- red-400 — `#FFD4D4`
- red-300 — `#FBE4E4`

#### Orange

- orange-800 — `#594A3A`
- orange-700 — `#765839`
- orange-600 — `#D9730D`
- orange-500-standard — `#FFA344`
- orange-400 — `#FED9B7`
- orange-300 — `#FAEBDD`

#### Yellow

- yellow-800 — `#59563B`
- yellow-700 — `#645E26`
- yellow-600 — `#DFAB01`
- yellow-500-standard — `#FFDC49`
- yellow-400 — `#FEEEBE`
- yellow-300 — `#FBF3DB`

#### Green

- green-800 — `#354C4B`
- green-700 — `#2C5C5A`
- green-600 — `#0F7B6C`
- green-500-standard — `#4DAB9A`
- green-400 — `#C8EAE3`
- green-300 — `#DDEDEA`

#### Blue

- blue-800 — `#364954`
- blue-700 — `#254E66`
- blue-600 — `#0B6E99`
- blue-500-standard — `#529CCA`
- blue-400 — `#C4E4F2`
- blue-300 — `#DDEBF1`

#### Purple

- purple-800 — `#443F57`
- purple-700 — `#6F6695`
- purple-600 — `#6940A5`
- purple-500-standard — `#9A6DD7`
- purple-400 — `#E6D7F9`
- purple-300 — `#EAE4F2`

#### Brown

- brown-800 — `#434040`
- brown-700 — `#534343`
- brown-600 — `#64473A`
- brown-500-standard — `#937264`
- brown-400 — `#F1E0D8`
- brown-300 — `#E9E5E3`

#### Grey

- grey-800 — `#454B4E`
- grey-700 — `#596063`
- grey-600 — `#9B9A97`
- grey-500-standard — `rgba(151, 154, 155, 0.95)`
- grey-400 — `#EBECED`
- grey-300 — `#EBECED`

#### Neutrals & Backgrounds

- bg/light/bg-light-700 — `#2F3437`
- bg/light/bg-light-800 — `#191919`

## Design Decisions

Outcome of the Phase 1 audit + collaborative decision pass. All hex values will be expressed as `oklch(...)` in `tokens.css` so they compose cleanly with `color-mix()`, `light-dark()`, and runtime modifiers. Brand palette colours are the *source* — only invent new tokens when the palette doesn't cover a role.

### Core principles

- **Source from the brand palette.** Only mint new colours when the palette doesn't cover a role.
- **Express everything in OKLCH.** Hex inputs convert to OKLCH on the way in; downstream tokens use `oklch(...)` so we can use `color-mix()` and `from <color>` modifications safely.
- **Pure neutrals.** Background/surface/border greys stay achromatic (or near-achromatic) — they don't tint warm to harmonise with the coral. The coral will pop more against neutral surfaces; we can revisit if it feels off in practice.
- **Tag palette ≠ icon palette.** User-pickable tag colours and system-assigned icon colours are *separate* concerns even when they happen to draw from the same brand hues.
- **Editors and admin share tokens; viewer is fully separate.** Admin + both editors consume the same token file but the editors stay dark-only (light-mode rules ignored). Public viewer pages get their own lean CSS bundle that does NOT include `admin.css` or its dependencies (see Phase 4).

### Semantic colour tokens

#### Surfaces, text, borders

| Token | Light | Dark | Brand origin |
| --- | --- | --- | --- |
| `--color-bg` | `#FFFFFF` | `#191919` | Brand White / Brand Black (bg-light-800) |
| `--color-surface` | `#FAFAFA` | `#2F3437` | new off-white / bg-light-700 |
| `--color-surface-hover` | derived (~`#F0F0F1`) | derived (~`#3A4044`) | one-step elevation on surface; new — replaces ~15 hand-rolled `light-dark(neutral-100, neutral-800)` patterns |
| `--color-surface-active` | derived (~`#E8E8E9`) | derived (~`#454B4E`) | two-step elevation, also = grey-800 brand |
| `--color-border` | grey-400 (`#EBECED`) | derived (~`#3A4044`) | brand grey-400 light / one step lighter than surface dark |
| `--color-fg` | Brand Black (`#191919`) | `#E8E8E8` | brand black light / soft white in dark (matches cover editor `--text`) |
| `--color-fg-muted` | grey-700 (`#596063`) | grey-600 (`#9B9A97`) | brand greys |
| `--color-accent` | red-500 (`#FF7369`) | red-500 | brand coral, both modes |
| `--color-accent-hover` | red-600 (`#E03E3E`) | red-600 | brand red-600 |
| `--color-accent-fg` | Brand White | Brand Black | text on filled accent buttons |

#### Semantic state (light + dark)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-danger` | red-600 (`#E03E3E`) | red-500 (`#FF7369`) | Errors, destructive button outlines, danger fill background |
| `--color-danger-bg` | red-400 (`#FFD4D4`) | red-800 (`#594141`) | Error backgrounds, danger pill backgrounds |
| `--color-danger-border` | red-500 | red-700 | Error / danger outlines |
| `--color-warning` | orange-600 (`#D9730D`) | orange-500 (`#FFA344`) | Warning text + foreground |
| `--color-warning-bg` | orange-400 (`#FED9B7`) | orange-800 (`#594A3A`) | Warning pill backgrounds |
| `--color-warning-border` | orange-500 | orange-700 | (new — matches danger/success having borders) |
| `--color-success` | green-600 (`#0F7B6C`) | green-500 (`#4DAB9A`) | Success states |
| `--color-success-bg` | green-400 (`#C8EAE3`) | green-800 (`#354C4B`) | Success pill backgrounds |
| `--color-success-border` | green-500 | green-700 | Success outlines |
| `--color-info` | blue-600 (`#0B6E99`) | blue-500 (`#529CCA`) | Info / neutral-positive |
| `--color-info-bg` | blue-400 (`#C4E4F2`) | blue-800 (`#364954`) | Info pill backgrounds |
| `--color-info-border` | blue-500 | blue-700 | Info outlines (new) |
| `--color-overlay` | `oklch(0% 0 0 / 0.5)` | `oklch(0% 0 0 / 0.6)` | Dialog backdrops, video letterbox, embed pre-play scrim — replaces hardcoded blacks |

### Role assignments

#### Primary / secondary / danger actions

- **Primary CTA** — `.btn--primary` = filled `--color-accent` (coral), text `--color-accent-fg`.
- **Secondary CTA** — default `.btn` = outline 1px `--color-border`, surface background, fg text. Drop the orphan `.btn--secondary` name (rename usages to `.btn`).
- **Ghost** — new `.btn--ghost` = no border, transparent background, hover → `--color-surface-hover`. Replaces the ~5 hand-rolled patterns (sidebar nav, sort-dir, view-toggle, color-picker option, tag-chip-remove).
- **Danger outline** — `.btn--danger` = outline `--color-danger-border`, text `--color-danger`, hover bg `--color-danger-bg`.
- **Danger filled** — `.btn--danger-solid` = bg `--color-danger`, text white.

#### Visibility (badge + filter pill colour)

- **public** — `--color-info` (blue) — confirmed unchanged from current.
- **unlisted** — neutral surface/fg-muted — confirmed unchanged.
- **private** — `red-700` (`#B84848`, muted "restricted" red). **Recommended over orange/amber** to keep visual separation from background-processing statuses below; subject to your confirmation.

#### Video status (badges + filter pills)

- **recording** — `red-600` (`#E03E3E`, vibrant red — reads as "live"). Differs from accent so it doesn't blur into primary CTAs.
- **healing** — `orange-500` (`#FFA344`).
- **processing** — `orange-500`.
- **deleting** — `orange-500`. (Confirmed in `db/schema.ts:21`.)
- **complete** — no explicit badge styling (renders neutral / hidden). Boring = success.
- **failed** — `red-700` (`#B84848`, muted alarm — distinct from "recording" red).

#### Selected vs hover

- **Selected / active** (sidebar nav active, active filter pill, promoted thumbnail, "current tab"): `--color-accent` tinted background using `color-mix(in oklch, var(--color-accent) 12%, var(--color-surface))` + 1px `--color-accent` border.
- **Hover** on cards/buttons/rows: `--color-surface-hover` (subtle neutral lift). Distinct from selected.

#### Editor: trim / cut / chapter

- **chapter** — `orange-500` (`#FFA344`) — already in use as `oklch(0.78 0.18 60)`, swap to brand orange.
- **cut** — `red-700` (`#B84848`) — already a destructive red, swap to brand red-700.
- **trim** — `blue-700` (`#254E66`) — non-destructive, muted blue band. Distinct from chapter and cut.

#### "Edited" indicator

- `--color-info` (blue) — reuse the info colour. (Currently uses `--tag-blue`; switching it removes one of the icon/tag colour collisions.)

### File-browser icon colours (semantic, brand-sourced)

A separate semantic ramp — independent of `--tag-*`. Names describe the *role*, values come from the brand palette.

| Role | Token | Brand source | Used for |
| --- | --- | --- | --- |
| Folder | `--icon-folder` | blue-500 (`#529CCA`) | Directory rows |
| Video media | `--icon-video` | purple-500 (`#9A6DD7`) | `.mp4`, `.mov` |
| Segment | `--icon-segment` | purple-700 (`#6F6695`) | `.m4s` (deeper purple to distinguish from full video) |
| Playlist | `--icon-playlist` | green-500 (`#4DAB9A`) | `.m3u8` |
| Config / data | `--icon-config` | orange-500 (`#FFA344`) | `recording.json` |
| Structured data | `--icon-data` | yellow-500 (`#FFDC49`) | other `.json` |
| Image | `--icon-image` | pink-500 (`#E255A1`) | `.jpg`, `.png`, `.webp` |
| Audio | `--icon-audio` | brown-500 (`#937264`) | `.mp3`, `.aac`, `.wav` |
| Text / log | `--icon-text` | `--color-fg-muted` | `.txt`, `.md`, `.log`, `init.mp4` |

### Tag palette (user-pickable, brand-sourced)

Replaces the current 10-option OKLCH set with the brand's 8 hues + grey = 9 options. Aligns with brand standard tones.

Available: `pink`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `brown`, `grey`.

**Chip rendering — recommended (subject to confirmation):**

- **Light mode** — background `<hue>-400` + text `<hue>-800` (e.g. pink-400 `#FAC8E4` background + pink-800 `#533B4C` text). Soft pastel reads as a tag, not a pill.
- **Dark mode** — background `<hue>-600` + text `<hue>-400` (e.g. pink-600 `#AD1A72` + pink-400 `#FAC8E4`). Deeper hue on dark surface, light tinted text.

Pills and badges use `-500` (standard tone) so tags read visually softer than pills, addressing the "tags should look different from other pills" goal.

Plus a tag *icon* (Lucide `tag`) prefix on every tag chip — present even in dense table rows — to make them distinguishable from filter pills and status badges at a glance.

### Typography

- **Font scope.** Sans for everything except: video slugs (admin only), the video UUID, file paths, log timestamps, key/token values, inline `<code>` in markdown, slug input fields. Sans for titles, descriptions, button labels, badges.
- **Heading hierarchy.**
  - `h1` — page title — `xl` bold (kept).
  - `h2` — major section — `lg` bold.
  - `h3` — inline sub-section ("Description", "Tags", "Notes") — `sm` medium `--color-fg-muted`. Standardises across video detail + settings.
- **Form labels — single treatment.** `xs`, medium weight, `--color-fg-muted`, no uppercase, no letter-spacing. Removes the uppercase `.tag-edit-label` variant.
- **Editable fields.** Keep the "click to edit" pattern (hover reveals Edit trigger), but the trigger uses the new `.btn--ghost` variant instead of `.btn--sm` to avoid the heavy border on a quiet affordance.

### Iconography

- **Library** — Lucide, inlined as SVG (current pattern).
- **Sizes — tokenised.** `--icon-xs` 12, `--icon-sm` 14, `--icon-md` 16, `--icon-lg` 20, `--icon-xl` 24. Use named sizes in JSX.
- **Visibility icons** — globe / link / eye-off (kept).
- **Tag icon** — Lucide `tag` rendered inside every tag chip (admin + viewer).

### CSS architecture

- **`tokens.css`** — single source of truth for primitives and semantic mappings. Consumed by admin, editor, cover editor.
- **`admin.css`** — admin-only layer (currently structured well; will gain `.btn--ghost`, `--color-surface-hover`/`-active`, missing badge variants).
- **Editors** — keep their own component CSS in `server/editor/src/...`, but their root variables become a thin "dark-only override" of the shared tokens (e.g. force `color-scheme: dark` and pin dark mappings).
- **Viewer pages** — get their own root layout (`ViewerLayout` already exists but currently composes `RootLayout` which serves `app.css`). Phase 4 will split this so the viewer links only `viewer-app.css` (reset + base typography + viewer tokens + page CSS) — admin CSS never reaches public visitors.

### Cleanup / bug fixes folded into Phase 2

- Define `.btn--secondary` (or rename usages to `.btn`).
- Define `.badge--complete` (or stop emitting it).
- Remove references to undefined `var(--space-0)`, `var(--transition-fast)`, `var(--line-height-relaxed)`, `var(--font-family-mono)`.
- Replace ~15 `light-dark(var(--neutral-100), var(--neutral-800))` hovers with `--color-surface-hover`.
- Replace hardcoded blacks (`oklch(0% 0 0 / …)`) with `--color-overlay` in dialog backdrop, video-player background, embed overlay, tag-video-duration.
- Add `--color-warning-border` and `--color-info-border`.

### Open follow-ups (recommendations marked, awaiting confirmation)

- **A.** Private visibility colour. Recommended: `red-700` (muted red) so it doesn't blur with the amber processing statuses. (See "Role assignments → Visibility".)
- **B.** Tag chip rendering. Recommended: 400 bg + 800 text in light; 600 bg + 400 text in dark. (See "Tag palette".)
- **C.** Viewer CSS split — defer the `RootLayout` / `ViewerLayout` refactor to the start of Phase 4 rather than Phase 2.

## Implementation Plan

The server is running on http://127.0.0.1:3000/admin - use the Playwright CLI and skill if you need to look at pages or take screenshots etc.

### Phase 1 - Audit & Planning ✅

- ✅ Audit the current Hono app's CSS — captured in "Current State" above.
- ✅ Identify inconsistencies and opportunities — captured in "Current State → Inconsistencies & opportunities" above.
- ✅ Decide on colour semantics, tokens, role assignments, typography, iconography, CSS architecture — captured in "Design Decisions" above.
- ⏳ Resolve open follow-ups A / B / C (see end of Design Decisions).

### Phase 2 - Colours, Design Tokens & Base styles  ✅

Express the Design Decisions in code. No visual redesigns beyond colour and token consolidation.

- Rewrite `tokens.css` to source from the brand palette in OKLCH (primitives + semantic mappings + new tokens `--color-surface-hover`, `--color-surface-active`, `--color-overlay`, `--color-warning-border`, `--color-info-border`, `--icon-*` ramp, `--icon-xs/sm/md/lg/xl`).
- Replace the old `--neutral-*` / `--accent-*` / `--tag-*` shapes (in-place since this is single-user code — no backwards-compat).
- Fix the silent-bug references: `var(--space-0)`, `var(--transition-fast)`, `var(--line-height-relaxed)`, `var(--font-family-mono)`.
- Review `reset.css` and `base.css`; keep current bones (they're solid), only adjust where the new tokens require it.
- Update editors (`server/editor/src/styles/editor.css`, `server/editor/src/cover/styles.css`) to consume shared tokens. Force `color-scheme: dark` in both so they ignore light-mode mappings.
- Visually verify both light + dark in the admin (Playwright screenshots OK). Iterate with the user on feel.

### Phase 3 - Consistency & UI Elements/Components

Apply the new tokens consistently and add the missing component pieces. Admin only — viewer is Phase 4.

- **Buttons** — add `.btn--ghost`, drop or define `.btn--secondary`, refactor sidebar-nav / sort-dir / view-toggle / color-picker-option / tag-chip-remove to use `.btn--ghost`. Replace ~15 hand-rolled hover bgs with `--color-surface-hover`.
- **Badges** — define `.badge--complete` (or stop emitting it), wire up the new visibility/status colour assignments.
- **Filter pills** — re-wire `--pill-active-*` to the new badge colours; update tag-filter pills to match the new tag chip rendering.
- **Tag chips** — add the tag icon prefix to every chip (admin + viewer). Pick chip rendering per follow-up B. Converge on one colour-application pattern (inline style OR `--chip-color`).
- **Inputs / textareas / selects** — verify against new tokens; tighten focus ring to use new accent.
- **Tabs / tables / popovers / dialog** — verify against tokens.
- **Selected vs hover** — implement the accent-tinted "selected" state on sidebar nav active, active filter pill, active settings tab, active video tab, promoted thumbnail.
- **Section headings** — apply the new hierarchy (h1/h2/h3) consistently across video detail and settings.
- **Form labels** — kill the uppercase variant; converge on the single label treatment.
- **Icon sizes** — replace ad-hoc `size={…}` props with `--icon-*` tokens (or named constants in JSX).
- **File-type icons** — switch from `--tag-*` to the new `--icon-*` ramp.
- **Spacings** — sweep for ad-hoc px/rem values; consolidate to `--space-*`.
- **Card menu trigger** — keep hidden until card hover (confirmed).

### Phase 4 - Public Facing Pages

Make the public surface feel on-brand and ship it on a separate CSS bundle.

#### 4a — Architecture split (do first)

- Restructure layouts so `ViewerLayout` no longer composes `RootLayout` for CSS purposes. The viewer needs its own root layout that links only `viewer-app.css` (reset + base typography + shared viewer-relevant tokens + `viewer.css`/`embed.css`/`player.css`). Admin CSS must not be served to public visitors.
- `viewer-app.css` is its own entry point — same `@layer` discipline, but its tokens layer is the dark-only subset of the shared tokens. (Implementation choice: dedicated viewer tokens file that imports the brand primitives + locks semantic mappings to the dark side. Avoid duplicating values.)

#### 4b — `/:slug`

- Apply new colours + typography.
- Move the title above the player (per task scope).
- Add Danny's avatar.
- Build a real footer: socials, website, video metadata. On-brand, dark, generous.
- Style the Vidstack player (`player.css` is currently empty). Customise the controls colour, scrubber, time display, fullscreen/pip buttons. Reference Vidstack docs via Context7 when implementing.

#### 4c — `/:slug/embed`

- Style the embedded player to match the main page's player styling.
- Re-verify the pre-play overlay against the new poster images.

#### 4d — `/:tagslug`

- Match the new viewer styling (footer, typography, colours).
- Tag swatch in the header uses the new tag rendering.

### Phase 5 - CSS Review, "Component" Review & Cleanup

Review ALL CSS for inconsistencies, opportunities to clean up etc.

### Phase 6 - Documentation

- Add a `design.md` to `docs/developer` explaining the design system, colours, tokens etc.
- Add any notes/rules to `server/CLAUDE.md` to help keep our design consistent when adding new features.
- Update any other documentation for correctness.
