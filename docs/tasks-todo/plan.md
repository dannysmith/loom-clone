# Research Plan

Read @../requirements.md for context. 

## Overview

10 research tasks, organised into 3 waves. Each wave can be run as parallel independent Claude Code sessions. Later waves benefit from reading the findings of earlier waves.

The goal of this research phase is to put us in the best possible position to make good architectural and product decisions before we start building.

## Tasks

| # | Task | Tier | Wave |
|---|------|------|------|
| 01 | macOS Recording APIs & Desktop App Feasibility | 1 | 2 |
| 02 | Streaming Upload Architecture | 1 | 2 |
| 03 | Cap Codebase Analysis | 1 | 1 |
| 04 | Video Hosting: Self-Hosted vs Managed Services | 1 | 2 |
| 05 | Competitive Landscape & UX Patterns | 1 | 1 |
| 06 | Video Processing & Encoding Pipeline | 2 | 3 |
| 07 | Storage, CDN & Infrastructure Cost Modelling | 2 | 3 |
| 08 | Server & Admin Stack Options | 2 | 3 |
| 09 | Viewer Experience: Delivery, Embedding & Link Previews | 2 | 3 |
| 10 | Open Source Video Platforms & Tools | 3 | 1 |

## Dependency Map

```
Wave 1 (no dependencies)        Wave 2 (reads Wave 1)         Wave 3 (reads Wave 2)
─────────────────────────        ─────────────────────         ─────────────────────

┌─────────────────────┐          ┌─────────────────────┐
│ 03 Cap Codebase     │─────────▶│ 01 macOS APIs       │
│    Analysis         │─────┐    └─────────────────────┘
└─────────────────────┘     │
                            │    ┌─────────────────────┐
                            ├───▶│ 02 Streaming Upload  │
                            │    └─────────────────────┘
                            │                                  ┌─────────────────────┐
                            │    ┌─────────────────────┐  ┌──▶│ 06 Video Processing  │
                            ├───▶│ 04 Build vs Buy     │──┤   └─────────────────────┘
┌─────────────────────┐     │    │                     │  │   ┌─────────────────────┐
│ 10 Open Source      │─────┘    └─────────────────────┘  ├──▶│ 07 Storage/CDN/Cost  │
│    Platforms        │                                   │   └─────────────────────┘
└─────────────────────┘                                   │   ┌─────────────────────┐
                                                          ├──▶│ 08 Server Stack      │
┌─────────────────────┐                                   │   └─────────────────────┘
│ 05 Competitive      │──────────────────────────────┐    │   ┌─────────────────────┐
│    Landscape        │                              └────┼──▶│ 09 Viewer Experience │
└─────────────────────┘                                   │   └─────────────────────┘
                                                          │
                                                          │   (09 also reads 05)
```

## Execution Plan

### Wave 1 — Independent Research (3 tasks in parallel)

No dependencies. These tasks research what already exists and produce context that sharpens everything downstream.

- **Task 03 (Cap Codebase Analysis)** — The most important task to complete early. Cap has attempted to solve most of the same problems we face. Findings from this directly inform Tasks 01, 02, and 04. This is on the critical path.
- **Task 05 (Competitive Landscape)** — Independent product research. Studies UX patterns across Loom, Cap, Screen Studio, Tella, and others. Findings inform the viewer experience research in Wave 3.
- **Task 10 (Open Source Platforms)** — Survey of open-source video platforms, players, and tools. Quick task. Findings feed into the build-vs-buy evaluation in Wave 2.

**Output**: Research documents in `docs/research/` for each task. These should be available for Wave 2 sessions to read.

### Wave 2 — Core Technical Feasibility (3 tasks in parallel, after Wave 1)

These are the foundational technical research tasks. They *can* run without Wave 1 findings, but they're meaningfully sharper with them — particularly the Cap analysis, which provides concrete answers to questions these tasks would otherwise research from first principles.

- **Task 01 (macOS Recording APIs)** — Reads Task 03 findings to understand what capture APIs Cap uses and what problems they hit. Then researches ScreenCaptureKit, AVFoundation, PiP compositing, and mode switching.
- **Task 02 (Streaming Upload Architecture)** — Reads Task 03 findings to understand Cap's upload mechanism. Then researches HLS segmentation, progressive upload, and the "instant URL" problem in depth.
- **Task 04 (Build vs Buy)** — Reads Task 03 findings (what does self-hosting actually look like in practice?) and Task 10 findings (any open-source options worth considering?). Evaluates Mux, Cloudflare Stream, Bunny Stream vs self-hosted. **This is the single most important architectural decision** — its outcome determines the scope of all Wave 3 tasks.

**Output**: Research documents in `docs/research/`. Task 04's recommendation is the key input for Wave 3.

### Wave 3 — Architecture-Dependent Research (4 tasks in parallel, after Task 04)

These tasks' scope is shaped by the build-vs-buy decision from Task 04. Running them before that decision is made means doing two analyses (managed vs self-hosted) instead of focusing on the chosen direction.

- **Task 06 (Video Processing & Encoding)** — If self-hosting: deep dive into FFmpeg, HLS renditions, codecs, hardware acceleration. If using a managed service: focus on what format the desktop app should produce and any client-side encoding considerations.
- **Task 07 (Storage, CDN & Cost Modelling)** — Detailed cost modelling for the architectural approach recommended by Task 04. Validates or challenges Task 04's cost estimates with concrete numbers.
- **Task 08 (Server & Admin Stack)** — Server scope depends on Task 04. A managed video service means a thin metadata layer. Self-hosted means a thicker server with processing pipeline.
- **Task 09 (Viewer Experience)** — Reads Task 04 (delivery approach) and Task 05 (competitive video pages) to research video page architecture, embedding, OG tags, oEmbed, and link previews.

**Output**: Research documents in `docs/research/`.

## Critical Path

The sequence that determines the minimum total timeline:

```
Task 03 (Cap Analysis) → Task 04 (Build vs Buy) → Tasks 06/07/08 (implementation details)
```

Task 03 is the enabler. Task 04 is the fork in the road. Everything after Task 04 is scoped by its decision.

## After Research

Once all 10 research tasks are complete, the findings should be synthesised into an architectural decision document that:

1. Confirms the build-vs-buy decision with full context.
2. Defines the technical architecture across all three layers (desktop app, server, delivery).
3. Identifies remaining unknowns that can only be resolved by prototyping.
4. Proposes a build plan.

This synthesis is a separate task, not one of the 10 research tasks.

## Notes

- **Collapsing waves**: If speed matters more than research quality, Waves 1 and 2 can be merged into a single wave of 6 parallel tasks. Tasks 01, 02, and 04 will still produce useful research without Cap analysis — they just won't benefit from Cap's lessons. The biggest loss is Task 04 making the build-vs-buy recommendation without seeing what self-hosting looks like in Cap's codebase.
- **Task 04 ↔ Task 07 circular dependency**: Task 04 needs rough cost estimates to make its recommendation. Task 07 needs Task 04's recommendation to know what to model in detail. Resolution: Task 04 does rough cost comparison as part of its analysis. Task 07 then validates with detailed numbers and flags if the economics don't hold up.
- **Research output location**: Each completed task should produce a document in `docs/research/`, named to match the task (e.g. `docs/research/01-macos-recording-apis.md`). The corresponding task file in `docs/tasks-todo/` can then be moved to `docs/tasks-done/`.
