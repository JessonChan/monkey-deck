.PHONY: all bindings dev dev-frontend build build-frontend app package run test test-integration clean server icons fmt vet tidy

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
