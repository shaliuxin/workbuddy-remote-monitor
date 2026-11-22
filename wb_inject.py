#!/usr/bin/env python3
"""
WorkBuddy 消息注入器 —— 通过 UI 自动化把消息打进 WorkBuddy 窗口的输入框。

原理：
  1. 找到 WorkBuddy 主窗口 (FindWindow / EnumWindows)
  2. 激活窗口 (SetForegroundWindow)
  3. 把消息写入剪贴板 ( win32 clipboard, CF_UNICODETEXT )
  4. 模拟 Ctrl+V 粘贴 + 回车发送 ( keybd_event )

用法：
  python wb_inject.py "要发送的消息"                          # 发给当前会话
  python wb_inject.py --session "会话标题" "消息"              # 先切到指定会话再发
  python wb_inject.py --title "特定窗口标题" "消息"
  python wb_inject.py --probe                                 # 只探测窗口，不发送

切换会话原理：Ctrl+K 全局搜索 → Ctrl+A 清空 → 粘贴标题 → 点击第一条"最近匹配"会话。
注意：会话标题必须与 WorkBuddy sessions 表里的 title 完全一致才能命中。

依赖：仅 Python 标准库 (ctypes)
"""
import sys
import time
import ctypes
from ctypes import wintypes

# 关键：设置 DPI aware，否则 GetWindowRect/SetCursorPos 用逻辑坐标，
# 在 125%/150% 缩放下会点偏
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# --- Win32 常量 ---
SW_RESTORE = 9
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
VK_CONTROL = 0x11
VK_RETURN = 0x0D
VK_V = 0x56
VK_K = 0x4B
VK_A = 0x41
KEYEVENTF_KEYUP = 0x0002

# SetForegroundWindow 的坑：需要从当前前台线程"让出"焦点
# 用 AttachThreadInput 绕开 Windows 的前台锁定限制
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def find_windows(keyword=None):
    """枚举所有可见窗口，返回 [(hwnd, title)]"""
    results = []

    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if keyword is None or keyword.lower() in title.lower():
                    results.append((hwnd, title))
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return results


def activate_window(hwnd):
    """激活窗口，绕开前台锁定"""
    user32.ShowWindow(hwnd, SW_RESTORE)
    current_thread = kernel32.GetCurrentThreadId()
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None)
    attached = False
    if fg_thread and fg_thread != current_thread:
        attached = user32.AttachThreadInput(current_thread, fg_thread, True)
    try:
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.3)
        fg_now = user32.GetForegroundWindow()
        if fg_now != hwnd:
            # 备用：模拟 Alt 键欺骗 SetForegroundWindow
            user32.keybd_event(0x12, 0, 0, 0)  # Alt down
            user32.SetForegroundWindow(hwnd)
            user32.keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0)
            time.sleep(0.3)
    finally:
        if attached:
            user32.AttachThreadInput(current_thread, fg_thread, False)
    return user32.GetForegroundWindow() == hwnd


def set_clipboard(text):
    """把文本写入 Windows 剪贴板"""
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.EmptyClipboard.argtypes = []
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.CloseClipboard.argtypes = []
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    if not user32.OpenClipboard(0):
        # 剪贴板被占用，重试几次
        for _ in range(5):
            time.sleep(0.2)
            if user32.OpenClipboard(0):
                break
        else:
            raise RuntimeError("无法打开剪贴板 (被其他程序占用)")
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        hmem = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        ptr = kernel32.GlobalLock(hmem)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(hmem)
        if not user32.SetClipboardData(CF_UNICODETEXT, hmem):
            raise RuntimeError("SetClipboardData 失败")
    finally:
        user32.CloseClipboard()


def send_keys(vk_codes):
    """模拟按键序列。vk_codes: [(vk, is_down), ...]"""
    user32.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, wintypes.DWORD, ctypes.c_void_p]
    for vk, is_down in vk_codes:
        flags = 0 if is_down else KEYEVENTF_KEYUP
        user32.keybd_event(vk, 0, flags, 0)
        time.sleep(0.05)


def paste_and_enter(delay=0.4):
    """Ctrl+V 粘贴，然后回车发送"""
    # Ctrl down, V down, V up, Ctrl up
    send_keys([(VK_CONTROL, True), (VK_V, True), (VK_V, False), (VK_CONTROL, False)])
    time.sleep(delay)
    # Enter
    send_keys([(VK_RETURN, True), (VK_RETURN, False)])


def get_window_rect(hwnd):
    """获取窗口屏幕坐标 (left, top, right, bottom)"""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
    r = RECT()
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def click_at(x, y):
    """模拟鼠标点击屏幕坐标"""
    user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    user32.SetCursorPos(x, y)
    time.sleep(0.1)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.2)


