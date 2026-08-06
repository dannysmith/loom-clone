.PHONY: build agent-build test agent-test regen format lint lint-fix clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build: ## Build the main app (Debug)
	xcodebuild -project LoomClone.xcodeproj -scheme LoomClone -configuration Debug -destination 'platform=macOS' build

agent-build: ## Build the main app (Debug, sandbox-compatible: no SwiftPM sandbox, no codesigning)
	xcodebuild -project LoomClone.xcodeproj -scheme LoomClone -configuration Debug -destination 'platform=macOS' -IDEPackageSupportDisableManifestSandbox=1 -IDEPackageSupportDisablePluginExecutionSandbox=1 CODE_SIGNING_ALLOWED=NO build

test: ## Run unit tests
	xcodebuild test -project LoomClone.xcodeproj -scheme LoomCloneTests -destination 'platform=macOS'

agent-test: ## Run unit tests (sandbox-compatible, same flags as agent-build)
	xcodebuild test -project LoomClone.xcodeproj -scheme LoomCloneTests -destination 'platform=macOS' -IDEPackageSupportDisableManifestSandbox=1 -IDEPackageSupportDisablePluginExecutionSandbox=1 CODE_SIGNING_ALLOWED=NO

regen: ## Regenerate Xcode project from project.yml
	xcodegen generate

format: ## Format all Swift files with SwiftFormat
	swiftformat .

lint: ## Lint all Swift files with SwiftLint
	swiftlint lint

lint-fix: ## Auto-fix SwiftLint violations
	swiftlint --fix

install-prod: ## Build Release and install to ~/Applications
	./scripts/install-prod.sh

clean: ## Remove Xcode build artifacts
	xcodebuild -project LoomClone.xcodeproj -scheme LoomClone clean
	rm -rf build/
