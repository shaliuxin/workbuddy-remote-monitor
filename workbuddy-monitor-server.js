#!/usr/bin/env node
/**
 * WorkBuddy 任务监控服务端
 *
 * 功能：
 * 1. 监控 ~/.workbuddy/tasks/ 目录，实时推送任务状态变化
 * 2. 接收手机端控制指令（pause/resume/cancel/retry/send_message）
 * 3. 监听 0.0.0.0，支持手机局域网访问
 * 4. Token 鉴权（首次启动生成）
 *
 * 启动方式：
 *   node workbuddy-monitor-server.js
 *   # 或后台运行
 *   node workbuddy-monitor-server.js &
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
// ACP 桥接器：通过 WorkBuddy 内部 Gateway 的 ACP 协议按 sessionId 精确投递消息
// （替代不可靠的 UI 注入——UI 注入受活跃会话抢占 + 草稿队列影响）
const wbAcp = require('./wb_acp_bridge');
// 会话活跃度检测：有专属 serve 网关（writer）的会话走 ACP 会阻塞，改走 UI 注入
const wbActivity = require('./wb_session_activity');
// 任务控制桥接：pause/resume/cancel/retry/select_option 走真实协议（steer / ACP prompt）
const wbControl = require('./wb_control');
// 真实 AskUserQuestion 监听：把 Agent 弹的选项推到手机端
const wbQuestions = require('./wb_question_watcher');

// ============================================================
// 配置
// ============================================================

/**
 * 探测 Python 解释器（**可选依赖**）。
 * 只有「UI 模拟注入」这一路需要 Python；分发包可不带 Python，
 * 找不到时活跃会话会自动降级为 steer 注入（纯 Node 协议，功能等价）。
 * 查找顺序：环境变量 WB_PYTHON → 包内 runtime/python.exe → 系统 PATH → 本机已知路径
 */
function resolvePythonPath() {
    const candidates = [];
    if (process.env.WB_PYTHON) candidates.push(process.env.WB_PYTHON);
    candidates.push(path.join(__dirname, 'runtime', 'python.exe'));
    candidates.push('C:/Users/mingh/.workbuddy/binaries/python/versions/3.13.12/python.exe');
    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
    }
    // 系统 PATH 里的 python（跳过 Microsoft Store 的 WindowsApps 占位符）
    if (process.platform === 'win32') {
        try {
            const out = require('child_process').execFileSync('where', ['python'], {
                encoding: 'utf8', windowsHide: true, timeout: 3000,
            });
            for (const line of String(out).split(/\r?\n/)) {
                const p = line.trim();
                if (!p || /WindowsApps/i.test(p)) continue;
                if (fs.existsSync(p)) return p;
            }
        } catch (e) { /* ignore */ }
    } else {
        // macOS/Linux：which python3 → which python
        for (const name of ['python3', 'python']) {
            try {
                const out = require('child_process').execFileSync('which', [name], {
                    encoding: 'utf8', timeout: 3000,
                });
                const p = String(out).trim().split(/\r?\n/)[0];
                if (p && fs.existsSync(p)) return p;
            } catch (e) { /* ignore */ }
        }
    }
    return '';
}

const CONFIG = {
    // 5 位冷门端口，避开 8787/8080 等常见开发端口，降低与其它服务冲突的概率
    port: 48787,
    // 绑定 0.0.0.0 以便手机等局域网设备访问
    // 注意：0.0.0.0 表示监听本机所有网卡，包括局域网 IP
    host: '0.0.0.0',
    tasksDir: path.join(os.homedir(), '.workbuddy', 'tasks'),
    tokenFile: path.join(os.homedir(), '.workbuddy', '.monitor-token'),
    // WorkBuddy 数据库：任务目录名即 session id，sessions.title 是你在 WorkBuddy
    // 里看到的真实任务名（如「移植 MaterialCraft 到鸿蒙系统」），
    // 而 tasks/<id>/<n>.json 里的 subject 只是单个步骤的名字。
    dbFile: path.join(os.homedir(), '.workbuddy', 'workbuddy.db'),
    // 对话记录：~/.workbuddy/projects/<workspace>/<sessionId>.jsonl
    // 每行一个事件，type=message 且 role=assistant 的那条就是任务的对话内容。
    projectsDir: path.join(os.homedir(), '.workbuddy', 'projects'),
    // UI 注入脚本：通过模拟"点击输入框 + 粘贴 + 回车"把手机消息真正送进 WorkBuddy 任务
    // 完全绕开 CLI 登录/认证墙 —— 就是机器人替用户在电脑上打字
    injectScript: path.join(__dirname, 'wb_inject.py'),
    // 可选：为空表示未找到 Python（会自动降级 steer 注入，不影响使用）
    pythonExe: resolvePythonPath(),
};

// 对话内容在单条卡片里的最大展示长度（超出截断，避免超长刷屏）
const LAST_MESSAGE_MAX = 2000;

