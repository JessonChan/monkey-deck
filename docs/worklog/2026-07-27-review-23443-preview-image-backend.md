# 2026-07-27 Review #23443 后端:SessionReadImage(文件预览图片打开)

## 起因

Task #23446(backend reviewer 角色复审 #23443「文件预览图片打开 + 自定义滚动条端到端验收」)。
#23443 是端到端任务,拆成后端 #23444(`SessionReadImage`)与前端 #23445(图片分流 `<img>`
+ 细滚动条)。前端部分由 fe-reviewer 另行复审;本条只覆盖 **后端** 范围:
- commit `8ffe608 feat(chat): SessionReadImage 返回 dataURL + 扩展名推断`
- 涉及 `internal/fsview/fsview.go`、`internal/chat/chat.go`、`internal/fsview/fsview_test.go`。

## 审查结论:PASS(后端,无阻断项)

逐项核对(对照 AGENTS.md §1/§3/§5 与 reviewer playbook):

### 1. 架构边界(§1.1 / §2.1):✓
- `ReadImage` 与 `ReadFile` 同形态,是 `internal/fsview/` 的受限目录读路径;`ChatService.SessionReadImage`
  是它唯一的 binding 包装,走 `cwdOf`(worktree / 项目目录),不碰 ACP、不启 harness ——
  与 §1.1「纯 ACP」无冲突(文件预览本就不经 agent)。
- `internal/store/` 边界未触动(无裸 SQL)。

### 2. 路径钉(§3 安全 / 既有 `safeJoin` 防线):✓
- `ReadImage` 复用 `safeJoin`,**未新造越界防线**;`../` 越界、符号链接逃逸由既有
  `resolveExisting` + `relOut` 兜住。`TestReadImagePathGuard` 实证:目录 / `../x.png` /
  `escape/secret.png`(root 内符号链接指向 root 外)三类均被拒。

### 3. mime 推断设计(§5.3 找不变量 / 先验证再动手):✓
- 两级:扩展名白名单(`extToImageMime`)优先 → 覆盖 SVG 等文本格式;扩展名缺失/未命中
  时 `http.DetectContentType` 内容嗅探 + `imageMimeToExt` 反推扩展名。
- **外部事实已实测验证**(§5.3):对 png/jpg/gif/bmp/webp/ico 各自魔数跑
  `http.DetectContentType`,六种全部识别且 mime 均在 `imageMimeToExt` key 集合内 ——
  嗅探兜底无格式缺口(webp 在 Go 标准库确能嗅出,非盲猜)。
- 「扩展名优先于内容」是显式设计(用户视角的扩展名 = 用户意图),worklog 已说明;
  错配文件(如 `a.png` 实为文本)会得到无效 dataURL,`<img>` 渲染失败但不崩溃、非安全问题。

### 4. 大小上限 / 内存(§3 实现):✓
- `maxImageSize = 8MB`,`info.Size() > maxImageSize` 报错(Stat size 判定,先于 `ReadFile`,
  不读超限内容);`TestReadImageTooLarge` 用 `Truncate(maxImageSize+1)` 造稀疏文件实证
  off-by-one 正确(8MB 放行、8MB+1 拒)。8MB → ~10.7MB base64 dataURL,单图预览可接受。

### 5. 端到端消费(「类型补丁」反模式核对):dataURL ✓,Extension ⚠
- 反向追踪字段消费点(不顺着 PR 叙事走):
  - `dataUrl`:前端两处真实消费 —— `FilePanel.tsx:140`(`d?.dataUrl`)、
    `FilePreviewOverlay.tsx:50`(`.then((d) => d?.dataUrl ?? "")`)。非空壳。
  - **`extension`:前端无任何消费点**(`grep -rn '\.extension' frontend/src` 无命中)。
    worklog 称「extension 给下载名 / 分类」,但当前无下载按钮 / 分类消费者。
    → **后端产出与单测均正确**(`TestReadImagePNGByExt` 断言 `img.Extension == "png"`),
    属前端 YAGNI / 待补消费者,**非后端缺陷**,不阻断。若长期无消费者,按 §5.3
    「Less is More」可后续删字段;当前保留为前向字段,成本极低,暂不动。

### 6. 测试覆盖与锚定值(playbook):✓
- 8 个新单测覆盖:扩展名命中 / 扩展名优先 / 嗅探兜底 / SVG(仅扩展名)/ 非图片报错 /
  路径钉 / 过大 / 缺失。`TestReadImagePNGByExt` **断言锚定值**(base64 解回后 `bytes.Equal`
  比对原始 PNG 字节,而非「字段存在」),符合 §5.3「测试断言锚定值」。

### 7. 安全旁注(SVG / dataURL):无需后端处置
- SVG 可含 `<script>`,但前端经 `<img src=dataURL>` 渲染(`<img>` 不执行 SVG 脚本,
  是 Web 安全既定事实)。若未来前端改 `<iframe>` / 内联 SVG 才需重新评估 —— 属前端边界。

## 改了哪些文件(本次 review 新增)

- `internal/fsview/fsview_test.go`
  - 新增 `TestImageMimeMapsReverseConsistent`:锚定「`extToImageMime` 每个 value 必是
    `imageMimeToExt` 的 key」这一隐式不变量。今天该不变量成立(含 `.jpg`/`.jpeg`→`image/jpeg`
    双射、`image/jpeg`→`jpg` 规范化反推);但设计上「扩展名路径 ↔ 嗅探反推扩展名」依赖
    两表一致,若未来给 `extToImageMime` 加新格式漏改 `imageMimeToExt`,该格式的嗅探兜底
    会静默失效。把人肉交叉核对固化成回归测试(reviewer playbook:最高价值是把不可重复的
    人肉验证固化成测试,而非替作者验一遍)。
- `docs/worklog/2026-07-27-review-23443-preview-image-backend.md`:本条。

## 验证

```
go test ./internal/fsview/ -run 'TestReadImage|TestImageMimeMapsReverseConsistent' -v
  # 9 PASS(原 8 + 新 1)
go test ./internal/...     # 全包 PASS
go vet ./internal/...      # clean
```

## 下一步 / OPEN

- **OPEN(前端,非阻断)**:`ImageData.Extension` 当前无消费者。若 #23443 收尾后仍不打算
  做下载 / 分类,建议按 KISS 删字段(后端单测同步删 `Extension` 断言);否则补一个真实
  消费点(下载按钮的文件名)。留待 fe-reviewer / 后续 task 定夺。
- 实机 webview 抽验(透明 PNG 棋盘格 / SVG / 大图细滚动条)属前端 / server 模式验收,
  不在后端审查范围。