def switch_conversation(session_title):
    """通过 Ctrl+K 全局搜索切换到指定标题的会话。

    WorkBuddy 的 Ctrl+K 会打开全局搜索面板：
      - 顶部是搜索框，输入会话标题后第一条"最近匹配"即目标会话
      - 点击该条目即可切换到对应会话（按 Enter 会误开资料库文档，所以用鼠标点）
    返回 (ok, detail)。
    """
    if not session_title:
        return True, "未指定会话标题，保持当前会话"

    # Ctrl+K 打开全局搜索
    send_keys([(VK_CONTROL, True), (VK_K, True), (VK_K, False), (VK_CONTROL, False)])
    time.sleep(0.7)
    # Ctrl+A 清空搜索框旧内容（关键：不清会追加导致搜不到）
    send_keys([(VK_CONTROL, True), (VK_A, True), (VK_A, False), (VK_CONTROL, False)])
    time.sleep(0.2)
    # 粘贴目标会话标题
    set_clipboard(session_title)
    time.sleep(0.2)
    send_keys([(VK_CONTROL, True), (VK_V, True), (VK_V, False), (VK_CONTROL, False)])
    time.sleep(0.9)

    # 点击搜索结果第一条"最近匹配"会话条目。
    # 搜索面板相对窗口固定：面板约在窗口内 x=350..1330, y=170..600；
    # 第一条结果中心约在窗口内 (543, 398)（全屏 970,558 对应窗口 left=427,top=160）。
    wins = find_windows("WorkBuddy")
    if not wins:
        return False, "切换会话时找不到 WorkBuddy 窗口"
    hwnd = wins[0][0]
    left, top, right, bottom = get_window_rect(hwnd)
    click_at(left + 543, top + 398)
    time.sleep(2.0)  # 等待会话切换动画完成
    return True, f"已尝试切换到会话 '{session_title}'"


def inject(message, title_keyword="WorkBuddy", click_offset=None, session_title=None):
    """主流程：找窗口 → 激活 → [切换会话] → 点击输入框 → 剪贴板 → 粘贴回车

    click_offset: (相对窗口左上角的 x, y) 输入框位置。
    session_title: 目标会话标题，非空时先 Ctrl+K 切换到该会话再注入。
    """
    windows = find_windows(title_keyword)
    if not windows:
        return False, f"找不到标题含 '{title_keyword}' 的窗口。当前可见窗口: " + ", ".join(t for _, t in find_windows()[:10])

    hwnd, title = windows[0]
    activated = activate_window(hwnd)
    if not activated:
        return False, f"无法激活窗口 '{title}'"

    # 若指定了目标会话，先切换过去
    switch_info = ""
    if session_title:
        ok, detail = switch_conversation(session_title)
        if not ok:
            return False, detail
        switch_info = f" [会话:{session_title}]"
        # 切换后重新激活窗口（切换动画可能改变焦点）
        activate_window(hwnd)
        time.sleep(0.2)

    left, top, right, bottom = get_window_rect(hwnd)
    w, h = right - left, bottom - top

    # 计算输入框点击位置
    if click_offset:
        click_x, click_y = left + click_offset[0], top + click_offset[1]
    else:
        # 默认：相对窗口左上角 (973, 1010) —— 实测 WorkBuddy 输入框位置（DPI-aware 物理坐标）
        click_x = left + 973
        click_y = top + 1010

    # 点击输入框获得焦点
    click_at(click_x, click_y)

    set_clipboard(message)
    time.sleep(0.2)
    paste_and_enter()
    return True, f"已向窗口 '{title}'{switch_info} 发送消息: {message[:50]} (点击位置 {click_x},{click_y})"


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "--probe":
        print("=== 可见窗口列表 ===")
        for hwnd, title in find_windows("WorkBuddy"):
            print(f"  hwnd={hwnd}  title={title}")
        sys.exit(0)

    title_kw = "WorkBuddy"
    session_title = None
    # 解析选项：--title <窗口关键字> / --session <会话标题>
    while args and args[0].startswith("--"):
        opt = args[0]
        if opt in ("--title", "--session") and len(args) >= 2:
            val = args[1]
            if opt == "--title":
                title_kw = val
            else:
                session_title = val
            args = args[2:]
        else:
            break

    msg = " ".join(args)
    ok, result = inject(msg, title_kw, session_title=session_title)
    print(("OK: " if ok else "FAIL: ") + result)
    sys.exit(0 if ok else 1)