// ============================================================
// 局域网地址检测
// ============================================================

/**
 * 获取本机的局域网 IPv4 地址列表（过滤掉回环和虚拟网卡）
 * 用于在手机端填写 WebSocket 地址时提供参考
 */
function getLanIPv4List() {
    const results = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const info of interfaces[name] || []) {
            if (info.family !== 'IPv4' || info.internal) continue;
            results.push({ name, address: info.address });
        }
    }
    return results;
}

// ============================================================
// 公开端点（无需鉴权）
// ============================================================

const PUBLIC_ENDPOINTS = ['/token'];

// ============================================================
// Token 管理
// ============================================================

function loadOrCreateToken() {
    try {
        if (fs.existsSync(CONFIG.tokenFile)) {
            const token = fs.readFileSync(CONFIG.tokenFile, 'utf8').trim();
            if (token) {
                console.log('[Token] 已加载现有 token');
                return token;
            }
        }
    } catch (err) {
        console.error('[Token] 读取失败:', err.message);
    }

    // 生成新 token
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(CONFIG.tokenFile, token, { mode: 0o600 });
        console.log('[Token] 已生成新 token');
    } catch (err) {
        console.error('[Token] 写入失败:', err.message);
        process.exit(1);
    }
    return token;
}

const TOKEN = loadOrCreateToken();

// ============================================================
// 任务监控
// ============================================================

const taskCache = new Map(); // taskId -> task data
let lastSnapshot = []; // 最近一次的任务列表快照

// ============================================================
// 任务标题映射（tasks 目录名 = session id → sessions.title）
// ============================================================

let dbHandle = null;
let sessionTitles = new Map(); // sessionId -> { title: string, status: string }
let lastTitleLoadAt = 0;       // 上次加载时间戳
// 每 10 秒刷新一次会话信息（title + status）。
// 状态实时性对监控很关键（任务完成/失败需尽快反映），
// 而单次查询同时拿到 title 和 status，无需分开。
const TITLE_REFRESH_MS = 10000;

/**
 * session 状态 → 监控任务状态 的映射
 * WorkBuddy 以 session.status 作为任务整体状态的权威依据，
 * 磁盘上最新步骤的 status 经常会滞后（任务在执行中，但最后一步已标 completed）。
 *   working  -> in_progress（执行中）
 *   error    -> failed（失败）
 *   completed-> completed（已完成）
 *   其它/无  -> 返回 null（回退到磁盘步骤状态）
 */
function mapSessionStatus(sessionStatus) {
    switch (sessionStatus) {
        case 'working': return 'in_progress';
        case 'error': return 'failed';
        case 'completed': return 'completed';
        default: return null;
    }
}

/**
 * 打开 WorkBuddy 数据库并加载所有会话标题
 * 读取失败时静默降级为只用 subject（不影响监控核心功能）
 */
function loadSessionTitles(force) {
    // 未到刷新间隔则不重复加载（force 为 true 时强制刷新）
    const now = Date.now();
    if (!force && sessionTitles.size > 0 && now - lastTitleLoadAt < TITLE_REFRESH_MS) {
        return;
    }
    try {
        if (!fs.existsSync(CONFIG.dbFile)) {
            console.log('[Titles] 数据库不存在，仅使用步骤 subject');
            sessionTitles = new Map();
            lastTitleLoadAt = now;
            return;
        }
        let DatabaseSync;
        try {
            ({ DatabaseSync } = require('node:sqlite'));
        } catch (err) {
            console.log('[Titles] node:sqlite 不可用，仅使用步骤 subject');
            return;
        }
        dbHandle = new DatabaseSync(CONFIG.dbFile, { readOnly: true });
        const rows = dbHandle
            .prepare('SELECT id, title, custom_title, status FROM sessions')
            .all();
        sessionTitles = new Map();
        rows.forEach((r) => {
            const name = r.title || r.custom_title;
            if (name && name.trim()) {
                sessionTitles.set(r.id, { title: name.trim(), status: r.status });
            }
        });
        lastTitleLoadAt = now;
        console.log(`[Titles] 已加载 ${sessionTitles.size} 个会话标题`);
    } catch (err) {
        console.error('[Titles] 读取会话标题失败:', err.message);
        sessionTitles = new Map();
    }
}

/**
 * 根据任务目录名（session id）获取 WorkBuddy 会话信息
 * @returns { title: string, mappedStatus: string|null }
 */
function getSessionInfo(taskId) {
    const sessionId = String(taskId).split('/')[0];
    const info = sessionTitles.get(sessionId);
    if (!info) {
        return { title: '', mappedStatus: null };
    }
    return { title: info.title, mappedStatus: mapSessionStatus(info.status) };
}

