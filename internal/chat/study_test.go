//go:build integration

package chat

// wesight 学习驱动:3 个 session × 10 题,经 ChatService(GUI 同代码)。顺序跑,失败自动重试(peer disconnected 重连)。
// 持久 DB + 每答完一题即追加到 /tmp/study-answers.txt。
// go test -tags=integration -count=1 -run TestStudyWesight -v ./internal/chat/ -timeout 3000s

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

const (
	studyDBPath   = "/tmp/md-study.db"
	studyAnswers  = "/tmp/study-answers.txt"
	studyCwdFixed = "/tmp/wesight-study"
)

var studyQ = map[string][]string{
	"架构": {
		"wesight 是什么?核心定位+列出全部 agent 引擎。", "是 Electron 吗?主进程/渲染进程如何分工?",
		"怎么管理多个 agent 引擎生命周期?spawn 子进程吗?", "支持哪些模型供应商?配置方式?",
		"如何检测并复用本机已装 CLI?", "数据持久化用什么?存哪?", "前端状态管理用什么库?",
		"权限管理如何实现?", "支持哪些桌面平台?打包方式?", "整体架构最大的技术风险是什么?",
	},
	"功能": {
		"Cowork 对话是什么?展示哪些内容?", "工具执行面板有哪些类型?", "AI Runtime Dashboard 统计哪些指标?",
		"实时工作区能做什么?", "SkillHub 技能市场是什么?", "IM Agent Hub 支持哪些 IM?",
		"定时任务能做什么?", "桌面宠物和像素工作室是什么?", "记忆和个性化功能是什么?",
		"最有特色的 3 个功能?为什么?",
	},
	"实现": {
		"读 package.json,核心技术栈是什么?", "src 目录结构?主要模块?", "agent 引擎怎么抽象?有统一接口吗?",
		"怎么调用 Claude Code/Codex CLI?spawn 吗?", "模型路由怎么实现?", "主/渲染进程怎么通信?什么 IPC?",
		"工具调用结果如何渲染到 UI?", "权限事件如何处理?", "运行时监控数据从哪来?",
		"用了 ACP 协议吗?和纯 ACP 客户端有何异同?",
	},
}

func TestStudyWesight(t *testing.T) {
	if _, err := os.Stat(studyCwdFixed); err != nil {
		t.Skipf("wesight dir not found: %v", err)
	}
	os.Remove(studyDBPath)
	os.Remove(studyAnswers)
	fout, err := os.Create(studyAnswers)
	if err != nil {
		t.Fatal(err)
	}
	defer fout.Close()
	var fmu sync.Mutex
	writeLine := func(s string) {
		fmu.Lock()
		fmt.Fprintln(fout, s)
		fout.Sync()
		fmu.Unlock()
	}

	cfg := config.TestConfig("/tmp")
	cfg.DefaultModel = ""
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	st, err := store.New(studyDBPath)
	if err != nil {
		t.Fatal(err)
	}
	svc.st = st
	t.Cleanup(func() { svc.ServiceShutdown() })

	proj, err := svc.AddProject("wesight-study", studyCwdFixed, "zai/glm-4.6")
	if err != nil {
		t.Fatal(err)
	}

	labels := []string{"架构", "功能", "实现"}
	for idx, label := range labels {
		se, e := svc.CreateSession(proj.ID, label, "", false)
		if e != nil {
			writeLine(fmt.Sprintf("\n==== 会话%d【%s】创建失败: %v ====", idx+1, label, e))
			continue
		}
		writeLine(fmt.Sprintf("\n==== 会话%d【%s】 session=%s ====", idx+1, label, se.ID[:8]))
		for qi, q := range studyQ[label] {
			ans, lastErr := "", error(nil)
			for attempt := 0; attempt < 3; attempt++ {
				a, err := svc.SendAndWaitSync(se.ID, q, nil)
				ans, lastErr = a, err
				if err == nil {
					break
				}
				writeLine(fmt.Sprintf("[会话%d Q%d 尝试%d] 失败: %v", idx+1, qi+1, attempt+1, err))
				time.Sleep(2 * time.Second)
			}
			if lastErr != nil {
				writeLine(fmt.Sprintf("[会话%d Q%d] %s\n[重试耗尽未答: %v]", idx+1, qi+1, q, lastErr))
				continue
			}
			writeLine(fmt.Sprintf("[会话%d Q%d] %s\n[A] %s", idx+1, qi+1, q, studyClip(ans)))
		}
		svc.CloseSession(se.ID)
		writeLine(fmt.Sprintf("==== 会话%d【%s】完成 ====", idx+1, label))
	}
	writeLine("\n==== 全部 3 个会话完成 ====")
	t.Log("study complete, see " + studyAnswers)
}

func studyClip(s string) string {
	r := []rune(s)
	if len(r) > 700 {
		return string(r[:700]) + " …[截断]"
	}
	return s
}
