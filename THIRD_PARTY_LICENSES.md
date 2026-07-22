# Third-Party Licenses

本文件登记 monkey-deck **直接借用/改写至本仓库源码里的第三方代码**,满足
[AGENTS.md §0.4](AGENTS.md) 的项目级署名要求(文件级版权声明见各源文件顶部)。

> **依赖(import)不等于借用代码。** 本仓库通过 `go.mod` 引入的第三方库
> (Wails3 / acp-go-sdk / sqlite …) 属编译/运行依赖,源码未复制进仓,
> 故不在此按 §0.4 登记文件级署名;其二进制再分发义务以各依赖自身的 LICENSE
> 为准。以下仅登记 **改写或原样保留进仓库的第三方文件/片段**。

---

## 1. 借来改写过的代码(需保留协议署名)

### 1.1 wesight → `internal/titlegen/titlegen.go`(MIT)

- **来源**:[wesight by freestylefly](https://github.com/freestylefly/wesight)
  ([LICENSE](https://github.com/freestylefly/wesight/blob/main/LICENSE))
- **协议**:MIT
- **借用方式**:移植改写
  - 把 wesight 的 `src/shared/cowork/sessionTitle.ts`
    (`buildSessionTitleContext` / `normalizeSessionTitleToPlainText`)
    移植为 Go 的`BuildContext`/`Normalize`,常数(`maxChars=50`、
    `maxCtxLines=8`、`maxCtxChars=800`)与 wesight 保持一致。
- **落文件**:`internal/titlegen/titlegen.go`
  (文件顶部已保留 wesight MIT 版权声明与许可全文—— §0.4 文件级)
- **原始版权声明**:

```
Copyright (c) freestylefly (https://github.com/freestylefly/wesight)
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 原样保留的第三方脚手架文件(未改动,自带头版权声明)

> 这些文件随 Wails3 脚手架产生,未改动其逻辑,不在「借用改写」之列;
> 在此登记仅作透明。它们已自带版权头,分发时须随文件保留。

### 2.1 `build/linux/appimage/build.sh`(MIT)

- **来源 / 版权**:[Lea Anthony](https://github.com/wailsapp/wails),
  Wails3 官方 AppImage 打包模板
- **协议**:MIT (文件内 `SPDX-License-Identifier: MIT`)
- **仓库路径**:`build/linux/appimage/build.sh`
- **改动**:无(原样随脚手架引入)

### 2.2 `assets/harness-icons/opencode.svg`(MIT)

- **来源 / 版权**:[opencode](https://github.com/anomalyco/opencode)
  —— `packages/identity/mark.svg`(Copyright (c) 2025 opencode)
- **协议**:MIT([LICENSE](https://github.com/anomalyco/opencode/blob/main/LICENSE))
- **借用方式**:原样拷贝(官方品牌 mark,未改绘——上层需求 #42 明确复用官方 logo、不自研)
- **仓库路径**:`assets/harness-icons/opencode.svg`(文件名对齐 harness ID `opencode`,
  供前端按 harness ID 归并取图,§5.3)
- **改动**:无;仅在文件顶部追加 XML 注释版权声明 + MIT 许可全文(§0.4 文件级——
  原文件无版权头,补登)

### 2.3 `assets/harness-icons/omp.png`(MIT)

- **来源 / 版权**:[oh-my-pi](https://github.com/can1357/oh-my-pi)
  —— `python/robomp/assets/icon.png`(robomp 彩色品牌图标;原样借用,未改绘)
  (Copyright (c) 2025 Mario Zechner;Copyright (c) 2025-2026 Can Bölük)
- **协议**:MIT([LICENSE](https://github.com/can1357/oh-my-pi/blob/main/LICENSE))
- **借用方式**:原样拷贝(官方 icon,未改绘)
- **仓库路径**:`assets/harness-icons/omp.png`(文件名对齐 harness ID `omp`)
- **改动**:无;**PNG 为二进制资源,无法内嵌文件级版权头**,故仅在此处登记
  项目级署名(§0.4 项目级)。原文件无单独 NOTICE,版权以 oh-my-pi 仓库 LICENSE 为准。

> 未知 / 第三方 harness 不内置兜底图,前端用 `lucide-react` 的 `Bot` 兜底;
> 命名约定 / 维护规则见 `assets/harness-icons/README.md`。

---

## 3. 关键第三方依赖(import,未照搬源码)

| 模块 | 用途 | 协议 | 备注 |
|---|---|---|---|
| `github.com/wailsapp/wails/v3` | Wails3 桌面框架(application / events / updater / binding) | MIT | 随 Wails3 再分发 |
| `github.com/coder/acp-go-sdk` | ACP 协议 SDK(NewClientSideConnection / ClientSideConnection) | Apache-2.0 | 见 `references/agent-client-protocol` 仓库 |
| `modernc.org/sqlite` | SQLite 纯 Go 驱动(免 CGO) | BSD-3-Clause | builder tag 引入 |

> 以上为直接依赖;完整列表以 `go.mod` 为准。各依赖的完整 LICENSE 文本位于
> `$GOPATH/pkg/mod/<module>@<version>/LICENSE`(或官方仓库)。

---

## 维护约定

- **新增借用代码**:在对应源文件顶部保留原作者版权声明(§0.4 文件级),
  并到此文件 **§1** 新增一条登记。
- **新增原样保留的第三方文件**:登记到 **§2**。
- **纯 import 依赖**:一般不需改此文件;仅在 LICENSE/NOTICE 再分发时需要
  汇总(详见依赖各自的义务)。

