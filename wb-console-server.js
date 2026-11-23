#!/usr/bin/env node
/**
 * WorkBuddy 任务监控 · 控制台（本地管理面板）
 *
 * 作用：给 48787 监控服务端配一个可视化管理界面
 *   - 展示服务端地址 / 局域网 IP / Token / 小程序连接串
 *   - 启动 / 停止 / 重启 / 重置 Token
 *   - 实时指标：在线手机数、会话数、活跃会话、待答问题
 *   - 实时日志 tail（monitor-out.log / monitor-err.log）
 *
 * 启动：node wb-console-server.js   → 浏览器打开 http://127.0.0.1:48790
 * 只绑定 127.0.0.1，不对外暴露（管理面板不需要给手机访问）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const VERSION = require('./version');

const ROOT = __dirname;
const MONITOR_SCRIPT = path.join(ROOT, 'workbuddy-monitor-server.js');
const LOG_OUT = path.join(ROOT, 'monitor-out.log');
const LOG_ERR = path.join(ROOT, 'monitor-err.log');
const LOG_OUT_PREV = path.join(ROOT, 'monitor-out.prev.log');
const LOG_ERR_PREV = path.join(ROOT, 'monitor-err.prev.log');
const STATE_FILE = path.join(ROOT, '.monitor-state.json');
const TOKEN_FILE = path.join(os.homedir(), '.workbuddy', '.monitor-token');
const CUSTOM_TOKEN_FILE = path.join(os.homedir(), '.workbuddy', '.monitor-token-custom');
const TASKS_DIR = path.join(os.homedir(), '.workbuddy', 'tasks');

const MONITOR_PORT = 48787;
const CONSOLE_BASE_PORT = 48790;
const CONSOLE_HOST = '127.0.0.1';

// ------------------------------------------------------------
// 工具
// ------------------------------------------------------------

function execP(file, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, timeout: 8000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 归档上一轮日志：启动时重定向会新建文件，先保留历史便于排查 */
function archive(from, to) {
    try {
        if (fs.existsSync(from) && fs.statSync(from).size > 0) {
            fs.renameSync(from, to);
        }
    } catch (e) { /* ignore */ }
}

function readToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return '';
        return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch (e) { return ''; }
}

function maskToken(t) {
    if (!t) return '';
    if (t.length <= 16) return t.slice(0, 4) + '••••';
    return t.slice(0, 8) + '••••••••••••••••' + t.slice(-6);
}

/** 本机所有可用 IPv4 网段（含虚拟网卡/WSL/Tailscale 等）。
 *  服务端监听 0.0.0.0，不拦截任何来源网段，因此这里全部列出，
 *  让用户知道从哪个地址都能接入；仅去重，不按网卡名过滤。 */
function getAddresses() {
    const list = [];
    const seen = new Set();
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const info of ifaces[name] || []) {
            if (info.family !== 'IPv4' || info.internal) continue;
            if (seen.has(info.address)) continue;
            seen.add(info.address);
            list.push({ name, address: info.address });
        }
    }
    // 优先 192.168 / 10. / 172.16-31
    const score = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
    list.sort((a, b) => score(a.address) - score(b.address));
    for (const it of list) {
        it.http = `http://${it.address}:${MONITOR_PORT}`;
        it.ws = `ws://${it.address}:${MONITOR_PORT}/ws`;
        it.isPrimary = false;
    }
    if (list[0]) list[0].isPrimary = true;
    return list;
}

/** 找监听 48787 的 PID（Windows: netstat；macOS/Linux: lsof 优先，netstat 回退） */
const IS_WIN = process.platform === 'win32';

