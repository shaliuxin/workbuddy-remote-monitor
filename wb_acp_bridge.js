/**
 * WorkBuddy ACP 桥接器 —— 通过内部 Gateway 的 ACP (JSON-RPC over SSE) 协议，
 * 按 sessionId 精确地把消息投递到指定 WorkBuddy 会话并触发 Agent 执行。
 *
 * 相比 UI 注入（wb_inject.py）的优势：
 *   - 不依赖窗口焦点 / 不被"活跃会话抢占"影响
 *   - 精确按 sessionId 投递，不依赖会话标题文本匹配
 *   - 支持查询执行状态、取消执行
 *
 * 通道来源（侦察所得，2026-11-22）：
 *   - WorkBuddy GUI 启动一个 codebuddy --serve 网关进程，监听 127.0.0.1:<port>
 *   - 认证：Authorization: Bearer <CODEBUDDY_GATEWAY_PASSWORD>
 *     （从 serve 进程环境变量读取；密码随进程重启会变，故运行时动态发现）
 *   - ACP 流程：POST /api/v1/acp/connect -> connectionId
 *               POST /api/v1/acp (initialize -> session/load -> session/prompt)
 *
 * 导出：
 *   discoverGateway()            -> { port, password } | null
 *   sendPrompt(sessionId, cwd, text, opts) -> { ok, runId?, error? }
 *   loadSession(sessionId, cwd)  -> { ok, error? }
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const jsonlWriter = require('./wb_jsonl_writer');

// 缓存发现结果（gateway 进程存活期间有效）
let _gatewayCache = null;
let _gatewayCacheAt = 0;
const GATEWAY_CACHE_MS = 60 * 1000;

// Python 解释器（用于读进程环境拿 gateway 密码）
const PYTHON_EXE = 'C:/Users/mingh/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const READENV_SCRIPT = path.join(__dirname, '.workbuddy', '_readenv.py');

/** 发 HTTP 请求，返回 { status, body } */
function httpRequest(port, method, urlPath, headers, body, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const opts = {
            host: '127.0.0.1',
            port,
            method,
            path: urlPath,
            headers: Object.assign({}, headers),
            timeout: timeoutMs,
        };
        if (data) {
            opts.headers['Content-Length'] = Buffer.byteLength(data, 'utf8');
        }
        const req = http.request(opts, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
        req.on('error', (e) => resolve({ status: 0, body: 'ERR: ' + e.message }));
        if (data) req.write(data);
        req.end();
    });
}

/**
 * 发现 gateway：找到 codebuddy --serve 进程（Windows），读它的监听端口和
 * CODEBUDDY_GATEWAY_PASSWORD。用 netstat + 读进程环境的组合。
 */
const IS_WIN = process.platform === 'win32';

/**
 * macOS/Linux 实现：
 * 1) `ps -axww -o pid=,args=` 找 codebuddy --serve 进程；
 * 2) `ps -Eww -p <pid>` 读环境变量里的 CODEBUDDY_GATEWAY_PASSWORD
 *    （macOS 允许同用户进程读取；新版系统可能拒绝 → 返回 null，控制指令自动降级不可用）；
 * 3) `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` 找监听端口。
 */
function discoverGatewayUnix() {
    // 1) 枚举 gateway 进程（优先带 --session-id 的专属网关，其次通用网关）
    let pids = [];
    try {
        const psOut = execFileSync('ps', ['-axww', '-o', 'pid=,args='], {
            encoding: 'utf8', timeout: 10000,
        });
        const serve = [];
        for (const line of psOut.split(/\r?\n/)) {
            if (!/codebuddy/i.test(line) || !/--serve/.test(line)) continue;
            const pm = line.trim().match(/^(\d+)\s+(.*)$/);
            if (!pm) continue;
            serve.push({ pid: pm[1], hasSession: /--session-id/i.test(pm[2]) });
        }
        pids = serve;
    } catch (e) { /* ignore */ }
    if (!pids.length) return null;

    // 2) 读密码：优先专属网关进程
    let password = null;
    let gatewayPid = null;
    for (const { pid } of pids) {
        try {
            const env = execFileSync('ps', ['-Eww', '-p', pid], {
                encoding: 'utf8', timeout: 8000,
            });
            const m = env.match(/CODEBUDDY_GATEWAY_PASSWORD=(\S+)/);
            if (m) { password = m[1]; gatewayPid = parseInt(pid, 10); break; }
        } catch (e) { /* ignore */ }
    }
    if (!password) return null;

    // 3) 找监听端口
    let port = null;
    if (gatewayPid) {
        try {
            const out = execFileSync('lsof',
                ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(gatewayPid)],
                { encoding: 'utf8', timeout: 8000 });
            const m = out.match(/TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)/);
            if (m) port = parseInt(m[1], 10);
        } catch (e) { /* ignore */ }
    }
    return { password, port, pid: gatewayPid };
}

