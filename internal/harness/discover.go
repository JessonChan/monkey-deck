// discover.go:运行时发现本机已安装的 harness + 解析本地版本 + 查上游最新版本。
//
// Probe 是注入点(§5.1 接口注入 mock):生产用 defaultProbe(exec.LookPath + 真跑命令),
// 单测注入 fakeProbe(假二进制 + 固定版本串),不真起子进程。
//
// Discover 不写包级状态(纯函数):调用方(chat service)负责把结果缓存/合并。
// 这样测试确定性高(同输入 → 同输出),并发安全。
package harness

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Probe 把可执行文件相关的「环境相关操作」抽象成接口,供测试注入。
//
// 实现要点:
//   - LookPath: 在 PATH(或 fakeProbe 的伪 PATH)里找二进制。
//   - Version: 跑 `<bin> <args> --version` 等价命令,返回解析后的纯版本串。
type Probe interface {
	// LookPath 找二进制绝对路径;找不到返 ("", error)。
	// bin 是不含扩展名的规范名(BinaryName);实现按平台决定是否加 .exe。
	LookPath(bin string) (string, error)
	// Version 跑版本命令并解析出纯版本(如 "1.2.3");失败返 ("", error)。
	Version(ctx context.Context, path string, args []string) (string, error)
}

// defaultProbe 生产用:exec.LookPath + 真跑 `<bin> args...` 解析版本。
type defaultProbe struct{}

// LookPath 解析二进制:Windows 上加 .exe;其它平台直接 LookPath。
// 失败返 exec.LookPath 的原始 error(包裹路径便于诊断)。
func (defaultProbe) LookPath(bin string) (string, error) {
	name := bin
	if runtime.GOOS == "windows" {
		name = bin + ".exe"
	}
	p, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("lookpath %s: %w", name, err)
	}
	return p, nil
}

