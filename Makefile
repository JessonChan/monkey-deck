.PHONY: all bindings dev dev-frontend build build-frontend app package run test test-integration cover cover-check review-stats clean server icons fmt vet tidy

# monkey-deck Makefile(AGENTS.md §0.5)
## Wails3 CLI, go module and generated bindings must stay version-locked (§0.5).
## Default runs the CLI at the go.mod-pinned version via `go run`, so a stray
## newer/older `wails3` on PATH can never silently generate divergent bindings
## (observed: beta.3 vs alpha2.106 differ in emitted model shapes). Override
## WAILS3=<path> to use a specific binary.
WAILS3 ?= go run github.com/wailsapp/wails/v3/cmd/wails3@$(shell go list -m -f '{{.Version}}' github.com/wailsapp/wails/v3)

## Generate Go methods → frontend TS types (rerun after any exported-method
## signature change, §5.4 #8). Flags mirror build/Taskfile.yml generate:bindings:
## -ts -i emits TypeScript interfaces (the bare call emits JS-only bindings that
## tsc/bun test cannot resolve), -clean drops stale files from earlier runs.
bindings:
	$(WAILS3) generate bindings -clean=true -ts -i

## 重生成 macOS icons.icns(完整 iconset,含 1024x1024);源 = build/appicon.png
icons:
	bash build/darwin/generate-icons.sh

## 热重载开发(Go + 前端一起);先 regen bindings(bindings 不入库,启动时生成)
dev: bindings
	$(WAILS3) dev -config ./build/config.yml

## 仅前端 dev;先 regen bindings(前端 import 依赖)
dev-frontend: bindings
	cd frontend && bun run dev

## 构建前端;先 regen bindings
build-frontend: bindings
	cd frontend && bun run build

## Bare binary bin/monkey-deck only (does not refresh bin/monkey-deck.app); regen bindings first
build: bindings
	$(WAILS3) build

## 打包成 bin/monkey-deck.app(= build + cp 新二进制进 .app + codesign)。「build 后开 .app」用这个,不是 build
app: package

package:
	$(WAILS3) task package

## 直接跑最新裸二进制(不经 .app,最快验证 build 产物)
run: build
	./bin/monkey-deck

## 后端单测(不含真 harness 集成测试)
test:
	go test ./...

## 集成测试:启动真 opencode,需本机已装 opencode + 配好 model
test-integration:
	go test -tags=integration -run TestIntegration -v ./internal/... -timeout 180s

## Coverage targets are pinned: `cover` measures, `cover-check` gates. Do not rename.
## `cover` self-provisions generated bindings: frontend/bindings/ is gitignored and bun
## test / tsc cannot resolve it on a fresh clone (the gate used to die mid-run with
## "Cannot find module .../bindings/..." — same prerequisite dev/build already declare).
cover: bindings
	@test -d frontend/node_modules || { echo "coverage: 缺 frontend/node_modules —— 先执行: (cd frontend && bun install)"; exit 1; }
	# Cacheless full type check before anything downstream: bun test strips types
	# (never checks them), so type regressions — e.g. wire `tags: string[] | null`
	# vs a `{ tags?: string[] }` param — are only caught here. --incremental false
	# forces a full pass every run; no tsbuildinfo cache can mask a stale result.
	cd frontend && bunx tsc --noEmit --incremental false
	go test ./internal/... -covermode=atomic -coverprofile=coverage.out
	go tool cover -func=coverage.out | tail -1
	rm -f frontend/coverage/lcov.info frontend/coverage/.lcov.info.*.tmp
	cd frontend && bun test --isolate --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage


## Coverage gate (pinned name): `cover` + floor check (go total / per-package / frontend).
## Raise floors after adding coverage: --set (scalars) / --set-pkgs (per-package, keeps '-'
## waivers). Ad-hoc HTML report, no target: go tool cover -html=coverage.out -o coverage.html
cover-check: cover
	bash scripts/coverage-floor.sh coverage.out

## Review-record stats over docs/worklog (ARGS passthrough, e.g. ARGS=--by-severity).
## Informational only — never a gate: nothing in build/test/cover/CI invokes it.
review-stats:
	bash scripts/review-stats.sh $(ARGS)

## 构建 server 模式(纯 HTTP,无 GUI,便于自动化验证)
server:
	go build -tags server -o bin/monkey-deck-server .

fmt:
	go fmt ./...

vet:
	go vet ./...

tidy:
	go mod tidy

clean:
	rm -rf frontend/dist bin

