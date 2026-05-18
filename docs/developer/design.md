# Design system

A reference for adding UI to the admin and public viewer surfaces. The system is small on purpose: a brand palette in OKLCH, a thin layer of semantic tokens, and a handful of component classes. Source of truth for tokens is `server/public/styles/tokens.css` — everything else consumes via `var(--…)`.

## Where things live

- `server/public/styles/tokens.css` — primitives + semantic mappings. Single source of truth for colour, type, spacing, motion.
- `server/public/styles/reset.css`, `base.css`, `components.css` — element + foundation layer styles.
- `server/public/styles/app.css` — admin entry. Imports reset + tokens + base + components into ordered `@layer`s. Linked by `RootLayout`/`AdminLayout`.
- `server/public/styles/admin.css` — admin-only component layer. Linked separately by `AdminLayout`'s head slot (so it's not served to public visitors).
- `server/public/styles/viewer-app.css` — public viewer entry. Imports reset + tokens + base + viewer + player. Linked by `ViewerLayout` (video + tag pages).
- `server/public/styles/embed-app.css` — embed entry. Reset + tokens + base + embed + player.
- `server/public/styles/viewer.css`, `embed.css`, `player.css` — page-/role-specific styles imported by the viewer/embed entries.
- `server/editor/src/styles/editor.css` and `server/editor/src/cover/styles.css` — Vite-bundled editor styles. They consume the shared admin tokens via local `--bg`/`--panel-bg`/`--text`/`--accent` aliases (so the editor's component CSS doesn't need rewriting). Editor pages also load `app.css` so the brand tokens resolve.

Admin pages get `app.css` + `admin.css`. Public viewer pages get `viewer-app.css`. The embed page gets `embed-app.css`. Admin CSS never reaches public visitors.

## Layers

`app.css` declares `@layer reset, tokens, base, components, admin, utilities;`. Viewer/embed entries declare an equivalent order with `viewer`/`embed`/`player` in place of `admin`. Selectors live inside `:where()` in reset.css to keep cascade priority pure layer-order.

## Colours

All colour values are expressed in OKLCH. Brand hex values are wrapped in `oklch(from #hex l c h)` so downstream `color-mix(in oklch, …)` and `oklch(from var(--c) …)` calls compose cleanly.

### Brand palette (primitives)

Eight hues plus grey, each in six lightness stops: `-800` (darkest) → `-300` (lightest). The `-500` stop is the canonical brand tone. Variables follow `--brand-<hue>-<step>`.

- Hues: `pink`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `brown`, `grey`.
- Coral red-500 (`#FF7369`) is the brand accent.
- Plus `--brand-white`, `--brand-black`, `--brand-bg-light` (white), `--brand-bg-lighter` (off-white surface), `--brand-bg-dark` (`#2F3437`), `--brand-bg-darker` (`#191919`).

Use brand tokens directly only inside `tokens.css` itself. Component code should always consume semantic tokens.

### Semantic tokens

Dark-mode values via `light-dark(light, dark)`.

Surfaces / text / borders:

| Token | Use |
| --- | --- |
| `--color-bg` | Page background |
| `--color-surface` | Sidebar, card surfaces, list headers |
| `--color-surface-hover` | Soft elevation on hover (single token, replaces the old `light-dark(neutral-100, neutral-800)` pattern) |
| `--color-surface-active` | Pressed state |
| `--color-border` | All borders |
| `--color-fg` | Primary text |
| `--color-fg-muted` | Secondary text, idle icons, placeholders |

Accent:

| Token | Use |
| --- | --- |
| `--color-accent` | Coral. Focus rings, links, filled primary CTAs |
| `--color-accent-hover` | Filled-primary hover |
| `--color-accent-fg` | Text on filled accent buttons |
| `--color-accent-bg` | Pre-mixed ~12% coral tint for "selected" backgrounds |
| `--color-accent-bg-strong` | ~22% coral tint for hover-of-selected |

Status families (each with `-bg` and `-border` variants):

| Family | Use |
| --- | --- |
| `--color-danger*` | Vibrant red — destructive actions, recording, errors |
| `--color-warning*` | Orange/amber — healing, processing, deleting, warning meta-pills |
| `--color-success*` | Green — declared, used sparingly (active API key, "new token" banner) |
| `--color-info*` | Blue — public visibility, "edited" badge |
| `--color-restricted*` | Muted red (red-700) — private visibility, failed status |

Plus:

- `--color-overlay` (0% black @ 0.5) and `--color-overlay-strong` (0.75) — dialog backdrops, video duration overlays, embed pre-play scrim.

### Tag palette

