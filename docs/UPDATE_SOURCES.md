# 更新源选型与自建服务器指引

> 本文件回答:**自动升级必须依赖 GitHub 吗?能不能自建更新服务器?** 以及「想自建时该怎么选、怎么换」。
> 操作性的「打 tag → 发布 → 客户端升级」流程见 [RELEASE.md](./RELEASE.md);实现见 [`internal/update/`](../internal/update/update.go)。
> 状态:**当前默认走 GitHub Releases;自建路线已论证可行,切换留待后续处理。**

---

## 结论先行

**GitHub 不是必须的。** Wails3 的 updater 是 **Provider 可插拔** 的,GitHub Releases 只是 3 个内置 provider 之一。当前默认选 GitHub 仅因「免费 + 零基础设施」;要自建 / 内网分发 / 已有静态服务器 / 不想绑定 GitHub —— 随时可切,改动极小(一处 provider 构造)。

---

## 1. 为什么能随便换源(Provider 接口)

updater 把「去哪查、去哪下」抽象成一个只有 3 个方法的接口,**其余一切(校验、原子写盘、helper 热替换、重启、弹窗、事件)都由 updater 自己干,与源无关**:

```go
type Provider interface {
    Name() string
    Check(ctx, req) (*Release, error)   // 查「有没有比自己新的版本」,没有返回 (nil,nil)
    Download(ctx, r, dst, onProgress)   // 把新版本字节流写给 updater
}
```

所以「换更新源」=换一个 `Provider` 实现,主流程零改动。

---

## 2. 三种内置 provider + 自定义

| Provider | 自建服务器? | 要部署什么 | 适合 |
|---|---|---|---|
| **appcast**(Sparkle AppCast) | ✅ **自建首选** | 一个静态 `appcast.xml`(RSS)+ `.zip` 包,放**任意 HTTP 服务器**(nginx / Caddy / S3 / MinIO / Gitea raw / 自家服务器 / CDN) | 自建、内网分发、不想绑 GitHub —— macOS 应用自托管更新的业界标准 |
| **github**(GitHub Releases) | ❌ 绑 GitHub | GitHub Release + `SHA256SUMS` | 零成本、不在意绑定(**当前默认**) |
| **keygen**(keygen.sh) | ✅ 有自托管版 | keygen 自托管版 + 许可体系 | 还需要授权 / license 控制 |
| **自定义 Provider** | ✅ 完全自由 | 你自己的后端(JSON API / Gitea·GitLab Releases / 对象存储目录 / 本地共享 …) | 现有后端、特殊协议、完全控制 |

---

## 3. 自建首选:AppCast 路线

### 3.1 你只要有一个能放静态文件的地方

```
https://updates.example.com/monkey-deck/
├── appcast.xml                      ← 版本清单(updater 只查这个)
└── 0.2.0/
    └── monkey-deck-darwin-arm64.zip ← 新版本包
```

### 3.2 `appcast.xml`(Sparkle 标准 RSS,appcast provider 原生解析)

```xml
<?xml version="1.0" standalone="yes"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Monkey Deck</title>
    <item>                               <!-- 最新的放最上面 -->
      <title>0.2.0</title>
      <sparkle:shortVersionString>0.2.0</sparkle:shortVersionString>
      <sparkle:version>0.2.0</sparkle:version>
      <description><![CDATA[ 更新说明(文本/markdown) ]]></description>
      <enclosure
        url="https://updates.example.com/monkey-deck/0.2.0/monkey-deck-darwin-arm64.zip"
        length="12345678"
        type="application/octet-stream"
        sparkle:edSignature="Base64签名(可选,做真实性校验)" />
    </item>
  </channel>
</rss>
```

- **发新版本** = 上传新 zip + 往 `appcast.xml` 顶部加一个 `<item>`。
- **版本比较**:provider 按 `sparkle:shortVersionString`(回退 `sparkle:version`)做 semver 比较,取最新。
- **校验**:`sparkle:edSignature`(Ed25519,Sparkle 2)做真实性;或依赖 enclosure `length` + 内嵌摘要。
- ⚠️ Sparkle 1 的 DSA 签名(`sparkle:dsaSignature`)**不支持**;要用 EdDSA(Sparkle 2)。

### 3.3 代码改动(仅一处)

`internal/update/update.go` 的 `newProvider()`:

```go
// 现在(github):
return github.New(github.Config{Repository: GitHubRepository, ChecksumAsset: ChecksumAsset})

// 自建(appcast):换这两行,其余一行不动
return appcast.New(appcast.Config{URL: AppCastURL})   // AppCastURL = 新常量
```

### 3.4 配套:发布脚本也要跟着改

当前 `release:darwin` 是 **github 风格**(产 `zip` + `SHA256SUMS`)。切 appcast 后要改成:**产 zip + 算 length/Ed25519 签名 + 生成(或追加)appcast.xml 条目**。这是切换工作量的大头,纯脚本,不动 Go 代码。

---

## 4. 自定义 Provider(任意后端,约 50 行)

若更新源不是 Sparkle 那套(自己的 JSON API、Gitea/GitLab Releases、对象存储目录…),实现接口即可:

```go
type myServer struct{ base string }

func (m *myServer) Name() string { return "myserver" }

func (m *myServer) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
    // GET https://你的服务器/latest.json → 解析 → 与 req.CurrentVersion 比 semver
    // 有新版:填好 *updater.Release 返回;无:返回 (nil, nil)
}

func (m *myServer) Download(ctx context.Context, r *updater.Release, dst io.Writer, onProgress func(int64, int64)) error {
    // GET r.Artifact 对应的 URL → io.Copy 到 dst,期间定期调 onProgress(已写, 总大小)
}
```

`Release` 要填的字段:`Version` / `Artifact{Filename,Size,Platform,Arch}` / `Verification{DigestAlgo,Digest}`(可选)。校验 / 替换 / 重启全由 updater 接管。

---

## 5. 选型速查

| 你的诉求 | 选 |
|---|---|
| 零成本、不在意绑 GitHub | **github**(现状) |
| 要自建 / 内网分发 / 已有静态服务器 / 不想绑 GitHub | **appcast**(首选) |
| 已有自家后端 API、要完全控制 | **自定义 Provider** |
| 还要授权 / license 体系 | **keygen**(自托管版) |

---

## 6. 当前状态 / 后续(待处理)

- **当前**:已实现 **github** 路线(见 `RELEASE.md` 流程 + `internal/update`)。
- **自建可行性**:已论证(appcast / 自定义均可,改动集中在 `newProvider()` + 发布脚本),**尚未切换**。
- **待确认**:更新文件放哪(自家服务器 / 对象存储 / Gitea…)→ 决定后一次性改 `newProvider()` + 发布脚本。
- 切换后同步更新:`RELEASE.md`(发布流程)、`PROCESS.md`(决策记录 §E + 工作日志 §G)。
