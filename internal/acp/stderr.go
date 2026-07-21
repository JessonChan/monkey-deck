package acp

// stderr.go:harness stderr 的环形缓冲(ring buffer)捕获。
//
// 背景(§3.3 崩溃检测的根因定位):harness(opencode/omp)崩溃时,真正的根因(panic 栈、
// OOM、配置错误、空闲自杀)几乎都印在其自身的 stderr 上。旧实现 `cmd.Stderr = os.Stderr`
// 把 stderr 直通应用 stderr,harness 一死这些线索就随终端历史滚走 —— 日志里只剩
// 一句 `peer disconnected`,看不到「为什么」。
//
// 本环形缓冲按固定容量保留 stderr 的「尾部」(最近 N 字节):既不无限堆积(桌面长驻、
// harness DEBUG 日志可很冗长),又能在崩溃瞬间把尾部拼进结构化 exit 日志,定位根因。
// 同时 tee 到 os.Stderr,保留 dev 模式「实时看 harness 日志」的既有行为(零行为变更)。

import (
	"io"
	"sync"
)

// stderrRingCap 单个 harness stderr 环形缓冲容量。32KiB 尾部足以覆盖一次崩溃的栈/根因,
// 又不至于在冗长 DEBUG 日志下吃太多内存(每个活跃 session 一份)。
const stderrRingCap = 32 * 1024

// stderrTailForLog 「unexpected 退出」日志里拼入的 stderr 尾部长度。
// 取环容量的子集:够放 panic 栈/错误堆栈,不至于把单条日志撑到几十 KB。
const stderrTailForLog = 4 * 1024

// stderrRing 是定容环形字节缓冲,实现 io.Writer。
// 并发安全(多条 stderr 写入并发?实际 harness 单条 stderr 由 OS 串行投递,但 ring 也
// 被 Snapshot/Tail 跨 goroutine 读,故加锁)。
type stderrRing struct {
	mu    sync.Mutex
	buf   []byte // 定容,长度 == 容量
	start int    // 最老字节的下标
	size  int    // 当前已存字节数(<= cap)
	tee   io.Writer
}

// newStderrRing 构造环形缓冲。tee 非 nil 时,每次 Write 同步镜像写入 tee(用于保留
// 「stderr 直通应用 stderr」的既有行为);tee 写错误被忽略(stderr 捕获不能因 tee 故障失败)。
func newStderrRing(tee io.Writer) *stderrRing {
	return &stderrRing{buf: make([]byte, stderrRingCap), tee: tee}
}

// Write 把 p 追加进环形缓冲(超出容量丢弃最老字节)。返回 p 的原始长度(永远成功)。
func (r *stderrRing) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tee != nil {
		_, _ = r.tee.Write(p)
	}
	origN := len(p)
	if origN == 0 {
		return 0, nil
	}
	capn := len(r.buf)
	// p 比整个缓冲还大:只留尾部 capn 字节(根因总在最后)
	if origN >= capn {
		p = p[origN-capn:]
	}
	n := len(p)
	// 从 (start+size)%capn 起写入,环绕
	pos := (r.start + r.size) % capn
	for written := 0; written < n; {
		space := capn - pos
		chunk := n - written
		if chunk > space {
			chunk = space
		}
		copy(r.buf[pos:pos+chunk], p[written:written+chunk])
		written += chunk
		pos = (pos + chunk) % capn
	}
	// 更新 size / start(溢出时丢弃最老)
	if r.size+n <= capn {
		r.size += n
	} else {
		overflow := r.size + n - capn
		r.start = (r.start + overflow) % capn
		r.size = capn
	}
	return origN, nil
}

// Snapshot 返回缓冲内全部已存字节(按写入顺序:最老→最新)。
func (r *stderrRing) Snapshot() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.snapshotLocked())
}

// Tail 返回最近 n 字节(n 超过已存量则返回全部;n<=0 返回空)。
func (r *stderrRing) Tail(n int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || r.size == 0 {
		return ""
	}
	if n > r.size {
		n = r.size
	}
	capn := len(r.buf)
	startByte := (r.start + r.size - n) % capn
	out := make([]byte, n)
	pos := startByte
	for i := 0; i < n; i++ {
		out[i] = r.buf[pos]
		pos = (pos + 1) % capn
	}
	return string(out)
}

// snapshotLocked 读全量,调用方持锁。
func (r *stderrRing) snapshotLocked() []byte {
	if r.size == 0 {
		return nil
	}
	capn := len(r.buf)
	out := make([]byte, r.size)
	pos := r.start
	for i := 0; i < r.size; i++ {
		out[i] = r.buf[pos]
		pos = (pos + 1) % capn
	}
	return out
}