function discoverGatewaySync() {
    if (_gatewayCache && (Date.now() - _gatewayCacheAt) < GATEWAY_CACHE_MS) {
        return _gatewayCache;
    }
    if (!IS_WIN) {
        return discoverGatewayUnix();
    }
    // 用 Python --auto 自动发现：枚举 WorkBuddy 进程，读环境里的 gateway 密码。
    // 不依赖 wmic / PowerShell（本环境 wmic 不存在，Bash 调 PowerShell 被安全策略拦）。
    let password = null;
    let gatewayPid = null;
    try {
        const out = execFileSync(PYTHON_EXE, [READENV_SCRIPT, '--auto'], {
            encoding: 'utf8', timeout: 20000, windowsHide: true,
        });
        const m = out.match(/GATEWAY\s+(\d+)\s+(\S+)/);
        if (m) { gatewayPid = parseInt(m[1], 10); password = m[2].trim(); }
    } catch (e) { /* ignore */ }
    if (!password) return null;

    // 找 gateway PID 的监听端口（netstat 可用）
    let port = null;
    try {
        const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        const re = new RegExp('127\\.0\\.0\\.1:(\\d+)\\s+[^\\s]+\\s+LISTENING\\s+' + gatewayPid + '\\b');
        const m = netstat.match(re);
        if (m) port = parseInt(m[1], 10);
    } catch (e) { /* ignore */ }

    return { password, port, pid: gatewayPid };
}

/** 异步完整发现（含端口探测），返回 {port,password} 或 null */
async function discoverGateway() {
    const found = discoverGatewaySync();
    if (!found || !found.password) return null;
    if (found.port) {
        // 验证端口可用
        const h = await httpRequest(found.port, 'GET', '/api/v1/health',
            { Authorization: 'Bearer ' + found.password }, null, 5000);
        if (h.status === 200 && h.body.includes('"ok"')) return found;
    }
    // 端口未知：探测所有 127.0.0.1 监听端口
    let candidatePorts = [];
    try {
        if (IS_WIN) {
            const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
            const re = /127\.0\.0\.1:(\d+)\s+[^\s]+\s+LISTENING/g;
            let m;
            while ((m = re.exec(netstat)) !== null) {
                const p = parseInt(m[1], 10);
                if (p > 1024) candidatePorts.push(p);
            }
        } else {
            const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
                encoding: 'utf8', timeout: 10000,
            });
            const re = /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s/g;
            let m;
            while ((m = re.exec(out)) !== null) {
                const p = parseInt(m[1], 10);
                if (p > 1024) candidatePorts.push(p);
            }
        }
    } catch (e) { /* ignore */ }
    candidatePorts = [...new Set(candidatePorts)];
    for (const port of candidatePorts) {
        const h = await httpRequest(port, 'GET', '/api/v1/health',
            { Authorization: 'Bearer ' + found.password }, null, 2000);
        if (h.status === 200 && h.body.includes('"ok"')) {
            const gw = { port, password: found.password };
            _gatewayCache = gw;
            _gatewayCacheAt = Date.now();
            return gw;
        }
    }
    return null;
}

/**
 * 发一个 ACP JSON-RPC 请求，收集 SSE 流里的 JSON-RPC result（按 id 匹配）。
 */
async function acpRpc(gw, connectionId, id, method, params, timeoutMs = 60000) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const res = await httpRequest(gw.port, 'POST', '/api/v1/acp', {
        Authorization: 'Bearer ' + gw.password,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'acp-connection-id': connectionId,
    }, body, timeoutMs);

    // 解析 SSE：每行 "data: {...}"，找 id 匹配的 result/error
    let rpcResult = null;
    const lines = res.body.split(/\r?\n/);
    for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const msg = JSON.parse(payload);
            if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
                rpcResult = msg;
            }
        } catch (e) { /* 非 JSON data 行，忽略 */ }
    }
    return { http: res, rpc: rpcResult };
}

/** 建立 ACP 连接：connect -> initialize，返回 { connectionId } */
async function acpConnect(gw) {
    const c = await httpRequest(gw.port, 'POST', '/api/v1/acp/connect', {
        Authorization: 'Bearer ' + gw.password,
        'Content-Type': 'application/json',
    }, '{}', 10000);
    if (c.status !== 200) throw new Error('acp/connect 失败: ' + c.body.slice(0, 200));
    const conn = JSON.parse(c.body);
    const connectionId = conn.connectionId;

    const init = await acpRpc(gw, connectionId, 1, 'initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'workbuddy-monitor-bridge', version: '1.0' },
        clientCapabilities: {},
    }, 15000);
    if (init.rpc && init.rpc.error) throw new Error('initialize 失败: ' + JSON.stringify(init.rpc.error));
    return { connectionId, sessionToken: conn.sessionToken };
}

/**
 * 加载会话（可选，prompt 前调用以确保会话上下文就绪）。
 */