async function findMonitorPid() {
    if (!IS_WIN) {
        // lsof -t 直接输出 PID 列表，最可靠
        const l = await execP('lsof', ['-nP', '-iTCP:' + MONITOR_PORT, '-sTCP:LISTEN', '-t']);
        const pid = parseInt(String(l.stdout).trim().split(/\s+/)[0], 10);
        if (pid > 0) return pid;
        // 回退 netstat（macOS 语法：tcp4 0 0 *.48787 *.* LISTEN <pid>）
        const r = await execP('netstat', ['-anv', '-p', 'tcp']);
        for (const line of String(r.stdout).split(/\r?\n/)) {
            if (!/LISTEN/i.test(line)) continue;
            const m = line.trim().split(/\s+/);
            const local = m[3] || '';
            if (!local.endsWith('.' + MONITOR_PORT)) continue;
            const pid = parseInt(m[m.length - 1], 10);
            if (pid > 0) return pid;
        }
        return 0;
    }
    const r = await execP('netstat', ['-ano', '-p', 'TCP']);
    const lines = r.stdout.split(/\r?\n/);
    for (const line of lines) {
        // TCP    0.0.0.0:48787    0.0.0.0:0    LISTENING    52780
        if (!/LISTENING/i.test(line)) continue;
        const m = line.trim().split(/\s+/);
        const local = m[1] || '';
        if (!local.endsWith(':' + MONITOR_PORT)) continue;
        const pid = parseInt(m[m.length - 1], 10);
        if (pid > 0) return pid;
    }
    return 0;
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(patch) {
    const s = { ...readState(), ...patch };
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { /* ignore */ }
    return s;
}

/** 探测 48787 是否健康 */
function probeMonitor() {
    return new Promise((resolve) => {
        const req = http.get({
            host: '127.0.0.1', port: MONITOR_PORT, path: '/token', timeout: 3000,
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try { resolve({ ok: res.statusCode === 200, data: JSON.parse(body) }); }
                catch (e) { resolve({ ok: false }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
        req.on('error', () => resolve({ ok: false }));
    });
}

/** 带 token 调 48787 /status */
function fetchStatus(token) {
    return new Promise((resolve) => {
        if (!token) return resolve(null);
        const req = http.get({
            host: '127.0.0.1', port: MONITOR_PORT, path: '/status', timeout: 2000,
            headers: { Authorization: 'Bearer ' + token },
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

function countSessions() {
    try {
        return fs.readdirSync(TASKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    } catch (e) { return 0; }
}

function tailFile(file, maxLines, maxBytes = 128 * 1024) {
    try {
        if (!fs.existsSync(file)) return { lines: [], size: 0 };
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - maxBytes);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const all = buf.toString('utf8').split(/\r?\n/);
        return { lines: all.slice(Math.max(0, all.length - maxLines)), size };
    } catch (e) { return { lines: ['[console] 读取日志失败: ' + e.message], size: 0 }; }
}

function clearLogs() {
    for (const f of [LOG_OUT, LOG_ERR]) {
        try { if (fs.existsSync(f)) fs.truncateSync(f, 0); } catch (e) { /* ignore */ }
    }
}

// ------------------------------------------------------------
// 进程控制
// ------------------------------------------------------------

let lastStartAt = readState().lastStartAt || 0;

async function doStart() {
    const existing = await findMonitorPid();
    if (existing) {
        return { ok: true, already: true, pid: existing, message: `服务端已在运行（PID ${existing}）` };
    }

    if (!IS_WIN) {
        // macOS/Linux：detached spawn 天然脱离父进程（无 job object），
        // 关闭控制台窗口/终端后服务端继续存活。日志用追加 fd。
        let outFd = null, errFd = null;
        try { outFd = fs.openSync(LOG_OUT, 'a'); } catch (e) {}
        try { errFd = fs.openSync(LOG_ERR, 'a'); } catch (e) {}
        try {
            const child = spawn(process.execPath, [MONITOR_SCRIPT], {
                cwd: ROOT,
                detached: true,
                stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'],
                env: { ...process.env },
            });
            child.unref();
        } catch (e) {
            return { ok: false, pid: 0, message: '启动失败: ' + e.message };
        } finally {
            if (outFd !== null) try { fs.closeSync(outFd); } catch (e) {}
            if (errFd !== null) try { fs.closeSync(errFd); } catch (e) {}
        }
    } else {
        // Windows：用 PowerShell Start-Process 拉起，彻底脱离控制台进程树：
        // 关闭控制台窗口 / 控制台被强杀时，服务端仍然存活。
        // RedirectStandardOutput 会新建文件，所以先把上一轮日志归档保留。
        archive(LOG_OUT, LOG_OUT_PREV);
        archive(LOG_ERR, LOG_ERR_PREV);

        const ps = [
            'Start-Process',
            `-FilePath '${process.execPath}'`,
            `-ArgumentList '${MONITOR_SCRIPT}'`,
            `-WorkingDirectory '${ROOT}'`,
            '-WindowStyle Hidden',
            `-RedirectStandardOutput '${LOG_OUT}'`,
            `-RedirectStandardError '${LOG_ERR}'`,
        ].join(' ');
        await execP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 15000 });
    }

    // 等待端口起来（最多 15s：服务端启动要载入 sqlite + 扫会话，偏慢）
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        const pid = await findMonitorPid();
        if (pid) {
            lastStartAt = Date.now();
            writeState({ lastStartAt, lastPid: pid });
            return { ok: true, pid, message: `服务端已启动（PID ${pid}）` };
        }
    }
    return { ok: false, pid: 0, message: '启动超时：未检测到 48787 端口监听，请看错误日志' };
}

async function doStop() {
    const pid = await findMonitorPid();
    if (!pid) return { ok: true, already: true, message: '服务端本来就没在运行' };
    if (IS_WIN) {
        await execP('taskkill', ['/F', '/PID', String(pid)]);
    } else {
        await execP('kill', ['-9', String(pid)]);
    }
    for (let i = 0; i < 20; i++) {
        await sleep(200);
        const still = await findMonitorPid();
        if (!still) {
            writeState({ lastStartAt: 0 });
            return { ok: true, pid, message: `服务端已停止（PID ${pid}）` };
        }
    }
    return { ok: false, pid, message: `停止失败：PID ${pid} 仍在监听 48787` };
}

async function doRestart() {
    const s = await doStop();
    await sleep(400);
    const t = await doStart();
    return {
        ok: t.ok,
        message: `${s.message}；${t.message}`,
        pid: t.pid || 0,
    };
}

async function doResetToken() {
    const hasCustom = readCustomToken() !== '';
    const stopped = await doStop();
    await sleep(300);
    let removed = false;
    try { if (fs.existsSync(TOKEN_FILE)) { fs.unlinkSync(TOKEN_FILE); removed = true; } } catch (e) {}
    const started = await doStart();
    const tail = hasCustom
        ? '（检测到自定义固定 Token，重启后仍会使用固定值；如需改成随机 Token，请先清除自定义 Token）'
        : '（新 Token 已生成）';
    return {
        ok: started.ok,
        message: `${stopped.message}；${removed ? '已删除旧 Token；' : ''}${started.message}${tail}`,
    };
}

/** 设置自定义固定 token：写入 .monitor-token-custom 并重启服务使其生效。
 *  传空字符串表示清除自定义 token（恢复自动生成模式）。 */
async function doSetToken(token) {
    const value = String(token || '').trim();
    try {
        if (value) {
            fs.writeFileSync(CUSTOM_TOKEN_FILE, value, { mode: 0o600 });
        } else {
            // 清除自定义 token：同时删除自定义文件和 tokenFile，
            // 否则服务端重启会回退读到 tokenFile 里残留的旧自定义值，无法真正恢复随机 token。
            if (fs.existsSync(CUSTOM_TOKEN_FILE)) fs.unlinkSync(CUSTOM_TOKEN_FILE);
            if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
        }
    } catch (e) {
        return { ok: false, message: '写入自定义 Token 失败: ' + e.message };
    }

    const restarted = await doRestart();
    return {
        ok: restarted.ok,
        message: value
            ? `已设置固定 Token，服务端已重启生效。手机端需用新 Token 重新连接。${restarted.message}`
            : `已清除固定 Token，恢复自动生成模式。${restarted.message}`,
    };
}

function readCustomToken() {
    try {
        if (!fs.existsSync(CUSTOM_TOKEN_FILE)) return '';
        return fs.readFileSync(CUSTOM_TOKEN_FILE, 'utf8').trim();
    } catch (e) { return ''; }
}

// ------------------------------------------------------------
// 状态汇总
// ------------------------------------------------------------

async function buildState() {
    const pid = await findMonitorPid();
    const token = readToken();
    const running = pid > 0;
    const health = running ? await probeMonitor() : { ok: false };
    const status = running && health.ok ? await fetchStatus(token) : null;
    const addresses = getAddresses();
    const outLog = tailFile(LOG_OUT, 5);
    const errLog = tailFile(LOG_ERR, 5);
    const now = Date.now();

    return {
        ok: true,
        time: now,
        console: {
            pid: process.pid,
            port: CONSOLE_PORT,
            uptimeSec: Math.round(process.uptime()),
            node: process.version,
            version: VERSION,
        },
        monitor: {
            running,
            healthy: !!(health.ok),
            pid: pid || 0,
            port: MONITOR_PORT,
            uptimeSec: running && lastStartAt ? Math.max(0, Math.round((now - lastStartAt) / 1000)) : 0,
            startedAt: lastStartAt || 0,
            clients: status?.onlineClients ?? 0,
            activeSessions: Array.isArray(status?.activeSessions) ? status.activeSessions.length : 0,
            activeSessionIds: status?.activeSessions || [],
            sessions: countSessions(),
            questions: status?.questionsPushed || null,
            lastOut: (outLog.lines || []).filter(Boolean).pop() || '',
            lastErr: (errLog.lines || []).filter(Boolean).pop() || '',
            outSize: outLog.size,
            errSize: errLog.size,
        },
        net: {
            addresses,
            primary: addresses[0] || null,
        },
        token: {
            value: token,
            masked: maskToken(token),
            exists: !!token,
            custom: !!readCustomToken(),   // 是否为自定义固定 token
        },
    };
}

// ------------------------------------------------------------
// HTTP 服务
// ------------------------------------------------------------

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); }
        });
    });
}

