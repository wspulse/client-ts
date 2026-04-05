.PHONY: help build test test-cover lint fmt check clean

# Default target
help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

build: ## Compile TypeScript to dist/ (ESM + CJS)
	@npx tsup

test: ## Run unit tests
	@npx vitest run

test-cover: ## Run tests with coverage report
	@npx vitest run --coverage

lint: ## Run ESLint and type-check
	@npx eslint src/ test/
	@npx tsc --noEmit

fmt: ## Format source files with Prettier
	@npx prettier --write "src/**/*.ts" "test/**/*.ts"

check: ## Run fmt-check, lint, and unit tests
	@echo "── fmt ──"
	@npx prettier --check "src/**/*.ts" "test/**/*.ts"
	@echo "── lint ──"
	@$(MAKE) --no-print-directory lint
	@echo "── test ──"
	@$(MAKE) --no-print-directory test
	@echo "── all passed ──"

clean: ## Remove build artifacts and test cache
	@rm -rf dist coverage
