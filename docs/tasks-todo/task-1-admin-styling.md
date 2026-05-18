# Admin styling — adopt cover editor's design language

We are going to:

1. Update the Hono app's styling to use my brand colours.
2. Update the styling for public-facing pages (video, embed and tag routes) to use my brand colours and generally look a little nicer and more on-brand.

We will also take this opportunity to do any CSS cleanup we can, especially when it comes to fundamental "design system"-ish stuff and consistency of styling accross the whole app.

## Current State

### The Hono admin app

The design of the admin app is generally pretty good, and supports light and dark modes. But the colours are not using my brand palette and we haven't ever given much thought to UI consistency etc.

### The cover editor & Editor

The cover editor's look (`server/editor/src/cover/styles.css`) is the most "on-brand" part at the moment when it comes to colours, because it was developed independantly and then integrated. However, it is a very simple interface with few colours. It is also dark only mode. The video editor already uses siilar colours (`server/editor/src/styles/editor.css`).

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

Both the video editor and cover editor should remain "dark-mode only".

### The public-facing pages

These are dark-mode only and are currently pretty simple. Styling these may also involve styling pars of the Vidstack player. See https://vidstack.io/docs/player/styling/introduction/ and the Vidstack docs on Context7 for reference if needed.

## Brand Colour Palette

### Primary Colours

- Brand Accent - red-500-standard (#FF7369)
- Brand BG Dark - bg-light-700 (#2F3437)
- Brand BG Darker - bg-light-800 (#191919)
- Brand BG Light - 
- Brand BG Lighter - 
- Brand White - #fff
- Brand Black - #191919
- Brand Highlight 1 (Pink) - red-400
- Brand Highlight 2 (Orange) - orange-400
- Brand Highlight 1 (Pink) - red-400

### Full Palette

[insert here]

## Implementation Plan

### Phase 1 - Audit & Planning

- Audit the current hono app's CSS and update the "current state" part of this document with the current colours and where they're used (dark and light mode), text treatments, "UI components", spacing, iconography etc.
- Identify inconsistencies and opportunities to rationalise or consolidate styles while we go.
- Decide on what colours to use for what things and update this doc (collaboratively with the user). We'll need to decide on things like:
  - Basic colours for stuff like BG/FG/secondary/surface/subdued/border etc in light and dark modes.
  - Colour semantics for:
    - Primary actions
    - Secondary actions
    - Visibility (private/unlisted/public)
    - Video Status
    - Dangerous actions (delete/trash etc)
    - Warning/Error/Succes etc
    - "Selected" state
    - In the Video editor: "trim", "cut" and "chapter marker"
  - Colours for icon types in the file browser
  - A suitable list of colour options for tags
- Ensure we're clear on typography. eg stuff like:
  - When do we use a monospace font
  - How to form fields/labels/edit in place things look
  - etc
- Ensure we're clear on iconography and their semantics.


Having decided on this we can update this document and then update the phases below as well as  deciding on any other redesign/refactoring work we want to do.

### Phase 2 - Colours, Design Tokens & Base styles

- Create CSS variables for the colours we need and create/update any other design tokens.
- Look over our CSS reset/base styles to ensure we have the best "base to build on".
- Ensure our tokens are being used appropriatley everywhere.
- Tweak as needed from user feedback until the colours look great in the admin interface in both light and dark mode.

### Phase 3 - Consistency & UI Elements/Components

Ensure we are applying styles consistently in the admin interface, and that they look good. This should probably include:

- Text (incl Headings, URLs etc)
- Inputs & Text areas
- Buttons and their variants
- Dropdowns & menus
- Border radii
- "Selected" or highlighted things
- Tabs, tables etc
- Pills
- Tags (we should add a tag icon everywhere they're shown and differentiate them from other sorts of pills)
- Our use of icons (are they consistent)
- Spacings
- Anything else

### Phase 4 - Public Facing Pages

Work on the public-facing pages to improve their styling. These are always dark mode so we should make use of our colour palette here for backgrounds etc.

#### /:slug

- Update colours
- Update typography for title/description etc
- Tweak layout as needed, perhaps moving title to the top
- Add my avatar somewhere
- Add a proper footer which looks really nice with my socials, website, maybe some metadata about the video etc?
- Style the video player so it looks loveley and is on-brand.

#### /:slug/embed

- Style this video player appropriatley
- Check the overlay still looks good when embedding now that we have poster images

#### /:tagslug

- Similar style changes to the video page (footer etc)
- Etc

### Phase 5 - CSS Review, "Component" Review & Cleanup

Review ALL CSS for inconsistencies, opportunities to clean up etc.

### Phase 6 - Documentation

- Add a `design.md` to `docs/developer` explaining the design system, colours, tokens etc.
- Add any notes/rules to `server/CLAUDE.md` to help keep our design consistent when adding new features.
- Update any other documentation for correctness.