// Version 跑命令、合并 stdout+stderr、从首行提取首个版本号 token。
//
// 多数 CLI 工具的版本输出形如:
//   - "opencode version 0.5.123" → "0.5.123"
//   - "omp 1.2.3\n(build ...)"    → "1.2.3"
//   - "v3.0.0"                     → "v3.0.0"(前导 v 保留,与 trimLeadingV 配合)
//
// 提取规则(尽量宽松,避免每加一个 harness 就改 parser):取输出第一个 version-like token。
// version-like = 主分隔符切开后的首个含数字的 token。失败返 ("", error)(不返回空串假装成功)。
func (defaultProbe) Version(ctx context.Context, path string, args []string) (string, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("run %s %s: %w: %s", filepath.Base(path), strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	v := extractVersion(string(out))
	if v == "" {
		return "", fmt.Errorf("parse version from %s: %q", filepath.Base(path), strings.TrimSpace(string(out)))
	}
	return v, nil
}

// extractVersion 从 CLI 工具的版本输出里提取版本号(纯函数,独立测试)。
//
// 策略:按空白/常见分隔符切开,返回首个「含数字」的 token(去掉尾随的 ':'/'-' 等)。
// 这是宽松启发式 —— 不为每个 harness 写专用 parser(避免硬编码)。
// 命中: "x v1.2.3"→"v1.2.3";"1.2.3-beta"→"1.2.3-beta";"ver 2.0 (build 9)"→"2.0"。
// 未命中返空串。
func extractVersion(output string) string {
	// 只看首行(版本号通常在第一行;后行多为 build/commit 信息,容易抓到 commit hash 假阳)。
	firstLine := output
	if i := strings.IndexAny(firstLine, "\r\n"); i >= 0 {
		firstLine = firstLine[:i]
	}
	// 按非版本字符切:保留字母数字、点、连字符(覆盖 1.2.3 / 1.2.3-beta / v1.2.3)。
	fields := strings.FieldsFunc(firstLine, func(r rune) bool {
		return !(r == '.' || r == '-' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'))
	})
	for _, f := range fields {
		// 含数字才算版本(token=alpha 时跳过,如 "version"/"ver")。
		if !strings.ContainsAny(f, "0123456789") {
			continue
		}
		return f
	}
	return ""
}

// 默认 Probe 单例(可被 SetProbe 替换;仅测试用,生产不要调)。
var (
	probeMu sync.RWMutex
	probe   Probe = defaultProbe{}
)

// currentProbe 线程安全取当前 Probe(测试可能并发替换)。
func currentProbe() Probe {
	probeMu.RLock()
	defer probeMu.RUnlock()
	return probe
}

// SetProbe 替换全局 Probe(仅测试用,生产禁用)。
func SetProbe(p Probe) {
	probeMu.Lock()
	probe = p
	probeMu.Unlock()
}

// SetProbeForTest 替换全局 Probe 并返回还原函数(测试用 defer 调用)。
// 用 atomic-free 风格 —— 测试 setup/teardown 串行调用,不会与生产并发。
func SetProbeForTest(p Probe) (restore func()) {
	probeMu.Lock()
	prev := probe
	probe = p
	probeMu.Unlock()
	return func() {
		probeMu.Lock()
		probe = prev
		probeMu.Unlock()
	}
}

// ExtractVersionForTest 暴露 extractVersion 给外部测试包用(同 defaultProbe 的解析行为)。
func ExtractVersionForTest(output string) string { return extractVersion(output) }

// SwapRegistryForTest 替换全局 Registry 并返回还原函数(测试用 defer 调用)。
// 测试改 Registry 来注入 stub Source/Upgrader,免污染其它测试。
func SwapRegistryForTest(next []Spec) (restore func()) {
	prev := Registry
	Registry = next
	return func() { Registry = prev }
}

// Discover 在本机扫 Registry 里的每个 Spec,返回运行时 Harness 列表(顺序与 Registry 对齐)。
//
// 行为:
//   - 静态元数据(ID/Name/Command)从 Supported 复制(单一事实源:Supported 是 ID/Name/Command 的真相)。
//   - Path/Installed/InstalledVersion 经 Probe(默认 exec.LookPath + 真跑版本命令)得到。
//   - LatestVersion 经 Spec.Source(可空)异步查;无 Source 或失败 → 空 + 不报错(降级)。
//   - UpgradeAvailable = Installed 且 LatestVersion 非空 且 compareVersions(Installed, Latest) < 0。
//
// Discover 本身纯函数;LatestVersion 的网络查询由 ctx 控制超时/取消(默认由调用方包)。
// 整体阻塞 ≤ max(LookPath/Version 各 Spec 串行,Source 各 Spec 并行)。
func Discover(ctx context.Context) []Harness {
	out := make([]Harness, 0, len(Registry))
	// 预取静态元数据,供 Spec.ID 对齐。
	byID := map[string]Harness{}
	for _, h := range Supported {
		byID[h.ID] = h
	}

	// 阶段 1:本地发现(PATH + 版本),顺序执行(快速、确定性;每个 ~几 ms 到几十 ms)。
	inst := make([]Harness, len(Registry))
	p := currentProbe()
	for i, sp := range Registry {
		h := byID[sp.ID]
		if h.ID == "" {
			// Registry 与 Supported 不一致(开发期疏漏)—— 防御:给个最小回退。
			h = Harness{ID: sp.ID, Name: sp.ID, Command: sp.ID + " acp"}
		}
		inst[i] = h
		// Path/Version 走 Probe(可注入);失败静默降级(Installed=false,空版本)。
		if path, err := p.LookPath(sp.BinaryName); err == nil && path != "" {
			inst[i].Path = path
			inst[i].Installed = true
			if v, err := p.Version(ctx, path, sp.versionArgs()); err == nil {
				inst[i].InstalledVersion = v
			}
		}
	}

	// 阶段 2:上游最新版本(并行查,Source 为 nil 跳过)。并行降低延迟,避免单 harness 慢拖全部。
	type latestRes struct {
		idx int
		v   string
	}
	res := make(chan latestRes, len(Registry))
	pending := 0
	for i, sp := range Registry {
		if sp.Source == nil {
			continue
		}
		pending++
		go func(i int) {
			sp := Registry[i]
			r, err := sp.Source.Latest(ctx)
			if err == nil {
				res <- latestRes{i, r.Version}
			} else {
				res <- latestRes{i, ""}
			}
		}(i)
	}
	// 每个 Source 至多一个结果;收齐(已无 Source 的不在此队列里)。
	for k := 0; k < pending; k++ {
		r := <-res
		if r.v != "" {
			inst[r.idx].LatestVersion = r.v
		}
	}

	// 阶段 3:派生 UpgradeAvailable(已装 + 有最新 + 当前 < 最新)。
	for i := range inst {
		if inst[i].Installed && inst[i].InstalledVersion != "" && inst[i].LatestVersion != "" {
			inst[i].UpgradeAvailable = compareVersions(inst[i].InstalledVersion, inst[i].LatestVersion) < 0
		}
	}

	out = append(out, inst...)
	return out
}

// compareVersions 比较两个版本串:a<b 返 -1,== 返 0,a>b 返 +1。
//
// 算法:去掉前导 v/V,按 '.' 切段,逐段比较。两段同为纯数字段则按数值比,
// 否则按字符串比(覆盖 "1.2.3-beta" / "1.2.3+build" 等变形,够用即可,§5.3 KISS)。
// 非严格 semver(不区分 pre-release 优先级)—— 不在范围内的边界由调用方降级处理。
func compareVersions(a, b string) int {
	aa := strings.Split(trimLeadingV(a), ".")
	bb := strings.Split(trimLeadingV(b), ".")
	n := len(aa)
	if len(bb) > n {
		n = len(bb)
	}
	for i := 0; i < n; i++ {
		var as, bs string
		if i < len(aa) {
			as = aa[i]
		}
		if i < len(bb) {
			bs = bb[i]
		}
		if isAllDigits(as) && isAllDigits(bs) {
			// 数值比较(避免 "10" < "9" 的字符串错位)。
			ai, bi := atoiSafe(as), atoiSafe(bs)
			if ai < bi {
				return -1
			}
			if ai > bi {
				return 1
			}
			continue
		}
		if as < bs {
			return -1
		}
		if as > bs {
			return 1
		}
	}
	return 0
}

// atoiSafe 十进制字符串 → int64(空/非数字返 0;不报错,仅在 isAllDigits 通过后调)。
func atoiSafe(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		n = n*10 + int64(s[i]-'0')
	}
	return n
}

// isAllDigits 串非空且全是 ASCII 数字。
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
