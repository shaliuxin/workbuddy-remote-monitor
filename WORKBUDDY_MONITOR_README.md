# WorkBuddy 任务监控服务端

这是一个轻量级的本地服务端，允许手机端小程序实时监控 WorkBuddy 任务状态并发送控制指令。

## 功能特性

- ✅ **实时监控**：监控 `~/.workbuddy/tasks/` 目录，自动推送任务状态变化（每 2 秒扫描）
- ✅ **双向交互**：支持暂停、继续、取消、重试、发送消息等指令
- ✅ **安全性**：仅监听 `127.0.0.1`，Token 鉴权，不暴露到外网
- ✅ **零配置**：自动扫描任务目录，无需手动配置

## 快速开始

### 1. 安装依赖

```bash
cd C:/Users/mingh/WorkBuddy/2026-11-20-21-35-26
npm install --prefix . workbuddy-monitor-server-package.json
# 或直接安装 ws
npm install ws
```

### 2. 启动服务端

```bash
node workbuddy-monitor-server.js
```

后台运行（推荐）：
```bash
# Windows (PowerShell)
Start-Process node -ArgumentList "workbuddy-monitor-server.js" -WindowStyle Hidden

# Linux/Mac
nohup node workbuddy-monitor-server.js > monitor.log 2>&1 &
```

### 3. 查看启动信息

启动后会显示：
```
========================================
WorkBuddy 任务监控服务端已启动
========================================
HTTP 端点: http://127.0.0.1:48787
WebSocket: ws://127.0.0.1:48787/ws
Token:     a1b2c3d4e5f6...（32位随机字符串）
========================================
任务目录: C:\Users\mingh\.workbuddy\tasks
========================================
[Init] 发现 23 个任务
[Init] 最新任务: Privacy manifest + re-deploy
[Monitor] 任务监控已启动（每 2 秒扫描一次）
```

## API 端点

### HTTP

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/tasks` | 获取任务列表快照 | Bearer Token |
| GET | `/token` | 获取 Token 和连接信息 | 无 |

### WebSocket

**连接地址：**
```
ws://127.0.0.1:48787/ws?token=<TOKEN>
```

**服务端推送：**
```json
{
  "type": "task_update",
  "tasks": [
    {
      "id": "60e9c794-8b21-4797-8d2c-723503d087cf/8",
      "subject": "Privacy manifest + re-deploy",
      "activeForm": "Writing privacy manifest",
      "description": "Write .wbapp_v4aiYkMQe4Q8ElOGITAsjP.privacy.json...",
      "status": "in_progress",
      "createdAt": 1795229240244,
      "updatedAt": 1795274492521
    }
  ]
}
```

**客户端发送指令：**
```json
{
  "type": "command",
  "taskId": "60e9c794-8b21-4797-8d2c-723503d087cf/8",
  "command": "pause",
  "params": {}
}
```

**支持的指令：**

| 指令 | 说明 | params |
|------|------|--------|
| `pause` | 暂停任务 | - |
| `resume` | 恢复任务 | - |
| `cancel` | 取消任务 | - |
| `retry` | 重新提交任务 | - |
| `send_message` | 发送消息 | `{ "message": "文本内容" }` |

**服务端回执：**
```json
{
  "type": "command_response",
  "taskId": "60e9c794-8b21-4797-8d2c-723503d087cf/8",
  "command": "pause",
  "success": true,
  "message": "已暂停任务"
}
```

## 配置

可以通过修改 `workbuddy-monitor-server.js` 中的 `CONFIG` 对象来自定义配置：

```javascript
const CONFIG = {
    port: 48787,                    // 监听端口
    host: '127.0.0.1',             // 监听地址（仅本机）
    tasksDir: '~/.workbuddy/tasks', // 任务目录
    tokenFile: '~/.workbuddy/.monitor-token', // Token 存储位置
};
```

## 与小程序对接

### 首次配置

1. 启动服务端后，记下显示的 Token
2. 在小程序中输入：
   - **Endpoint**: `ws://127.0.0.1:48787/ws`
   - **Token**: `<启动信息中显示的 Token>`

或使用 HTTP 获取：
```bash
curl http://127.0.0.1:48787/token
```

### 扫码配置（推荐）

可以生成一个包含 endpoint 和 token 的二维码，手机端扫码自动配置。可以使用任意二维码生成工具：

```bash
# 生成二维码内容（JSON 格式）
echo '{"endpoint":"ws://127.0.0.1:48787/ws","token":"<TOKEN>"}' | qrencode -o monitor-qr.png
```

## 与 WorkBuddy 集成

当前服务端的指令处理部分是**模拟实现**，只打印日志并回执。真实场景需要与 WorkBuddy 任务引擎通信：

### 集成点 1：任务控制

在 `handleCommand` 函数中，根据指令调用 WorkBuddy 引擎 API：

```javascript
case 'pause':
    // 调用 WorkBuddy 内部 API 暂停任务
    workbuddyEngine.pauseTask(taskId);
    response.message = '已暂停任务';
    break;
```

### 集成点 2：消息发送

对于 `send_message` 指令，需要将消息传递给正在运行的任务：

```javascript
case 'send_message':
    // 选项 1: 写入任务进程的 stdin
    const taskProcess = workbuddyEngine.getTaskProcess(taskId);
    taskProcess.stdin.write(params.message + '\n');
    
    // 选项 2: 通过 IPC 发送
    workbuddyEngine.sendMessage(taskId, params.message);
    
    response.message = '已发送消息';
    break;
```

### 集成点 3：任务状态推送

在 `broadcastTasks` 函数中，可以监听 WorkBuddy 的任务状态变化事件，实时推送更新：

```javascript
workbuddyEngine.on('task:status-change', (taskId, newStatus) => {
    broadcastTasks(wss); // 立即推送，无需等待定时器
});
```

## 故障排查

### 问题：服务端启动失败

**检查端口占用：**
```bash
# Windows
netstat -ano | findstr :48787

# Linux/Mac
lsof -i :48787
```

**检查任务目录权限：**
```bash
ls -la ~/.workbuddy/tasks
```

### 问题：小程序连接失败

1. 确认服务端已启动并显示 Token
2. 确认小程序输入的 Token 正确
3. 确认手机和电脑在同一网络（如果手机端使用局域网 IP）
4. 检查防火墙是否允许 48787 端口

### 问题：任务不更新

1. 检查 `~/.workbuddy/tasks/` 目录是否有新文件
2. 查看服务端控制台日志
3. 确认任务 JSON 文件格式正确

## 安全性说明

- ✅ 仅监听 `127.0.0.1`，外部设备无法直接访问
- ✅ Token 鉴权，防止未授权访问
- ✅ Token 文件权限设置为 `600`（仅所有者可读写）
- ⚠️ 如果使用局域网 IP（如 `192.168.x.x`），需自行评估风险

## 停止服务端

```bash
# 前台运行：Ctrl + C

# 后台运行
# Windows
Stop-Process -Name node

# Linux/Mac
pkill -f workbuddy-monitor-server.js
```

## 开发日志

- **2026-11-22**: 初始版本，实现任务监控和指令处理框架
