# Task: Miscellaneous Things

## Phase 1 - Full Review of Serverside App [DONE]

And finally, let's conduct a full comprehensive review of all of the server side code. Let's clean up anything that needs cleaning, do any re-architecting, analyze and review it for code quality, architectural quality, and best practices, as well as any obvious issues with performance etc.

## Phase 2 - macOS App XCode Errors [DONE]

When I build the macOs app in XCode I get the following errors and warnings. Let's please make sure that we have things set up so that either we've addressed these errors and warnings if they are things we actually need to address, Or if they are not because they are either stale or are showing up in X code when they shouldn't be. Let's work out the best way of preventing that so that X code actually only shows us warnings and errors that we probably care about. 

```
LoomClone
/Users/danny/dev/loom-clone/app/LoomClone/Helpers/CircleMaskGenerator.swift
/Users/danny/dev/loom-clone/app/LoomClone/Helpers/CircleMaskGenerator.swift:8:40 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/HealAgent.swift
/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/HealAgent.swift:111:13 Cyclomatic Complexity Violation: Function should have complexity 15 or less; currently complexity is 16 (cyclomatic_complexity)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/HealAgent.swift:284:24 Non-optional String -> Data Conversion Violation: Prefer non-optional `Data(_:)` initializer when converting `String` to `Data` (non_optional_string_data_conversion)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift
/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift:6:1 Type Body Length Violation: Actor body should span 500 lines or less excluding comments and whitespace: currently spans 510 lines (type_body_length)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift:65:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift:195:5 Cyclomatic Complexity Violation: Function should have complexity 15 or less; currently complexity is 23 (cyclomatic_complexity)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift:195:5 Function Body Length Violation: Function body should span 100 lines or less excluding comments and whitespace: currently spans 159 lines (function_body_length)

/Users/danny/dev/loom-clone/app/LoomClone/Pipeline/RecordingActor.swift:922:1 File Length Violation: File should contain 800 lines or less: currently contains 922 (file_length)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraOverlayWindow.swift
/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraOverlayWindow.swift:46:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift
/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:32:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:36:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:37:25 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:38:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:39:33 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:40:32 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:151:25 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:193:25 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:211:25 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:245:32 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/CameraPreviewLayerView.swift:265:32 Modifier Order Violation: nonisolated modifier should come before private (modifier_order)

/Users/danny/dev/loom-clone/app/LoomClone/UI/RecordingPanelContent.swift
/Users/danny/dev/loom-clone/app/LoomClone/UI/RecordingPanelContent.swift:86:74 Multiple Closures with Trailing Closure Violation: Trailing closure syntax should not be used when passing more than one closure argument (multiple_closures_with_trailing_closure)

/Users/danny/dev/loom-clone/app/TestHarness/HarnessConfig.swift
/Users/danny/dev/loom-clone/app/TestHarness/HarnessConfig.swift:280:17 Discouraged Optional Boolean Violation: Prefer non-optional booleans over optional booleans (discouraged_optional_boolean)

/Users/danny/dev/loom-clone/app/TestHarness/HarnessRunner.swift
/Users/danny/dev/loom-clone/app/TestHarness/HarnessRunner.swift:24:7 Type Body Length Violation: Class body should span 500 lines or less excluding comments and whitespace: currently spans 550 lines (type_body_length)

/Users/danny/dev/loom-clone/app/TestHarness/HarnessRunner.swift:394:13 Cyclomatic Complexity Violation: Function should have complexity 15 or less; currently complexity is 18 (cyclomatic_complexity)

/Users/danny/dev/loom-clone/app/TestHarness/HarnessRunner.swift:394:13 Function Body Length Violation: Function body should span 100 lines or less excluding comments and whitespace: currently spans 107 lines (function_body_length)

/Users/danny/dev/loom-clone/app/TestHarness/HarnessRunner.swift:802:1 File Length Violation: File should contain 800 lines or less: currently contains 802 (file_length)

/Users/danny/dev/loom-clone/app/TestHarness/Sources/CapturedFrameSource.swift
/Users/danny/dev/loom-clone/app/TestHarness/Sources/CapturedFrameSource.swift:195:17 Prefer For-Where Violation: `where` clauses are preferred over a single `if` inside a `for` (for_where)

/Users/danny/dev/loom-clone/app/TestHarness/Sources/CapturedFrameSource.swift:436:17 Prefer For-Where Violation: `where` clauses are preferred over a single `if` inside a `for` (for_where)

/Users/danny/dev/loom-clone/app/TestHarness/Sources/CapturedFrameSource.swift:521:1 Line Length Violation: Line should be 160 characters or less; currently it has 244 characters (line_length)
```


## Phase 3 - Developer docs Review

We currently have evergreen developer documentation in `docs/developer`. We also have the top-level `AGENTS.md` and also `CLAUDE.md` files for the two important subprojects:

- app/LoomClone/CLAUDE.md
- server/CLAUDE.md

Our goal here is to review the entire project and ensure that:

1. We have good, accurate developer docs in `docs/developer` for ebverything we need. These should be evergreen documents, which help humands and AI agents to UNDERSTAND the architecture, patterns etc of the codebase. They should not replicate in exhaustive detail information available from reading the code. They should not be super brittle. They should explain high level concepts, principles, and patterns which are particular to UNDERSTANDING this product and codebase - just like any good developer documentation. where it makes sense, they should also act as a reference for (human and AI) developers Where having a reference is better/easier than readint the code. `docs/developer/server-routes-and-api.md` is a good example of this in practice.
2. The top level AGENTS.md should contain only the most important context and information for AI agents working here. It currently does a fairly good job of that I think.
3. The lower-level CLAUDE.md files will be read by Claude Code when working inside those directories, and should contain specific instructions and context to help it orientate itself inside the Hono and macOS apps.

## Phase 4 - Small tweaks to the macOS app

1. The identifier for the app should be `is.danny.loomclone` not `com.danny.loomclone` and the only place this should ideally be Hard coded is in project.yml? We currently have this hard coded in a number of other locations inside the Mac OS app. 
2. The server URL is currently hardcoded to localhost:3000 - this should be configurable in the macOS app settings next to the API Key. This means we'll need to decide exactly where we want to store this and how we want to store this locally. Since we're now beginning to think about storing local preferences data, we should also make it so that "production" builds of the app use a different storage data than development. ie when I run themacOs app via XCode (ie I am working on its code) I probably want it pointed at a different server (localhost or some staging server) than I do when running a properly built `LoomClone.app` from my `~/Applications` dir or similar. We don't currently have a production build Because we haven't dealt with and set up all of that stuff at the moment, but we just need to make it possible that how we store things like API Key and Server URL locally allows for this automatically.