User-pickable hues for tag chips. Each hue declares three vars:

- `--tag-<hue>` — solid swatch (= brand `-500`)
- `--tag-<hue>-bg` — chip background (`light-dark(brand-<hue>-400, brand-<hue>-600)`)
- `--tag-<hue>-fg` — chip text (`light-dark(brand-<hue>-800, brand-<hue>-400)`)

Available hues: `pink`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `brown`, `grey`. The canonical list lives in `TAG_COLORS` in `src/db/schema.ts`.

### Icon ramp

Separate from the tag palette. Used by `FileTypeIcon` to colour-code file-type icons in the file browser. Names describe the role; values come from brand hues:

- `--icon-folder` (blue), `--icon-video` (purple), `--icon-segment` (purple-700), `--icon-playlist` (green), `--icon-config` (orange), `--icon-data` (yellow), `--icon-image` (pink), `--icon-audio` (brown), `--icon-text` (fg-muted)

Keeping the icon ramp distinct means a tag colour can be renamed without silently re-skinning the file browser.

## Typography

- `--font-sans` system stack — used for everything except slugs, IDs, file paths, log timestamps, key tokens, inline `<code>`.
- `--font-mono` system stack — used for the above.
- Type scale: `--font-size-xs` (0.75rem) → `--font-size-2xl` (2rem) in five stops, ~1.2 ratio.
- Weights: `--font-weight-normal` 400, `--font-weight-medium` 500, `--font-weight-bold` 700.
- Line heights: `--line-height-tight` 1.15, `--line-height-normal` 1.5, `--line-height-relaxed` 1.75.

Heading hierarchy:

- `h1` — page title (`--font-size-xl` bold).
- `h2` — major section header (`--font-size-lg` bold). Reserved for future use.
- `h3` — inline sub-section (`--font-size-sm` medium `--color-fg-muted`). Used for "Description", "Tags", "Notes", API key sub-sections, etc.

Form labels and micro section labels share one treatment: `--font-size-xs` medium `--color-fg-muted`, no uppercase, no letter-spacing. Applies to `.label`, `.tag-edit-label`, `.filter-group-label`, `.keys-header`.

## Spacing, radii, motion, shadows

- Spacing: `--space-0` through `--space-8` (0 → 4rem, ~doubling).
- Radii: `--radius-sm` 0.25rem, `--radius-md` 0.5rem, `--radius-lg` 1rem, `--radius-full` (pill). Editor overrides locally with 4/6/8 px.
- Motion: `--duration-fast` 120ms, `--duration-normal` 200ms, `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`. `--transition-fast` is a shorthand for `var(--duration-fast) var(--ease-out)`.
- Shadow: `--shadow-md` only (one elevation token is enough today).

## Icons

Lucide, inlined as SVG. Two sets:

- `server/src/views/admin/components/Icons.tsx` — admin (file types, visibility, actions, etc.). Larger; only loaded on admin pages.
- `server/src/views/viewer/icons.tsx` — small set for public pages (clock, calendar, tag, settings, RSS).

Size scale (px): `--icon-xs` 12, `--icon-sm` 14, `--icon-md` 16, `--icon-lg` 20, `--icon-xl` 24. JSX currently passes numeric `size` props that match these.

## Components

All admin components live in `server/public/styles/admin.css`.

### Buttons

- `.btn` — default outline. Neutral border, surface bg, fg text.
- `.btn--primary` — filled coral.
- `.btn--ghost` — transparent, fg-muted → fg + `--color-surface-hover` on hover. Use for quiet affordances (hover-revealed edit triggers).
- `.btn--sm` — smaller padding, xs font.
- `.btn--icon` — square (aspect 1), no padding, muted icon → fg on hover. Use for compact toolbar icon buttons.
- `.btn--danger` — outline red.
- `.btn--danger-solid` — filled red.
- `.btn-icon-delete` — 28×28 square, filled `--color-danger`, white icon. Reusable. The thumbnail picker overlays it on the candidate and reveals on hover; standalone consumers (trash card) use it always-visible.

### Badges + tag chips

- `.badge` — pill (`--radius-full`), 12px font, semantic colour by modifier (`--public`, `--private`, `--recording`, `--healing`, `--processing`, `--deleting`, `--failed`, `--unlisted`, `--edited`). No `--complete` modifier — complete status is meant to be the boring/hidden default.
- `.tag-chip` — same proportions as `.badge` but `--radius-md` (squarer) so tags read as a distinct shape. Always prefixed with the Lucide `tag` icon. Background + text colour set via the `--tag-<hue>-bg`/`-fg` variables, passed as inline style for the dynamically-picked tag colour.