const HTML_FILE = path.join(ROOT, 'wb-console.html');

const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            const html = fs.readFileSync(HTML_FILE);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(html);
        }

        if (req.method === 'GET' && p === '/api/state') {
            return sendJson(res, 200, await buildState());
        }

        if (req.method === 'GET' && p === '/api/logs') {
            const lines = Math.min(1000, parseInt(url.searchParams.get('lines') || '200', 10));
            const src = url.searchParams.get('src') === 'err' ? LOG_ERR : LOG_OUT;
            const t = tailFile(src, lines);
            return sendJson(res, 200, { ok: true, src: src.endsWith('err.log') ? 'err' : 'out', lines: t.lines, size: t.size });
        }

        if (req.method === 'POST' && p === '/api/start') {
            return sendJson(res, 200, await doStart());
        }
        if (req.method === 'POST' && p === '/api/stop') {
            return sendJson(res, 200, await doStop());
        }
        if (req.method === 'POST' && p === '/api/restart') {
            return sendJson(res, 200, await doRestart());
        }
        if (req.method === 'POST' && p === '/api/token/reset') {
            return sendJson(res, 200, await doResetToken());
        }
        if (req.method === 'POST' && p === '/api/token/set') {
            const body = await readBody(req);
            return sendJson(res, 200, await doSetToken(body && body.token));
        }
        if (req.method === 'POST' && p === '/api/logs/clear') {
            clearLogs();
            return sendJson(res, 200, { ok: true, message: '日志已清空' });
        }

        // 打开文件夹（方便找日志/脚本）
        if (req.method === 'POST' && p === '/api/reveal') {
            execP('explorer.exe', [ROOT]);
            return sendJson(res, 200, { ok: true, message: '已打开项目目录' });
        }

        sendJson(res, 404, { ok: false, message: 'Not Found' });
    } catch (e) {
        sendJson(res, 500, { ok: false, message: String(e && e.message || e) });
    }
};