/**
 * 定位某个 session 的对话记录文件（jsonl）
 * 文件位于 ~/.workbuddy/projects/<workspace>/<sessionId>.jsonl，
 * 但 <workspace> 目录名随项目路径变化，需遍历 projectsDir 下所有子目录查找。
 * @param {string} sessionId
 * @returns {string|null} 文件绝对路径，找不到返回 null
 */
function findConversationFile(sessionId) {
    const base = CONFIG.projectsDir;
    if (!fs.existsSync(base)) {
        return null;
    }
    let workspaces;
    try {
        workspaces = fs.readdirSync(base);
    } catch (err) {
        return null;
    }
    for (const ws of workspaces) {
        const candidate = path.join(base, ws, sessionId + '.jsonl');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * 从对话记录文件中提取最后一条对话内容
 * 倒序扫描（从文件尾部往前）以兼顾大文件（可达十几 MB）的效率，
 * 跳过 reasoning / function_call / function_call_result 等事件，
 * 找到第一条 type=message 的记录即为「最后一条对话」。
 * 优先返回 assistant 回复；若尾部全是工具事件直到文件头都没有 assistant，
 * 则回退到最后一条 user 消息（如刚下达指令、助手尚未回复时）。
 * @param {string} sessionId
 * @returns {{ role: string, text: string, timestamp: number|null, hasMore: boolean }|null}
 */
function readLastConversation(sessionId) {
    const sid = String(sessionId || '').split('/')[0];
    if (!/^[0-9a-f-]{36}$/i.test(sid)) {
        return null;
    }
    const file = findConversationFile(sid);
    if (!file) {
        return null;
    }

    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (err) {
        console.error('[Conv] 读取对话文件失败:', file, err.message);
        return null;
    }

    const lines = content.split('\n');
    // 倒序扫描，遇到第一条 message 即返回
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch (err) {
            continue; // 跳过损坏行
        }
        if (event.type !== 'message') continue;

        const role = event.role === 'user' ? 'user' : 'assistant';
        const text = extractMessageText(event);
        if (!text) continue;

        return {
            role: role,
            text: text.length > LAST_MESSAGE_MAX ? text.slice(0, LAST_MESSAGE_MAX) : text,
            timestamp: typeof event.timestamp === 'number' ? event.timestamp : null,
            hasMore: text.length > LAST_MESSAGE_MAX,
        };
    }
    return null;
}

/**
 * 从一条 message 事件中拼接纯文本
 * content 数组里每项形如 { type: 'output_text'|'input_text', text: '...' }
 */
function extractMessageText(event) {
    if (!event || !Array.isArray(event.content)) {
        return '';
    }
    const parts = [];
    for (const item of event.content) {
        if (item && typeof item.text === 'string' && item.text.trim()) {
            parts.push(item.text.trim());
        }
    }
    return parts.join('\n').trim();
}

/**
 * 扫描 tasks 目录，读取所有任务 JSON 文件
 */
function scanTasks() {
    // 标题按间隔自动刷新（首次立即加载，之后每 TITLE_REFRESH_MS 毫秒）
    loadSessionTitles(false);

    const tasks = [];
    
    if (!fs.existsSync(CONFIG.tasksDir)) {
        console.log('[Tasks] 目录不存在:', CONFIG.tasksDir);
        return tasks;
    }

    try {
        const taskDirs = fs.readdirSync(CONFIG.tasksDir);
        
        for (const taskDir of taskDirs) {
            const taskDirPath = path.join(CONFIG.tasksDir, taskDir);
            const stat = fs.statSync(taskDirPath);
            if (!stat.isDirectory()) continue;

            // 读取目录下所有数字命名的 JSON 文件（步骤）
            const files = fs.readdirSync(taskDirPath);
            const stepFiles = files
                .filter(f => /^\d+\.json$/.test(f))
                .sort((a, b) => parseInt(a) - parseInt(b));

            // 找到最新的步骤作为任务当前状态
            if (stepFiles.length > 0) {
                const latestFile = stepFiles[stepFiles.length - 1];
                const latestPath = path.join(taskDirPath, latestFile);
                
                try {
                    const taskData = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
                    const taskId = taskDir + '/' + latestFile.replace('.json', '');
                    // 从会话读取真实标题与整体状态
                    const sessionInfo = getSessionInfo(taskId);
                    const subject = taskData.subject || '未命名任务';
                    // 状态以 session.status 为权威；无会话记录时回退到磁盘步骤状态
                    const status = sessionInfo.mappedStatus || taskData.status || 'pending';
                    const task = {
                        id: taskId,
                        title: sessionInfo.title || subject,
                        subject: subject,
                        activeForm: taskData.activeForm || '',
                        description: taskData.description || '',
                        status: status,
                        createdAt: taskData.createdAt || Date.now(),
                        updatedAt: taskData.updatedAt || Date.now(),
                    };
                    tasks.push(task);
                } catch (err) {
                    console.error('[Tasks] 解析失败:', latestPath, err.message);
                }
            }
        }
    } catch (err) {
        console.error('[Tasks] 扫描失败:', err.message);
    }

    // 按更新时间倒序排序
    tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    return tasks;
}

/**
 * 检查任务列表是否发生变化
 */
function tasksChanged(newTasks) {
    const newSnapshot = JSON.stringify(newTasks);
    if (newSnapshot === JSON.stringify(lastSnapshot)) {
        return false;
    }
    lastSnapshot = newTasks;
    return true;
}

/**
 * 推送任务更新到所有客户端
 */
function broadcastTasks(wss) {
    const tasks = scanTasks();
    
    if (tasksChanged(tasks)) {
        const message = JSON.stringify({
            type: 'task_update',
            tasks: tasks,
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(message);
            }
        });
        
        console.log('[Broadcast] 已推送', tasks.length, '个任务');
    }
}

