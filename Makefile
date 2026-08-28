.PHONY: all bindings dev dev-frontend build build-frontend app package run test test-integration cover cover-check review-stats clean server icons fmt vet tidy

# monkey-deck Makefile(AGENTS.md §0.5)
WAILS3 ?= wails3

## 生成 Go 方法 → 前端 TS 类型(改了导出方法签名后必须重新跑,§5.4 #8)
bindings:
	$(WAILS3) generate bindings

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

## 只产出裸二进制 bin/monkey-deck(不刷新 bin/monkey-deck.app);先 regen bindings
build: bindings $(WAILS3)
	$(WAILS3) build

## 打包成 bin/monkey-deck.app(= build + cp 新二进制进 .app + codesign)。「build 后开 .app」用这个,不是 build
app: package

package: $(WAILS3)
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
	go test ./internal/... -covermode=atomic -coverprofile=coverage.out
	go tool cover -func=coverage.out | tail -1
	rm -f frontend/coverage/lcov.info frontend/coverage/.lcov.info.*.tmp
	cd frontend && bun test --isolate --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage


## Coverage gate (pinned name): `cover` + floor check (go total / per-package / frontend).
## Raise floors after adding coverage: --set (scalars) / --set-pkgs (per-package, keeps '-'
## waivers). Ad-hoc HTML report, no target: go tool cover -html=coverage.out -o coverage.html
cover-check: cover
	bash scripts/coverage-floor.sh coverage.out

## Review-record stats over docs/worklog (ARGS passthrough, e.g. ARGS=--by-severity)
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