// ------------------------------------------------------------
// 端口探测 + 启动
// ------------------------------------------------------------

let CONSOLE_PORT = CONSOLE_BASE_PORT;

function listen(port) {
    return new Promise((resolve, reject) => {
        const s = http.createServer(handler);
        s.once('error', reject);
        s.listen(port, CONSOLE_HOST, () => resolve(s));
    });
}

(async () => {
    let server = null;
    for (let i = 0; i < 6; i++) {
        try {
            server = await listen(CONSOLE_BASE_PORT + i);
            CONSOLE_PORT = CONSOLE_BASE_PORT + i;
            break;
        } catch (e) {
            if (e.code !== 'EADDRINUSE') throw e;
        }
    }
    if (!server) {
        console.error('[Console] 48790-48795 端口全部被占用，无法启动控制台');
        process.exit(1);
    }
    const url = `http://${CONSOLE_HOST}:${CONSOLE_PORT}`;
    console.log('========================================');
    console.log(' 远程AI任务管家 · 控制台  v' + VERSION);
    console.log('========================================');
    console.log(` 打开: ${url}`);
    console.log(` 管理: 监控服务端 ${MONITOR_PORT} 端口`);
    console.log(' 关闭此窗口即停止控制台（不影响监控服务端）');
    console.log('');

    // 控制台启动时自动拉起监控服务端（若已在运行则跳过）
    try {
        const r = await doStart();
        console.log(r.already
            ? `[自动启动] 监控服务端已在运行（PID ${r.pid}）`
            : `[自动启动] ${r.message}`);
    } catch (e) {
        console.error('[自动启动] 失败:', e && e.message);
    }
    console.log('');
})();