// 离线待投递的选择请求（手机不在线时缓存，重连后补推）
const _pendingSelections = [];

/**
 * 向订阅了指定任务的客户端推送选择请求
 * 返回成功推送的客户端数量
 */function requestSelection(taskId, selectionMsg) {
    const message = JSON.stringify(selectionMsg);
    let pushed = 0;
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
            pushed += 1;
        }
    });
    if (pushed === 0) {
        // 手机不在线：缓存待投递，等客户端重连后补推（最多保留 30 分钟）
        const rid = selectionMsg.requestId || '';
        if (!_pendingSelections.some(s => s.requestId === rid)) {
            _pendingSelections.push({ requestId: rid, taskId, message, at: Date.now() });
            console.log('[Select] 无在线客户端，已缓存待投递 (taskId=' + taskId + ', 待投递 ' + _pendingSelections.length + ')');
        }
        return 0;
    }
    console.log('[Select] 已向', pushed, '个客户端推送选择请求 (taskId=' + taskId + ')');
    return pushed;
}

/** 客户端上线时补推离线期间积累的选择请求 */
function flushPendingSelections(ws) {
    const now = Date.now();
    for (let i = _pendingSelections.length - 1; i >= 0; i--) {
        if (now - _pendingSelections[i].at > 30 * 60 * 1000) _pendingSelections.splice(i, 1);
    }
    if (!_pendingSelections.length) return;
    let sent = 0;
    for (const s of _pendingSelections) {
        if (ws.readyState !== 1) break;
        ws.send(s.message);
        sent += 1;
    }
    console.log('[Select] 客户端上线，补推', sent, '条待投递选择请求');
}

/** 问题回答后清掉对应待投递项 */
function clearPendingSelection(requestId) {
    if (!requestId) return;
    const callId = String(requestId).split('#')[0];
    for (let i = _pendingSelections.length - 1; i >= 0; i--) {
        const rid = String(_pendingSelections[i].requestId || '');
        if (rid === requestId || rid.split('#')[0] === callId) _pendingSelections.splice(i, 1);
    }
}

/**
 * 根据 sessionId 找到对应的手机卡片 taskId（sessionId/最新轮次）。
 * 与 scanTasks 的 taskId 生成规则保持一致。
 */
function taskIdForSession(sessionId) {
    try {
        const dir = path.join(CONFIG.tasksDir, sessionId);
        if (!fs.existsSync(dir)) return sessionId;
        const steps = fs.readdirSync(dir)
            .filter(f => /^\d+\.json$/.test(f))
            .sort((a, b) => parseInt(a) - parseInt(b));
        if (steps.length) return sessionId + '/' + steps[steps.length - 1].replace('.json', '');
    } catch (e) { /* ignore */ }
    return sessionId;
}

/**
 * 扫描 WorkBuddy 会话里真实发起的 AskUserQuestion，推送到手机端。
 * 首次调用只记录基线（把当前所有 pending 问题标记 seen 但不推），避免历史刷屏。
 */
let _questionsBaselined = false;
function pollRealQuestions() {
    try {
        const activeIds = wbActivity.getActiveSessionIds();
        const found = wbQuestions.scanOnce(activeIds, taskIdForSession);
        if (!_questionsBaselined) {
            // 基线：把启动瞬间已存在的问题登记为 seen，但不推送
            _questionsBaselined = true;
            console.log('[Question] 已建立问题基线，现有 pending 问题数:', found.length);
            return;
        }
        for (const rec of found) {
            const reqs = wbQuestions.toSelectionRequests(rec);
            let total = 0;
            for (const r of reqs) total += requestSelection(r.taskId, r);
            console.log('[Question] 推送真实 AskUserQuestion:', rec.sessionId.slice(0, 8),
                '问题', reqs.length, '个, 客户端收到', total, '次');
        }
        wbQuestions.prune();
    } catch (e) {
        console.error('[Question] 扫描异常:', e.message);
    }
}

// ============================================================
// 指令处理
// ============================================================

/**
 * 通过 UI 自动化把消息真正注入 WorkBuddy 输入框
 * （机器人点击输入框 → 粘贴 → 回车，绕开 CLI 认证墙）
 */
