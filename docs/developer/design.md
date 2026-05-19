# Design system

Vanilla CSS, expressed through three layers of CSS custom properties (brand → semantic → consumed), composed into per-surface bundles via `@layer`. The single source of truth for token *values* is `server/public/styles/tokens.css`. This doc is the source of truth for *how to use them* and *which class does what*.

This file is meant to be loaded by both human readers (overview + reasoning) and AI coding agents (exact token names, class names, file paths, anti-patterns, recipes). Class and token names are in `code` formatting so they're greppable.

---

## At a glance

A cheatsheet for fast lookup. Each row maps an intent to the class/token to reach for. Details below.

| Intent | Reach for |
| --- | --- |
| Tokens — source of truth for values | `server/public/styles/tokens.css` |
| Admin component classes | `server/public/styles/admin.css` |
| Public viewer component classes | `server/public/styles/viewer.css` |
| Show user-picked label | `.tag-chip` + `<IconTag>` prefix |
| Show system state (visibility, status) | `.badge` + `.badge--<state>` modifier |
| Filter pills | `.filter-pill` + `.filter-pill--<state>` modifier |
| Persistent "selected" treatment | `--color-accent-bg` background + `--color-accent` text/border |
| Transient "hover" treatment | `--color-surface-hover` background |
| Default action button | `.btn` |
| Primary CTA | `.btn .btn--primary` |
| Quiet / hover-revealed action | `.btn .btn--ghost` |
| Compact button | append `.btn--sm` |
| Outline destructive | `.btn .btn--danger` |
| Filled destructive | `.btn .btn--danger-solid` |
| Square red icon-only delete | `.btn-icon-delete` |
| File-type icon colour | `--icon-{folder,video,segment,playlist,config,data,image,audio,text}` |
| Dialog / video scrim | `--color-overlay` (0.5) or `--color-overlay-strong` (0.75) |
| Form field | `.input` for the control, `.label` for its label |
| Inline editable value | `.editable-field` family + `.editable-trigger` (ghost) |
| Adding a list of cards | mirror the dashboard's `.video-card` + `[data-view="grid"\|"table"]` switch |

---

## How the system is structured

### Three layers of tokens

1. **Brand primitives** — `--brand-<hue>-<step>` (and `--brand-white`/`-black`/`-bg-*`). The literal palette. Defined in `tokens.css`. **Component code does not consume these directly.**
2. **Semantic tokens** — `--color-*`, `--tag-*-bg`/`-fg`, `--icon-*`, `--space-*`, `--radius-*`, `--font-*`, etc. Composed from primitives via `light-dark()` and `color-mix()` in `tokens.css`. **Component code consumes these.**
3. **Consumer styles** — admin.css, viewer.css, embed.css, player.css, editor CSS. Reference semantic tokens only.

This separation is load-bearing. Changing one brand hue shifts dependent semantics uniformly. Renaming a tag colour doesn't silently re-skin file-type icons (they're on a separate ramp).

### Stylesheet bundles per surface

