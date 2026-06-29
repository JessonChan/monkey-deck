package chat

import (
	"os/exec"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// PickDirectory 弹出原生目录选择对话框,返回选中路径(取消则返回空串)。
// 供前端「添加项目」时选取项目根目录。
func (s *ChatService) PickDirectory() (string, error) {
	app := application.Get()
	if app == nil {
		return "", nil
	}
	dialog := app.Dialog.OpenFile().
		SetTitle("选择项目目录").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true)
	selection, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	return selection, nil
}

// PickFiles 弹出原生多文件选择对话框,返回选中的文件绝对路径列表(取消则空)。
// 附件以 @/path 注入 prompt(opencode 据此读取具体文件),供前端 composer 附件功能。
func (s *ChatService) PickFiles() ([]string, error) {
	app := application.Get()
	if app == nil {
		return nil, nil
	}
	dialog := app.Dialog.OpenFile().
		SetTitle("选择文件附加到消息").
		CanChooseFiles(true).
		CanChooseDirectories(false)
	selection, err := dialog.PromptForMultipleSelection()
	if err != nil {
		return nil, err
	}
	return selection, nil
}

// RevealPath 在系统文件管理器中打开指定路径(macOS Finder / Windows 资源管理器 / Linux xdg)。
func (s *ChatService) RevealPath(path string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", path).Start()
	case "windows":
		return exec.Command("explorer", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}