async function injectIntoWorkBuddy(message, sessionTitle, taskId) {
    const { sessionId, cwd } = wbAcp.taskIdToSession(taskId, CONFIG.projectsDir);

    // ★ 关键分流：目标会话若正被专属网关占用（活跃任务），ACP 通用网关投递会
    //   writer_occupied 阻塞数十秒 → 改走 UI 注入（对当前显示会话可靠）。
    //   空闲会话才走 ACP 精确投递 + jsonl 回写。
    const isActive = sessionId ? wbActivity.isSessionActive(sessionId) : false;
    console.log('[Inject] 会话', sessionId ? sessionId.slice(0, 8) : '(当前)',
        isActive ? '活跃(专属网关占用) → UI 注入' : '空闲 → ACP 投递');

    if (sessionId && !isActive) {
        console.log('[Inject] 走 ACP 通道 -> sessionId=' + sessionId.slice(0, 8) + ' cwd=' + cwd);
        const r = await wbAcp.sendPrompt(sessionId, cwd, message, {
            projectsDir: CONFIG.projectsDir,
            promptTimeoutMs: 30000,
        });
        if (r.ok) {
            console.log('[Inject] ACP 投递成功:', r.message);
            return {
                ok: true,
                output: r.message,
                channel: 'acp',
                writeBack: r.writeBack || null,
                sessionId,
            };
        }
        console.error('[Inject] ACP 失败，回退 UI 注入:', r.error);
    }

    // 活跃会话（或 ACP 失败）：优先 steer 实时注入 —— 纯 ACP 协议，**不依赖 Python**，
    // 分发包即使没装 Python 也能把消息送进正在执行的任务。
    if (sessionId) {
        const st = await wbControl.steerTo(sessionId, message);
        if (st.ok) {
            console.log('[Inject] steer 实时注入成功');
            return { ok: true, output: 'steered', channel: 'steer', sessionId };
        }
        console.log('[Inject] steer 未成功:', st.error || st.reason || 'unknown');
    }

    // 最后一路：UI 模拟注入（需要 Python，可选能力）
    if (!CONFIG.pythonExe) {
        return { ok: false, error: '未找到 Python，且 steer 注入失败', channel: 'none' };
    }
    return new Promise((resolve) => {
        const args = sessionTitle
            ? [CONFIG.injectScript, '--session', sessionTitle, message]
            : [CONFIG.injectScript, message];
        console.log('[Inject] 调用 UI 注入脚本:', args.slice(1, 3).join(' '), '...');
        execFile(
            CONFIG.pythonExe,
            args,
            { timeout: 30000, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) {
                    console.error('[Inject] 注入失败:', err.message, stderr);
                    resolve({ ok: false, error: err.message, channel: 'ui' });
                } else {
                    console.log('[Inject] UI 注入成功:', stdout.trim());
                    resolve({ ok: true, output: stdout.trim(), channel: 'ui' });
                }
            }
        );
    });
}

/**
 * 立即回执 + 异步执行真实操作，完成后推 command_result。
 * 所有控制按钮都走这里，避免同步 await 拖过客户端超时。
 * @param {object} ack 即时回执要覆盖 response 的字段（message/phase 等）
 * @param {function} work 异步执行函数，返回 { ok, message, ...extra }
 * @param {string} resultCommand command_result 里的 command 值
 */
function asyncControl(ws, response, ack, work, resultCommand) {
    Object.assign(response, ack);
    (async () => {
        let result;
        try {
            result = await work();
        } catch (e) {
            result = { ok: false, message: '执行异常: ' + e.message };
        }
        console.log('[Control] 完成:', resultCommand, result.message);
        if (ws.readyState === 1) {
            const out = {
                type: 'command_result',
                taskId: response.taskId,
                command: resultCommand,
                success: !!result.ok,
                message: result.message,
            };
            // 透传额外字段（channel/writeBack/detail 等）
            for (const k of ['channel', 'writeBack', 'detail', 'steerReason']) {
                if (result[k] !== undefined) out[k] = result[k];
            }
            ws.send(JSON.stringify(out));
        }
    })();
}

/**
 * 处理手机端发来的控制指令
 */