### Filter pills

`.filter-pill` is a `<label>`-wrapped radio. Its checked state uses `--pill-active-color/-bg/-border` — semantic modifiers (`--public`, `--private`, etc.) override these. Default checked state (no modifier) is coral-tinted (`--color-accent-bg` + accent border/text).

### Selected vs hover

- **Selected** (sidebar nav active, default filter pill active, view toggle active, promoted thumbnail) — `--color-accent-bg` background + `--color-accent` text/border.
- **Hover** (cards, list rows, buttons) — `--color-surface-hover` background.

Tabs (settings, video) use a coral border-bottom on the active tab instead of the accent-tinted background pattern — both are valid "selected" expressions.

### Forms

- `.input` — single style for text, textarea, select. Focus ring uses `--color-accent`.
- `.label`, `.tag-edit-label`, `.filter-group-label`, `.keys-header` — share the micro-label treatment described above.

### Editable fields

`.editable-field` family wraps an inline value with a hover-revealed Edit button (`.editable-trigger`, which uses `.btn--ghost`). Click → swaps to `.editable-field--editing` form with Save / Cancel.

### Card menu trigger

`.video-card-menu-btn` on grid cards is hover-revealed (opacity 0 → 1 on card hover). Intentional — keeps the cards clean. Trash mode replaces the menu with always-visible Restore + `.btn-icon-delete`.

## Editor surfaces (cover + video)

Dark-mode only. Force `color-scheme: dark` at `:root` so `light-dark()` resolves to dark values everywhere. Local `--bg`/`--panel-bg`/`--text`/`--accent`/`--accent-fg` aliases over the shared brand tokens so existing component rules don't need to change. Local radius scale (4/6/8 px) overrides the shared `--radius-sm/md/lg` in the editor scope.

Editor semantic colours:

- Chapter markers → `--brand-orange-500` family.
- Cut / destructive actions → `--brand-red-*` family.
- Suggestion-band / accept-all → `--brand-yellow-*` family.
- Commit button → `--color-accent` + `--color-accent-hover`.

## Viewer + embed surfaces

Dark-mode only via `color-scheme: dark` on `body.viewer` and `body.embed`. Viewer-specific tokens (`--viewer-bg`, `--viewer-fg`, `--viewer-title`, `--viewer-description`, `--viewer-muted`, `--viewer-border`, `--viewer-link`, `--viewer-link-hover`) compose the shared brand palette.

The Vidstack player is themed via its own CSS variables (`--media-*`, `--video-*`) in `player.css` — coral brand, white controls, soft surface fills.

## Adding new UI — rules of thumb

1. **Consume semantic tokens.** Avoid touching brand primitives in component code; reach for `--color-*` and `--tag-*-bg/fg`. Brand primitives are fine inside `tokens.css`, viewer-only files, and editor-only files where the dark-only context is locked.
2. **Reuse existing classes.** `.btn`, `.badge`, `.tag-chip`, `.meta-pill`, `.input`, `.label`, `.btn--ghost`, `.btn-icon-delete` — before adding a new class, check whether one of these already covers the need.
3. **Selected state = accent tint.** Hovered transient state = `--color-surface-hover`. Don't conflate them.
4. **Icons should already exist.** Pick from `admin/components/Icons.tsx`; if you need a new one, follow the existing `<Svg>` wrapper. Match the size to the icon scale (12/14/16/20/24).
5. **Don't redefine `light-dark()` patterns inline.** Use `--color-surface-hover`/`-active`, not `light-dark(var(--brand-grey-400), var(--brand-grey-700))` in a component.
6. **Tag chips vs badges.** Badges describe *system-assigned state* (visibility, status). Tag chips describe *user-picked labels*. Use the right component — they have different border radii deliberately.
7. **Hex / rgba literals are a code smell.** Pure black (`#000` for video letterbox) and `rgba()` in box-shadows are the only legitimate exceptions.

## File-level conventions

- CSS uses modern features freely: `@layer`, `light-dark()`, `color-mix(in oklch, …)`, `oklch(from <c> …)`, nesting, `:has()`, container queries, `field-sizing`, native `<dialog>`/`popover`. All Baseline — the only target is macOS 26 + current Chrome/Safari/Firefox.
- No CSS preprocessor. Vanilla CSS plus `@import` cascade-layered through `app.css` / `viewer-app.css` / `embed-app.css`.
- Static asset URLs run through `staticUrl()` for cache-busting; CSS `@import` paths are rewritten at startup with the same hash. Cache `/admin/*` is bypassed at the CDN; everything else is cached aggressively.
