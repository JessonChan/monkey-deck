# 2026-07-27 后端 SessionReadImage:dataURL + 扩展名推断 + safeJoin 路径钉

## 起因

Task #23444。前端需要预览 session 工作目录下的图片(agent 产物 / 项目截图等),
但 webview 不能直接吃本地 file:// 路径(跨平台权限 / 安全限制)。需要一个后端
方法把图片读成 `data:<mime>;base64,<b64>` 的 dataURL 喂给 `<img src>`,同时
回传扩展名供前端做下载名 / 分类。

## 设计

- **复用 fsview 的 safeJoin 做路径钉**:`../` 越界与符号链接逃逸都被拒(已有
  `ErrEscapesRoot` + `resolveExisting` 基准),`ReadImage` 直接走同一防线,不新造。
- **mime 推断两级**:① 优先按扩展名白名单(`.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg/.ico`),
  覆盖 **SVG 这类文本格式**——`http.DetectContentType` 只认二进制魔数,嗅不出 SVG;
  ② 扩展名缺失 / 未在白名单时按 `http.DetectContentType` 嗅探内容,再反推扩展名。
  两者都拿不到 `image/*` → 报「不是图片」。
- **扩展名优先于嗅探**:文件名 `.jpg` 但内容是 PNG 时,按 `.jpg` 返回 image/jpeg
  (用户视角的扩展名 = 用户意图);只有扩展名拿不准时才信内容。
- **大小上限 8MB**(`maxImageSize`):超过直接报错,避免把大文件 base64 灌进
  webview 撑爆内存(对照 `ReadFile` 的 2MB 文本上限,图片放宽到 8MB)。
- **返回 `ImageData{DataURL, Extension}`** 而非裸字符串:前端拿 `dataUrl` 喂 `<img>`,
  `extension` 给下载名,不互相耦合。
- **`SessionReadImage` 是 `SessionReadFile` 的镜像**:走 `cwdOf`(worktree/项目目录),
  一行包到 `fsview.ReadImage`,跟其它 `Session*` fsview 包装方法同形态。

## 改了哪些文件

- `internal/fsview/fsview.go`
  - 新增 import `encoding/base64`、`net/http`。
  - 新增 `maxImageSize`、`extToImageMime`、`imageMimeToExt` 映射、`ImageData` 类型、
    `ReadImage(root, rel)`、`inferImage(rel, data)`。
- `internal/chat/chat.go`
  - 新增 `SessionReadImage(sessionID, rel)`(Wails3 binding 暴露给前端),紧挨
    `SessionReadFile`。
- `internal/fsview/fsview_test.go`
  - 新增 8 个测试:PNG(扩展名命中)、扩展名优先于嗅探、嗅探兜底、SVG(仅扩展名)、
    非图片报错、路径钉(目录/`../`/符号链接逃逸)、过大报错、缺失/根目录报错。
    PNG 字节用 `image/png` 标准库编码 1×1 真实图,避免硬编码魔数。

## 验证

```
go build ./internal/...        # clean
go vet ./internal/fsview/ ./internal/chat/   # clean
go test ./internal/fsview/ -v  # 全 PASS,含 8 个新 TestReadImage*
go test ./internal/chat/       # 全 PASS(回归无影响)
```

## 下一步

- 前端(`frontend/src`):新增 `<img>` 预览组件 / 文件面板双击图片调
  `SessionReadImage` 渲染(本任务仅后端)。
- 若实际遇到更大图片需求(截图 / 设计稿),可调高 `maxImageSize` 或加缩略图路径。
- 若 harness 产出图片名无扩展名且非标准格式(罕见),`inferImage` 嗅探兜底;
  仍识别不出就报错,前端按 error 提示「无法预览」。