| Surface | Entry | Composes |
| --- | --- | --- |
| Admin pages | `app.css` linked by `RootLayout` + `admin.css` linked by `AdminLayout`'s head slot | reset + tokens + base + components + admin |
| Public viewer (`/:slug`, `/:tagslug`) | `viewer-app.css` (set via `ViewerLayout`'s `stylesheet` prop on `RootLayout`) | reset + tokens + base + viewer + player |
| Embed (`/:slug/embed`) | `embed-app.css` | reset + tokens + base + embed + player |
| Cover + video editors (Vite-bundled SPAs) | their own CSS + a `<link>` to `app.css` (so brand tokens resolve) | editor's own component styles |

Admin component CSS (`admin.css`) is never loaded by public visitors. `RootLayout.stylesheet` defaults to `"styles/app.css"`; viewer/embed override.

### `@layer` order

`app.css`:

```css
@layer reset, tokens, base, components, admin, utilities;
```

Viewer/embed entries declare the equivalent order with `viewer` / `embed` / `player` in place of `admin`. Reset.css selectors are wrapped in `:where()` so cascade priority is determined entirely by layer order, not by selector specificity.

---

## Colour

All colour values resolve to OKLCH. Brand hex inputs are converted via `oklch(from #hex l c h)` so downstream `color-mix(in oklch, …)` and `oklch(from var(--c) …)` calls compose cleanly.

### Brand palette (primitives)

Eight hues plus grey, each in six lightness stops: `-800` (darkest) → `-300` (lightest). The `-500` stop is the canonical brand tone. Variables follow `--brand-<hue>-<step>`.

- Hues: `pink`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `brown`, `grey`.
- Coral red-500 is the brand accent.
- Plus monochrome: `--brand-white`, `--brand-black`, `--brand-bg-light` (page white), `--brand-bg-lighter` (off-white surface), `--brand-bg-dark`, `--brand-bg-darker` (page black).

Brand primitives are referenced only inside `tokens.css`, viewer-only files where the dark-only context is locked, and editor-only files. Component code consumes semantic tokens.

### Semantic tokens

All semantic tokens use `light-dark()` so they resolve correctly in either colour scheme.

**Surfaces, text, borders:**

| Token | Role |
| --- | --- |
| `--color-bg` | Page background |
| `--color-surface` | Sidebar, card surfaces, list headers |
| `--color-surface-hover` | One-step elevation on hover (transient state) |
| `--color-surface-active` | Two-step elevation on press/long-active |
| `--color-border` | All borders |
| `--color-fg` | Primary text |
| `--color-fg-muted` | Secondary text, idle icons, placeholders |

**Accent (coral, brand):**

| Token | Role |
| --- | --- |
| `--color-accent` | Focus rings, links, filled-primary fill |
| `--color-accent-hover` | Filled-primary hover |
| `--color-accent-fg` | Text on filled-accent buttons |
| `--color-accent-bg` | Pre-mixed accent tint for "selected" backgrounds |
| `--color-accent-bg-strong` | Deeper accent tint for hover-of-selected |

**Status families** (each declares `*`, `*-bg`, `*-border`):

| Family | Role |
| --- | --- |
| `--color-danger*` | Vivid red — destructive actions, the recording status, errors |
| `--color-warning*` | Orange — in-progress background states (healing, processing, deleting), warning meta-pills |
| `--color-success*` | Green — sparing use (active API key, "new key" banner) |
| `--color-info*` | Blue — public visibility, "edited" badge |
| `--color-restricted*` | Muted red (red-700) — private visibility, failed status |

**Overlays:**

- `--color-overlay` — 50% black. Dialog backdrops, hover scrims.
- `--color-overlay-strong` — 75% black. Video-duration corner overlays.

### Tag palette

User-pickable hues for tag chips. Each hue declares three variables:

- `--tag-<hue>` — solid swatch colour (the `-500` brand tone).
- `--tag-<hue>-bg` — chip background. In light mode this resolves to brand `-400`; in dark mode to brand `-600`.
- `--tag-<hue>-fg` — chip text colour. In light mode `-800`; in dark mode `-400`.

The canonical list of hue names lives in `TAG_COLORS` (`server/src/db/schema.ts`). Adding a hue: see the recipe below.

Tag chips on dynamic data set background and foreground via inline style:

```jsx
<span
  class="tag-chip"
  style={`background-color: var(--tag-${t.color}-bg); color: var(--tag-${t.color}-fg)`}
>
  <IconTag size={12} />
  {t.name}
</span>
```

For toggleable chips (filter pills, picker toggles) the inline style instead sets `--chip-bg` and `--chip-fg`, which the toggle CSS picks up only when checked:

```jsx
<span
  class="tag-chip"
  style={`--chip-bg: var(--tag-${t.color}-bg); --chip-fg: var(--tag-${t.color}-fg)`}
>
```

### Icon ramp

A separate semantic ramp used by `FileTypeIcon` (`server/src/views/admin/components/Icons.tsx`). Names describe the role; values source from brand hues:

| Token | Used for |
| --- | --- |
| `--icon-folder` | Directories |
| `--icon-video` | `.mp4`, `.mov` |
| `--icon-segment` | `.m4s` (HLS segment) |
| `--icon-playlist` | `.m3u8` |
| `--icon-config` | `recording.json` |
| `--icon-data` | Other `.json` |
| `--icon-image` | `.jpg`, `.png`, `.webp` |
| `--icon-audio` | `.mp3`, `.aac`, `.wav` |
| `--icon-text` | Text/log/markdown, plus unknown extensions |

---

## Typography

### Scale, weights, line heights

| Token | Value |
| --- | --- |
| `--font-size-xs` | 0.75rem |
| `--font-size-sm` | 0.875rem |
| `--font-size-base` | 1rem |
| `--font-size-lg` | 1.125rem |
| `--font-size-xl` | 1.5rem |
| `--font-size-2xl` | 2rem |

Weights: `--font-weight-normal` (400), `--font-weight-medium` (500), `--font-weight-bold` (700).
Line heights: `--line-height-tight` (1.15), `--line-height-normal` (1.5), `--line-height-relaxed` (1.75).

### Heading hierarchy

| Level | Treatment | Used for |
| --- | --- | --- |
| `h1` | `--font-size-xl` bold | Page title |
| `h2` | `--font-size-lg` bold | Major section header |
| `h3` | `--font-size-sm` medium `--color-fg-muted` | Inline sub-section ("Description", "Tags", "Notes", "Recording API Keys") |

### Mono usage

`--font-mono` (system stack starting with SF Mono) for:

- Slugs in admin (`.video-slug`, `.video-card-slug`, `.editable-prefix`, the slug `<input>`)
- Video IDs (`.meta-pill--id`)
- File paths in the file browser
- Timestamps in event logs
- API key / admin token values (`.keys-token-value`)
- Inline `<code>` in rendered markdown

Sans is used for everything else, including titles, descriptions, button labels, badge text.

### Form labels and micro section labels

One shared treatment: `--font-size-xs` / `--font-weight-medium` / `--color-fg-muted`, no uppercase, no letter-spacing. Applies to `.label`, `.tag-edit-label`, `.filter-group-label`, `.keys-header`.

---

## Spacing, radii, motion, shadow

| Token group | Members |
| --- | --- |
| Spacing (4px → 64px) | `--space-0` through `--space-8` |
| Radii | `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (16px), `--radius-full` (pill) |
| Motion | `--duration-fast` (120ms), `--duration-normal` (200ms), `--ease-out`, `--transition-fast` (shorthand for `var(--duration-fast) var(--ease-out)`) |
| Shadow | `--shadow-md` |

The editor surfaces locally override `--radius-sm/md/lg` to a tighter 4/6/8 px scale (set in `editor.css`'s `:root`).

---

## Icons

### Where SVGs live

- `server/src/views/admin/components/Icons.tsx` — the admin set (file types, visibility, ellipsis, calendar, clock, settings, scissors, etc.). Loaded only on admin pages.
- `server/src/views/viewer/icons.tsx` — the lean public set (clock, calendar, tag, settings gear, RSS). Loaded by viewer/embed pages.

Both files use the same `<Svg>` wrapper that sets `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap/linejoin="round"`, `aria-hidden="true"`. Adding a new icon: add a paste of the Lucide SVG paths inside the wrapper.

### Size scale

`--icon-xs` 12px, `--icon-sm` 14px, `--icon-md` 16px, `--icon-lg` 20px, `--icon-xl` 24px. JSX usage passes numeric `size` props from this set.

| Size | Typical use |
| --- | --- |
| 12 | Inline pill icons (badges, filter pills, grid-card meta) |
| 14 | Action-row buttons (`.btn--sm`), slug editor tools, popover items, meta pills, viewer meta row |
| 16 | Toolbar buttons (sort, view toggle), upload CTA, file-row icons |
| 20 | Sidebar nav, logout |
| 24 | (reserved for large UI affordances) |

---

## Components

All admin component classes live in `server/public/styles/admin.css`. Viewer-specific classes in `server/public/styles/viewer.css`.

### Buttons

| Class | Role |
| --- | --- |
| `.btn` | Default outline. Surface bg, fg text, neutral border |
| `.btn--primary` | Filled coral |
| `.btn--ghost` | Transparent, fg-muted → fg + `--color-surface-hover` on hover. Use for quiet affordances (hover-revealed edit triggers, hands-off toolbar buttons inside a bordered container) |
| `.btn--sm` | Smaller padding, xs font |
| `.btn--icon` | Square (aspect 1), no padding, muted icon → fg on hover. For toolbar icon buttons with their own border |
| `.btn--danger` | Outline red |
| `.btn--danger-solid` | Filled red |
| `.btn-icon-delete` | 28×28 square, filled `--color-danger`, white icon. Reusable. Inside `.thumbnail-candidate` it's positioned absolute and hover-revealed; elsewhere (e.g. the trash card) it sits inline and is always visible |

Combine modifiers freely: `class="btn btn--sm btn--ghost"`, `class="btn btn--sm btn--icon"`, etc.

### Badges, tag chips, meta pills

Three families, deliberately distinct shapes:

| Component | Shape | Role |
| --- | --- | --- |
| `.badge` | `--radius-full` pill | System-assigned state. Modifiers carry semantic colour: `--public`, `--unlisted`, `--private`, `--recording`, `--healing`, `--processing`, `--deleting`, `--failed`, `--edited`. No `--complete` modifier (complete is the boring default and shouldn't draw the eye) |
| `.tag-chip` | `--radius-md` (squarer) | User-picked label. Always prefixed with the Lucide `tag` icon. Background + text colour come from `--tag-<hue>-bg`/`-fg`, set inline |
| `.meta-pill` | No background by default, just icon + text + `tabular-nums` | Inline metadata items: duration, date, dimensions, file size, camera/mic name. Variants: `--warning` (uses `--color-warning`), `--id` (mono + half-opacity, click-to-copy) |

The badge/tag-chip distinction is deliberate — they share padding and font but differ in radius so they read as distinct categories when shown side-by-side.

### Inputs and forms

- `.input` — single style for `<input>`, `<textarea>`, `<select>`. Focus ring uses `--color-accent`. Select elements get a custom chevron via embedded SVG, with a Chrome 135+ `appearance: base-select` upgrade path for keyboard-navigable picker styling.
- `.label`, `.tag-edit-label`, `.filter-group-label`, `.keys-header` — shared micro-label treatment (see Typography).
- `.form-field` — vertical stack of label + input. `.form-error` — danger-coloured callout for validation.

### Filter pills

`.filter-pill` is a `<label>` wrapping a hidden radio input. Active (`input:checked`) state pulls colour from CSS variables `--pill-active-color`/`-bg`/`-border`. Modifiers (`.filter-pill--public`, `.filter-pill--private`, etc.) set those vars to the matching `--color-*` family. Pills with no modifier (the default "All") default to `--color-accent-bg` + accent border.

Tag-filter pills (`.filter-tag-pill`) follow the same pattern but the active colour comes from `--chip-bg` / `--chip-fg` set inline per tag hue.

### Editable fields

`.editable-field` wraps an inline display value plus a hover-revealed `.editable-trigger` (which is just `.btn .btn--sm .btn--ghost`). Clicking the trigger swaps the display for `.editable-field--editing` — an inline form with Save / Cancel. Variants: `--inline` (single-row), `--block` (textarea, stacked), and field-specific input modifiers like `.editable-input--title` and `.editable-input--slug`.

### Tabs

`.settings-tabs` and `.video-tabs` share the same pattern: a horizontal strip with a bottom border. Active tab gets `border-bottom: 2px solid var(--color-accent)`. Tabs use the underline-as-accent affordance rather than the accent-tinted background — both are valid "selected" expressions.

### Cards and list rows

The dashboard's video cards (`.video-card`) live inside `<div data-view="grid">` or `<div data-view="table">`. The DOM is identical; CSS swaps the layout via attribute selectors (`[data-view="grid"] .video-card { … }` vs `[data-view="table"] .video-card { … }`). Use this same pattern for any list that needs grid/table parity.

### Dialogs and popovers

- `.file-preview-dialog` is a native `<dialog>` with `::backdrop`. Backdrop uses `--color-overlay`.
- `.video-card-popover` is a native `popover="auto"` element anchored to its trigger via implicit popovertarget anchoring (`position-area: block-end inline-end` + `position-try-fallbacks`). Inside it, `.popover-item` styles menu rows; add `.popover-item--danger` for destructive actions.

---

## Recurring patterns

### Selected vs hover

- **Selected** (persistent toggled state): `--color-accent-bg` background + `--color-accent` text/border. Applied on: sidebar nav `[aria-current="page"]`, default filter pill `:checked`, `.view-toggle-btn.active`, `.thumbnail-candidate--promoted`. Tabs are an exception — their "selected" expression is a bottom-border accent.
- **Hover** (transient interaction): `--color-surface-hover` background. Applied on: cards, list rows, buttons, ghost variants.

Never use the hover treatment for a persistent state — they need to be visually distinct.

### `light-dark()` + `color-scheme`

- The default top-level `:root` declares `color-scheme: light dark` so `light-dark()` follows the user's preference.
- Pages that should be dark regardless (viewer, embed, both editors) set `color-scheme: dark` on their `<body>` or `:root`. This forces `light-dark()` to resolve to the dark branch everywhere, including native form controls and scrollbars.
- Components never check `prefers-color-scheme` directly. They consume `--color-*` tokens; the tokens do the branching.

### Hover-revealed affordances

Two affordances are intentionally hidden until the parent is hovered:

- `.video-card-menu-btn` (the ⋯ on dashboard cards) — `opacity: 0`, becomes visible on `.video-card:hover` or `:focus-visible`.
- `.btn-icon-delete` inside `.thumbnail-candidate` — same pattern.

The bare `.btn-icon-delete` outside that context is always visible.

### Layout swap via `[data-view]`

The dashboard switches grid ↔ table via a `data-view` attribute on the list container. CSS attribute selectors then apply the layout. Use this when the same data should support multiple layouts without DOM duplication.

### Empty states

`.empty-state` — a single muted line for "no results" / "no events yet". `.tag-empty` is the viewer-page variant with centred padding.

---

## Per-surface notes

### Admin

Sidebar shell (`body.admin`): CSS grid, `3.5rem` icon-only sidebar + `1fr` main. Sidebar items use `--color-fg-muted` at rest, `--color-fg` on hover, and the accent-tinted selected treatment for `[aria-current="page"]`. The login page sets `body.admin--login` to drop the grid in favour of a centred form.

### Public viewer and embed

Dark-mode only. Both layouts set `color-scheme: dark` on `<body>` so semantic tokens lock to the dark branch and native controls follow.

Viewer-specific token aliases (`--viewer-bg`, `--viewer-fg`, `--viewer-title`, `--viewer-description`, `--viewer-muted`, `--viewer-border`, `--viewer-link`, `--viewer-link-hover`) compose the shared brand palette. Components on the viewer side can consume these directly without going through `--color-*`.

The shared footer (`SiteFooter`) lives at `server/src/views/viewer/SiteFooter.tsx`. It pulls avatar + tagline + socials from `siteConfig` (`server/src/lib/site-config.ts`).

### Editors (video + cover)

Dark-mode only via `color-scheme: dark` at `:root`. They load `app.css` (so brand tokens resolve) and add their own component CSS on top. The pre-existing token names `--bg`, `--panel-bg`, `--panel-bg-input`, `--panel-border`, `--text`, `--text-dim`, `--accent`, `--accent-fg` are kept as local aliases over the shared brand palette so the editor's component rules don't have to change.

Editor-local radius scale (4/6/8 px) overrides the global `--radius-sm/md/lg` inside the editor scope.

Editor semantic colours:

- Chapter markers → `--brand-orange-500` family.
- Cut / destructive actions → `--brand-red-*` family.
- Suggestion-band + Accept-all → `--brand-yellow-*` family.
- Commit button (the editor's primary action) → `--color-accent` + `--color-accent-hover`.

### Vidstack player

Themed via Vidstack's own CSS custom properties in `server/public/styles/player.css`. The mapping at a glance: `--media-brand` = coral; `--media-controls-color` = white; slider track/fill/thumb tinted accent; `--video-load-button-bg` = coral; tooltips use brand background. A small extra rule keeps the play-icon coral whenever the player is paused.

---

## Rules

1. **Component code consumes semantic tokens.** Reach for `--color-*`, `--tag-*-bg/fg`, `--icon-*`, `--space-*`, `--radius-*`, `--font-*`. Brand primitives are fine inside `tokens.css`, inside viewer-only files, and inside editor-only files. Anywhere else, they're a code smell.
2. **Reuse existing classes before adding new ones.** `.btn`, `.badge`, `.tag-chip`, `.meta-pill`, `.input`, `.label`, `.btn--ghost`, `.btn-icon-delete` cover most needs.
3. **One token per state.** Selected → `--color-accent-bg`. Hover → `--color-surface-hover`. Don't reach for `light-dark()` literals inline.
4. **Tag chips vs badges, deliberately.** Badges describe system-assigned state; tag chips describe user-picked labels. They have different border radii on purpose.
5. **Icons are typed.** Pick from the existing set (or add to it). Match the size to the scale.
6. **No hex / `rgba()` literals in component code.** Pure `#000` for video letterbox is the one legitimate exception, plus `rgba(0,0,0,...)` inside `box-shadow` for optical adjustment.
7. **Admin styles stay in admin files.** `admin.css` is the admin layer. Never add admin component classes to `viewer.css` or `embed.css`.

---

## Anti-patterns

Examples of what *not* to do, with the right way alongside.

| Don't | Do | Why |
| --- | --- | --- |
| `background: light-dark(var(--brand-grey-400), var(--brand-grey-700))` | `background: var(--color-surface-hover)` | Hand-rolling the pattern duplicates token logic and drifts |
| `color: #888` or `color: rgba(255,255,255,0.6)` | `color: var(--color-fg-muted)` | Hex/rgba in components bypasses the palette |
| `background: var(--brand-red-500)` (in component CSS) | `background: var(--color-accent)` or `var(--color-danger)` | Primitives don't carry semantics; semantic tokens do |
| `<span class="badge badge--complete">complete</span>` (always rendered) | Don't emit `badge--complete` at all — guard at the call site | Complete is the boring default; rendering a neutral badge for every video adds noise |
| `<span class="tag-chip">tag</span>` (no icon) | `<span class="tag-chip"><IconTag size={12} />tag</span>` | The icon is what distinguishes a tag chip from a badge at a glance |
| `font-size: 0.7rem` for "a bit smaller than xs" | Use `--font-size-xs` (0.75rem) | The scale exists for a reason — break it deliberately if needed and add a comment |
| `padding: 1px var(--space-2)` to make a chip shorter than a badge | Match badge proportions (`--space-1 --space-2`) | Tag chips and badges should line up at the same height |
| `<a class="btn">Edit</a>` for a hover-revealed pencil | `<button class="btn btn--sm btn--ghost editable-trigger">Edit</button>` | Ghost variant exists exactly for this |
| Defining `.thumbnail-candidate__delete` as a one-off | Use `.btn-icon-delete` and scope hover-reveal on the parent | The same red-square delete button is now reusable |

---

## Recipes

### Add a new video status

1. Extend the `status` enum in `server/src/db/schema.ts` (`videos.status`).
2. Add a Drizzle migration: `bun run db:generate` (drizzle-kit will diff).
3. Add `.badge--<status>` and `.filter-pill--<status>` modifiers in `admin.css`, pointing to whichever semantic family fits (most likely `--color-danger`, `--color-warning`, `--color-info`, `--color-success`, or `--color-restricted`).
4. If the status should be hidden by default (like `complete`), guard the badge emission at the call site instead of defining a neutral modifier.

### Add a new tag colour

1. Extend `TAG_COLORS` in `server/src/db/schema.ts`.
2. In `tokens.css`, add the trio: `--tag-<hue>`, `--tag-<hue>-bg`, `--tag-<hue>-fg`. Source from the brand palette (`--brand-<hue>-500`, `--brand-<hue>-400`/`-600`, `--brand-<hue>-800`/`-400`).
3. No JSX changes needed — `style={…var(--tag-${color}-bg)…}` will pick it up.
4. If renaming an existing hue, add a SQL data migration that rewrites stored values: see `drizzle/0011_normalise_legacy_tag_colors.sql` for the pattern.

### Add an icon

1. Find the SVG paths on `lucide.dev`.
2. Paste them inside a `<Svg {...props}>…</Svg>` wrapper in `server/src/views/admin/components/Icons.tsx` (admin) or `server/src/views/viewer/icons.tsx` (public).
3. Export with a `Icon`-prefixed name (admin) or `Icon`-suffixed name (viewer — `ClockIcon`, `TagIcon`, etc., per the existing convention).
4. Use a size from the scale: 12 / 14 / 16 / 20 / 24.

### Add a new admin page

1. Create a route handler in `server/src/routes/admin/`.
2. Render a `.tsx` page that wraps content in `<AdminLayout title="…" activePage="…">`.
3. Use existing component classes from `admin.css`. If you need a new class, add it inside the `@layer admin { … }` block at the bottom of `admin.css`.
4. Section structure: `.page-header` containing the `<h1>` and any header actions, then your content.

### Add a new public-viewer surface

1. Create the page component under `server/src/views/viewer/`.
2. Wrap in `<ViewerLayout>` (it sets `body.viewer` and links `viewer-app.css`).
3. Add page-specific styles to `viewer.css` (or page-specific file imported by `viewer-app.css`).
4. Reuse `SiteFooter` at the bottom.

---

## Modern CSS this codebase leans on

Vanilla CSS only, no preprocessor. The following features are used freely:

- **`@layer`** for cascade discipline; explicit order at the top of each entry stylesheet.
- **`light-dark(light, dark)`** for adaptive colour without media queries.
- **`color-mix(in oklch, …)`** for tints and alpha-blends derived from tokens.
- **`oklch(from <c> l c h)`** to convert hex to OKLCH at parse time or derive a colour from another.
- **CSS nesting** for component rules (no preprocessor).
- **`:has()`** for parent-aware styling.
- **Container queries** when component-level breakpoints make sense.
- **`field-sizing: content`** for textareas that grow with input.
- **`interpolate-size: allow-keywords`** in reset, so `auto` heights animate.
- **`text-wrap: balance`** in reset, on headings.
- **Native `<dialog>` + `::backdrop`** for modals.
- **`popover="auto"` + anchor positioning** (`position-area`, `position-try-fallbacks`) for menus.
- **`color-scheme`** + `light-dark()` for dark-mode lock on public/editor surfaces.
- **`@supports (appearance: base-select)`** to opt into Chrome 135+'s customisable select picker without breaking older engines.

Browser target: a single user on a current macOS / current Chrome, Safari, Firefox. All of the above are Baseline.

---

## File map

| Concern | File |
| --- | --- |
| Token values | `server/public/styles/tokens.css` |
| Reset | `server/public/styles/reset.css` |
| Element-level base styles | `server/public/styles/base.css` |
| Admin entry (foundation) | `server/public/styles/app.css` |
| Admin component classes | `server/public/styles/admin.css` |
| Viewer entry | `server/public/styles/viewer-app.css` |
| Viewer component classes | `server/public/styles/viewer.css` |
| Embed entry | `server/public/styles/embed-app.css` |
| Embed-specific styles | `server/public/styles/embed.css` |
| Vidstack player theming | `server/public/styles/player.css` |
| Editor (video) styles | `server/editor/src/styles/editor.css` |
| Cover editor styles | `server/editor/src/cover/styles.css` |
| Admin icon set | `server/src/views/admin/components/Icons.tsx` |
| Viewer icon set | `server/src/views/viewer/icons.tsx` |
| Shared site footer | `server/src/views/viewer/SiteFooter.tsx` |
| Site metadata + socials | `server/src/lib/site-config.ts` |
| Status/visibility/tag enums | `server/src/db/schema.ts` |
| Static-asset cache busting | `server/src/lib/static-assets.ts` |
| Layouts | `server/src/views/layouts/{RootLayout,AdminLayout,ViewerLayout}.tsx` |