async function handleCommand(ws, data) {
    const { taskId, command, params } = data;

    console.log('[Command] 收到指令:', { taskId, command, params });

    let response = {
        type: 'command_response',
        taskId: taskId,
        command: command,
        success: true,
        message: '',
    };

    switch (command) {
        case 'send_message': {
            // 真正把消息送进 WorkBuddy 任务输入框
            const message = params?.message || '';
            if (!message) {
                response.success = false;
                response.message = '消息内容为空';
                break;
            }
            const sessionInfo = getSessionInfo(taskId);
            const targetTitle = sessionInfo.title || '';
            const targetNote = targetTitle ? `「${targetTitle}」` : (taskId ? String(taskId).slice(0, 8) : '当前会话');
            console.log('[Command] 正在投递消息到 WorkBuddy:',
                message.slice(0, 80), '| 目标会话:', targetTitle || taskId);

            // ★ 先立即回执（phase=accepted），解除客户端 5 秒超时。
            //   真正的投递异步执行，完成后用 command_result 再通知一次。
            response.message = `已收到，正在投递到 ${targetNote}…`;
            response.phase = 'accepted';
            // 异步投递，不 await —— 避免活跃会话 ACP/UI 注入耗时拖过客户端超时
            (async () => {
                let result;
                try {
                    result = await injectIntoWorkBuddy(message, targetTitle, taskId);
                } catch (e) {
                    result = { ok: false, error: e.message, channel: 'unknown' };
                }
                let finalMsg;
                if (result.ok) {
                    let channelNote = result.channel === 'acp' ? '精确投递' : 'UI 注入';
                    if (result.writeBack && result.writeBack.ok) {
                        channelNote += ' · 回复已写入会话记录';
                    } else if (result.channel === 'acp') {
                        channelNote += ' · 回复仅在 SSE（未落盘）';
                    }
                    finalMsg = `✅ 消息已送到 ${targetNote}（${channelNote}）`;
                } else {
                    finalMsg = '❌ 投递失败: ' + result.error;
                }
                console.log('[Command] 投递完成:', finalMsg);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: 'command_result',
                        taskId,
                        command: 'send_message',
                        success: result.ok,
                        message: finalMsg,
                        writeBack: result.writeBack || null,
                    }));
                }
            })();
            break;
        }
        case 'pause':
        case 'resume':
        case 'cancel':
        case 'retry':
        case 'select_option': {
            //  ★ 真实 AskUserQuestion 的回答回传：requestId 带 callId#qIndex
            let reqInfo = wbQuestions.resolveRequest(params?.requestId);
            const info = getSessionInfo(taskId);
            const sidInfo = wbAcp.taskIdToSession(taskId, CONFIG.projectsDir);
            // 服务端重启后内存记录会丢：从目标会话 jsonl 兜底捞回这个问题
            if (!reqInfo && params?.requestId && sidInfo.sessionId) {
                const callId = String(params.requestId).split('#')[0];
                reqInfo = wbQuestions.resolveFromSession(sidInfo.sessionId, callId, CONFIG.projectsDir);
                if (reqInfo) console.log('[Question] 内存无记录，已从会话文件捞回问题:', callId);
            }
            const targetTitle = info.title || '';
            const targetNote = targetTitle ? `「${targetTitle}」` : (taskId ? String(taskId).slice(0, 8) : '当前会话');

            if (reqInfo) {
                // 按 WorkBuddy 原生回答格式构造： " · 问题 → 选中label"
                const qidx = parseInt(String(params.requestId).split('#')[1] || '0', 10);
                const q = reqInfo.questions[qidx] || reqInfo.questions[0];
                const chosen = params.label || params.value || '';
                const answersText = ' · ' + (q?.question || '') + ' → ' + chosen;
                const answerMsg = '【用户回答】你刚才提出的问题，用户选择如下，请据此继续：\n' + answersText;
                console.log('[Question] 真实回答回传:', reqInfo.sessionId.slice(0, 8), '问题', qidx, '选择', chosen);
                clearPendingSelection(params?.requestId);
                asyncControl(ws, response,
                    { message: `已收到你的选择「${chosen}」，正在回传任务…`, phase: 'accepted' },
                    async () => {
                        // ① 原生答题：把选择真正填回 AskUserQuestion（与桌面端点选项同源）
                        const answers = {};
                        answers['q_' + qidx] = chosen;
                        if (q && q.question) answers[q.question] = chosen;
                        const ans = await wbControl.answerQuestion(
                            reqInfo.sessionId, reqInfo.callId, answers);
                        if (ans.ok) {
                            wbQuestions.markAnswered(reqInfo.callId);
                            return {
                                ok: true,
                                message: `✅ 已选择「${chosen}」，任务已按你的选择继续（原生回传）`,
                                channel: 'native',
                                detail: ans,
                            };
                        }
                        console.log('[Question] 原生答题未生效(' + ans.reason + ')，回退 steer 注入答案');
                        // ② steer 到该会话（活跃会话实时注入），把答案作为用户消息
                        const st = await wbControl.steerTo(reqInfo.sessionId, answerMsg);
                        if (st.ok) {
                            wbQuestions.markAnswered(reqInfo.callId);
                            return { ok: true, message: `✅ 已回传选择「${chosen}」到 ${targetNote}（实时注入）`, channel: 'steer', detail: st };
                        }
                        // 空闲会话回退 ACP prompt
                        const cwd = require('path').dirname(
                            require('./wb_jsonl_writer').findConversationFile(reqInfo.sessionId, CONFIG.projectsDir) || '.');
                        const r = await wbAcp.sendPrompt(reqInfo.sessionId, cwd, answerMsg,
                            { projectsDir: CONFIG.projectsDir, promptTimeoutMs: 45000 });
                        if (r.ok) wbQuestions.markAnswered(reqInfo.callId);
                        return r.ok
                            ? { ok: true, message: `✅ 已回传选择「${chosen}」到 ${targetNote}（会话空闲，作为消息投递）`, channel: 'acp', writeBack: r.writeBack }
                            : { ok: false, message: '❌ 回答回传失败: ' + r.error };
                    },
                    command);
                break;
            }

            // 普通选项回传（非监听到的真实问题）
            const labelMap = {
                pause: '暂停', resume: '继续', cancel: '取消', retry: '重试', select_option: '选项回传',
            };
            const label = labelMap[command];
            console.log('[Control] 收到真实控制指令:', command, '会话:', targetNote, 'sessionId:', sidInfo.sessionId);
            asyncControl(ws, response,
                { message: `已收到${label}指令，正在送达 ${targetNote}…`, phase: 'accepted' },
                async () => {
                    const r = await wbControl.controlAction(
                        sidInfo.sessionId, command, params || {}, CONFIG.projectsDir);
                    if (!r.ok) return { ok: false, message: `❌ ${label}失败: ` + (r.error || r.reason || '未知原因') };
                    const ch = r.channel === 'steer' ? '实时注入执行中会话'
                        : (r.channel === 'acp' ? '会话已空闲，作为消息投递' : r.channel);
                    return {
                        ok: true,
                        message: `✅ 已${label} ${targetNote}（${ch}）`,
                        channel: r.channel,
                        writeBack: r.writeBack || null,
                        detail: r.detail || null,
                        steerReason: r.steerReason || null,
                    };
                },
                command);
            break;
        }
        default:
            response.success = false;
            response.message = '未知指令: ' + command;
    }

    // 回执给客户端
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(response));
    }
}