async function loadSession(gw, connectionId, sessionId, cwd) {
    const r = await acpRpc(gw, connectionId, 2, 'session/load', {
        sessionId,
        cwd: cwd || process.cwd().replace(/\\/g, '/'),
        mcpServers: [],
    }, 60000);
    if (r.rpc && r.rpc.error) return { ok: false, error: JSON.stringify(r.rpc.error) };
    return { ok: true };
}

/**
 * 按 sessionId 精确投递消息并触发 Agent。
 * @param {string} sessionId 目标会话 UUID
 * @param {string} cwd 会话工作目录（可选，用于 session/load）
 * @param {string} text 消息正文
 * @param {object} opts { loadFirst: true } 是否先 session/load
 */
async function sendPrompt(sessionId, cwd, text, opts = {}) {
    try {
        const gwBase = await discoverGateway();
        if (!gwBase) return { ok: false, error: '无法发现 WorkBuddy gateway (端口/密码)' };
        // opts.gatewayPort：改用目标会话【自己的】专属网关（--session-id），
        // 它原生持久化，且持有该会话 runtime，能直接 prompt 起新回合。
        const gw = opts.gatewayPort
            ? { port: opts.gatewayPort, password: gwBase.password, pid: null }
            : gwBase;
        if (opts.gatewayPort) opts.loadFirst = false; // 已绑定会话，无需 session/load

        const conn = await acpConnect(gw);

        if (opts.loadFirst !== false) {
            const lr = await loadSession(gw, conn.connectionId, sessionId, cwd);
            if (!lr.ok) return { ok: false, error: 'session/load 失败: ' + lr.error };
        }

        const r = await acpRpc(gw, conn.connectionId, 3, 'session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text }],
        }, opts.promptTimeoutMs || 60000);
        if (r.rpc && r.rpc.error) {
            return { ok: false, error: 'session/prompt 失败: ' + JSON.stringify(r.rpc.error) };
        }
        // 检查 SSE 流里是否出现 model_requesting（表示 Agent 已开始执行）
        const started = r.http.body.includes('model_requesting') || r.http.body.includes('"result"');

        // ★ 回写 jsonl：ACP 通用网关不落盘，这里把 SSE 里的真实回复按原生格式
        //   追加到目标会话文件，使 WorkBuddy UI / 对话历史可见。失败不影响投递成功。
        let writeBack = { ok: false, error: '未执行' };
        if (opts.writeBack !== false && !opts.gatewayPort) {
            try {
                const reply = jsonlWriter.parseSseReply(r.http.body);
                if (reply.text) {
                    const file = jsonlWriter.findConversationFile(sessionId, opts.projectsDir);
                    if (file) {
                        writeBack = jsonlWriter.appendExchange(file, sessionId, text, reply);
                        console.log('[ACP writeBack] 会话', sessionId.slice(0, 8),
                            writeBack.ok ? ('已追加 ' + writeBack.appended + ' 行, 回复 ' + writeBack.textLen + ' 字')
                                         : ('失败: ' + writeBack.error));
                    } else {
                        writeBack = { ok: false, error: '找不到 session 的 jsonl 文件' };
                    }
                } else {
                    writeBack = { ok: false, error: 'SSE 中无 assistant 文本（可能执行未完成）' };
                }
            } catch (e) {
                writeBack = { ok: false, error: '回写异常: ' + e.message };
            }
        }

        return {
            ok: true,
            started,
            writeBack,
            message: '消息已通过 ACP 投递到会话 ' + sessionId.slice(0, 8) +
                (writeBack.ok ? '，回复已回写对话记录' : ''),
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** 让服务端用的便捷函数：从 taskId 推断 sessionId 和 cwd */
function taskIdToSession(taskId, projectsDir) {
    const sid = String(taskId || '').split('/')[0];
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return { sessionId: null, cwd: null };
    let cwd = null;
    try {
        const base = projectsDir || path.join(os.homedir(), '.workbuddy', 'projects');
        for (const ws of fs.readdirSync(base)) {
            const f = path.join(base, ws, sid + '.jsonl');
            if (fs.existsSync(f)) { cwd = path.dirname(f); break; }
        }
    } catch (e) { /* ignore */ }
    return { sessionId: sid, cwd };
}

module.exports = {
    discoverGateway,
    discoverGatewaySync,
    acpConnect,
    acpRpc,
    loadSession,
    sendPrompt,
    taskIdToSession,
};

// 直接运行 = 自测
if (require.main === module) {
    (async () => {
        const [, , sessionId, cwd, ...msgParts] = process.argv;
        if (!sessionId || !msgParts.length) {
            console.log('用法: node wb_acp_bridge.js <sessionId> <cwd> <消息...>');
            process.exit(1);
        }
        const gw = await discoverGateway();
        console.log('Gateway:', gw ? ('port ' + gw.port) : '未发现');
        if (!gw) process.exit(2);
        const r = await sendPrompt(sessionId, cwd, msgParts.join(' '));
        console.log('结果:', JSON.stringify(r));
        process.exit(r.ok ? 0 : 1);
    })();
}
