.PHONY: build build-harness test regen format lint lint-fix clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build: ## Build the main app (Debug)
	xcodebuild -project LoomClone.xcodeproj -scheme LoomClone -configuration Debug -destination 'platform=macOS' build

build-harness: ## Build the test harness (Debug)
	xcodebuild -project LoomClone.xcodeproj -target LoomCloneTestHarness -configuration Debug build

test: ## Run unit tests
	xcodebuild test -project LoomClone.xcodeproj -scheme LoomCloneTests -destination 'platform=macOS'

regen: ## Regenerate Xcode project from project.yml
	xcodegen generate

format: ## Format all Swift files with SwiftFormat
	swiftformat .

lint: ## Lint all Swift files with SwiftLint
	swiftlint lint

lint-fix: ## Auto-fix SwiftLint violations
	swiftlint --fix

clean: ## Remove Xcode build artifacts
	xcodebuild -project LoomClone.xcodeproj -scheme LoomClone clean
	rm -rf build/