// ============================================================
// HTTP 服务器
// ============================================================

const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 公开端点无需鉴权
    const isPublic = PUBLIC_ENDPOINTS.includes(req.url);

    // 请求日志（/token 是控制台高频健康探测，跳过避免刷屏）
    if (!isPublic) {
        const clientIp = (req.socket.remoteAddress || '').replace('::ffff:', '');
        console.log(`[HTTP] ${clientIp} ${req.method} ${req.url}`);
    }

    // 获取 token
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // 鉴权检查（公开端点除外）
    if (!isPublic && token !== TOKEN) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    // GET /tasks - 获取任务列表
    if (req.method === 'GET' && req.url === '/tasks') {
        const tasks = scanTasks();
        res.writeHead(200);
        res.end(JSON.stringify({ tasks: tasks }));
        return;
    }

    // GET /status - 运维状态：在线客户端数、活跃会话、待回答问题
    if (req.method === 'GET' && req.url === '/status') {
        let online = 0;
        wss.clients.forEach((c) => { if (c.readyState === 1) online += 1; });
        let activeSessions = [];
        try { activeSessions = [...wbActivity.getActiveSessionIds()]; } catch (e) { /* ignore */ }
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            onlineClients: online,
            activeSessions,
            questionsPushed: wbQuestions.stats ? wbQuestions.stats() : null,
        }));
        return;
    }

    // GET /conversation?taskId=xxx - 获取某任务最后一条对话内容
    // 用于手机上判断任务状态与后续操作
    if (req.method === 'GET' && req.url.startsWith('/conversation')) {
        const taskId = new URL(req.url, 'http://localhost').searchParams.get('taskId');
        if (!taskId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: '缺少 taskId' }));
            return;
        }
        const conv = readLastConversation(taskId);
        res.writeHead(200);
        res.end(JSON.stringify({ conversation: conv }));
        return;
    }

    // GET /token - 获取连接 token（用于首次配置）
    if (req.method === 'GET' && req.url === '/token') {
        // 关键：不能返回 0.0.0.0，那是"监听全部网卡"的占位地址，
        // 手机端无法访问。优先用请求头里的 Host（即手机实际访问到的地址），
        // 回退到本机第一个局域网 IP。
        const hostHeader = (req.headers.host || '').split(':')[0];
        const fallbackIp = getLanIPv4List()[0]?.address || '127.0.0.1';
        const reachableHost =
            hostHeader && hostHeader !== '0.0.0.0' ? hostHeader : fallbackIp;

        res.writeHead(200);
        res.end(JSON.stringify({
            token: TOKEN,
            endpoint: `ws://${reachableHost}:${CONFIG.port}/ws`,
        }));
        return;
    }

    // POST /selection - 任务主动发起选择请求，推送给手机端
    // body: { taskId, prompt, options: [{value, label}] }
    if (req.method === 'POST' && req.url === '/selection') {
        collectRequestBody(req, (err, body) => {
            if (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: '请求体解析失败: ' + err.message }));
                return;
            }

            let payload;
            try {
                payload = JSON.parse(body || '{}');
            } catch (parseErr) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'JSON 解析失败' }));
                return;
            }

            const { taskId, prompt, options } = payload || {};
            if (!taskId || !Array.isArray(options) || options.length === 0) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: '缺少 taskId 或 options' }));
                return;
            }

            const requestId = crypto.randomUUID();
            const pushed = requestSelection(taskId, {
                type: 'selection_request',
                requestId: requestId,
                taskId: taskId,
                prompt: prompt || '请做出选择',
                options: options.map((o) => ({
                    value: String(o.value),
                    label: String(o.label || o.value),
                })),
            });

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, requestId: requestId, pushed: pushed }));
        });
        return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
});

