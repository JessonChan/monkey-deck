package terminal

// scrollback.go:PTY 输出的环形字节缓冲(ring buffer)。
//
// 为什么需要它:终端的 scrollback 历史(已输出的命令 + shell 回显)此前只存在于
// 前端某个 xterm 实例的内存里(见 frontend termRegistry.ts)。一旦那个 xterm 被 dispose
// (切窗口 / 弹出独立窗口),历史就永久丢失——后端 PTY 的 readLoop 是 fire-and-forget
// (读到字节就 emit 广播,不留存)。
//
// ring buffer 给每个终端的输出配一份「最近 N 字节」的后端留存,使终端 scrollback 有了
// 自己的单一真相源(对齐 AGENTS.md §1.5「本地是真相」的哲学:对话历史在 SQLite,
// 终端历史在这里)。任何窗口需要终端时,先 replay 这份留存再继续订阅实时广播,
// 弹出 / 回切 / 重开走同一条路径,无需跨窗口搬运数据。
//
// 设计取舍:存原始字节(含 ANSI 序列)而非解析后的行。replay 时 term.write(原始字节)
// 能完整还原颜色 / 光标 / 滚动区——比 xterm 的 serialize 插件更通用且无前端依赖。
// 容量按字节计(默认 64KB ≈ 1000 行 × 平均行宽),内存可预测。
//
// 内存模型:buf 预分配满(len == cap == 固定容量),用 size(已写入总量,封顶 cap)+ pos
// (下一个写入位置)两个游标描述状态。这避免了「append 增长 buf」与「固定容量环形覆盖」
// 混用带来的「刚好填满」歧义边界——写入只做 copy 覆盖,永不 append,snapshot 顺序无歧义。

// defaultScrollbackBytes 每个终端 ring buffer 的字节容量上限。
// 对齐前端 xterm scrollback=1000 行的量级(见 termRegistry.ts acquireTerminal),
// 按每行 ~64 字节估得 64KB;内存开销每终端恒定,可忽略。
const defaultScrollbackBytes = 64 * 1024

// scrollback 固定容量的字节环形缓冲。并发不安全:由 termSession.mu 保护。
type scrollback struct {
	buf  []byte // 固定容量环形存储(len == cap == 容量,永不增长)
	pos  int    // 下一个写入位置(0..cap-1)
	size int    // 已写入总量(封顶 cap;== cap 表示已写满一圈)
}

// newScrollback 创建一个给定容量的 ring buffer(buf 预分配满)。
func newScrollback(capBytes int) *scrollback {
	if capBytes < 1 {
		capBytes = defaultScrollbackBytes
	}
	return &scrollback{buf: make([]byte, capBytes)}
}

// write 追加一段 PTY 输出。超过容量时最旧的数据被覆盖(环形覆盖)。
// 调用方须持有 termSession.mu。
func (s *scrollback) write(data []byte) {
	n := len(data)
	if n == 0 {
		return
	}
	capv := len(s.buf)
	// 单次写入就超过总容量:只留最后 capv 字节(更老的本就会被覆盖)。
	if n >= capv {
		copy(s.buf, data[n-capv:])
		s.pos = 0
		s.size = capv
		return
	}
	// 普通写入:从 pos 起覆盖,可能跨越环形边界(尾部 + 头部两段)。
	space := capv - s.pos // pos 到 buf 末尾的连续可写空间
	if n <= space {
		copy(s.buf[s.pos:], data)
	} else {
		// 跨边界:先填满 pos 到末尾,剩余从头覆盖。
		copy(s.buf[s.pos:], data[:space])
		copy(s.buf, data[space:])
	}
	s.pos = (s.pos + n) % capv
	if s.size < capv {
		s.size += n
		if s.size > capv {
			s.size = capv
		}
	}
}

// snapshot 返回按写入顺序排列的完整缓冲内容(一份副本,调用方可自由使用)。
// 调用方须持有 termSession.mu。
func (s *scrollback) snapshot() []byte {
	if s.size == 0 {
		return nil
	}
	out := make([]byte, s.size)
	// 未写满一圈:pos == size,数据顺序落在 buf[0:size)。
	if s.size < len(s.buf) {
		copy(out, s.buf[:s.size])
		return out
	}
	// 已写满:写入顺序 = [pos..cap) ++ [0..pos)(pos 指向最旧数据的起点)。
	n := copy(out, s.buf[s.pos:])
	copy(out[n:], s.buf[:s.pos])
	return out
}