/**
 * 读取 HTTP 请求体
 */
function collectRequestBody(req, callback) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
            // 1MB 上限
            req.destroy();
            callback(new Error('请求体过大'));
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => callback(err));
}

// ============================================================
// HTTP 升级诊断（排查 WebSocket 连接失败）
// ============================================================

server.on('upgrade', (req) => {
    // 只记录，不拦截（WebSocketServer 会自行处理）
    const ip = req.socket.remoteAddress;
    const hasToken = /[?&]token=/.test(req.url || '');
    console.log(`[Upgrade] 来自 ${ip} 的 WebSocket 握手请求: ${req.url}`);
    if (!hasToken) {
        console.log('[Upgrade] 警告：URL 中未携带 token 参数');
    }
});

// ============================================================
// WebSocket 服务器
// ============================================================

const wss = new WebSocketServer({ 
    server,
    path: '/ws',
});

wss.on('connection', (ws, req) => {
    const wsIp = (req.socket.remoteAddress || '').replace('::ffff:', '');
    console.log(`[WS] 新连接 from ${wsIp}`);

    // Token 鉴权
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token !== TOKEN) {
        console.log('[WS] Token 验证失败');
        ws.close(1008, 'Unauthorized');
        return;
    }

    console.log('[WS] Token 验证通过');

    // 发送当前任务快照
    const tasks = scanTasks();
    ws.send(JSON.stringify({
        type: 'task_update',
        tasks: tasks,
    }));

    // 补推离线期间积累的选择请求
    try { flushPendingSelections(ws); } catch (e) { console.error('[Select] 补推异常:', e.message); }

    // 监听客户端消息
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'command') {
                handleCommand(ws, msg).catch(e => console.error('[Command] 处理异常:', e));
            } else {
                console.log('[WS] 未知消息类型:', msg.type);
            }
        } catch (err) {
            console.error('[WS] 消息解析失败:', err.message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS] 连接关闭 from ${wsIp} code=${code} reason=${reason && reason.toString ? reason.toString() : reason || ''}`);
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
    });
});

// ============================================================
// 启动
// ============================================================

server.listen(CONFIG.port, CONFIG.host, () => {
    const lanIps = getLanIPv4List();
    const primaryLanIp = lanIps[0]?.address || '未知';

    console.log('========================================');
    console.log('WorkBuddy 任务监控服务端已启动');
    console.log('========================================');
    console.log(`本机监听: http://${CONFIG.host}:${CONFIG.port}`);
    console.log('');
    console.log('>>> 手机端需要填写的地址（与电脑连接同一 WiFi） <<<');
    console.log(`WebSocket: ws://${primaryLanIp}:${CONFIG.port}/ws`);
    console.log(`Token:     ${TOKEN}`);
    console.log('');
    if (lanIps.length > 1) {
        console.log('其他可用网卡地址：');
        lanIps.forEach(({ name, address }) => {
            console.log(`  - ${address}  (${name})`);
        });
        console.log('');
    }
    console.log('提示: 手机端打开小程序 → 右上角「设置」→ 填入上面的地址和 Token');
    console.log('========================================');
    console.log('任务目录:', CONFIG.tasksDir);
    console.log('Python   :', CONFIG.pythonExe || '未检测到（UI 注入关闭，活跃会话走 steer，不影响使用）');
    console.log('========================================');

    // 首次扫描
    const tasks = scanTasks();
    console.log(`[Init] 发现 ${tasks.length} 个任务`);
    if (tasks.length > 0) {
        console.log('[Init] 最新任务:', tasks[0].title);
    }
});

// 定时扫描任务变化（每 2 秒）
setInterval(() => {
    broadcastTasks(wss);
}, 2000);

// 定时扫描真实 AskUserQuestion（每 2 秒），推送到手机端
setInterval(() => {
    pollRealQuestions();
}, 2000);

// 定时强制刷新会话标题（每 60 秒），捕捉新任务或改名
setInterval(() => {
    loadSessionTitles(true);
}, TITLE_REFRESH_MS);

console.log('[Monitor] 任务监控已启动（每 2 秒扫描一次）');
