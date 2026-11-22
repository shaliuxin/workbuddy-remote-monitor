/**
 * 检测哪些 WorkBuddy 会话当前有专属 serve 网关进程（--session-id <uuid>），
 * 即会话正被 Agent 占用 writer。此类会话用通用网关 ACP 投递会阻塞/失败，
 * 应改走 UI 注入；空闲会话才适合 ACP + 回写。
 *
 * 方法：_readenv.py --auto 拿到所有 gateway PID（可靠），
 *       _readcmd.py <pids...> 读命令行，正则提取 --session-id <uuid>。
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const PYTHON_EXE = 'C:/Users/mingh/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const READENV = path.join(__dirname, '.workbuddy', '_readenv.py');
const READCMD = path.join(__dirname, '.workbuddy', '_readcmd.py');

const IS_WIN = process.platform === 'win32';
const SESSION_ID_RE = /--session-id\s+([0-9a-f]{8}-[0-9a-f-]{27,})/i;

/**
 * macOS/Linux 实现：
 * 1) `ps -axww -o pid=,args=` 枚举进程，找 codebuddy --serve（可含 --session-id）；
 * 2) `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` 反查该进程的 127.0.0.1 监听端口。
 */
function scanSessionsUnix() {
    const map = new Map();
    let gwPids = [];
    try {
        const psOut = execFileSync('ps', ['-axww', '-o', 'pid=,args='], {
            encoding: 'utf8', timeout: 10000,
        });
        for (const line of psOut.split(/\r?\n/)) {
            if (!/codebuddy/i.test(line) || !/--serve/.test(line)) continue;
            const pm = line.trim().match(/^(\d+)\s+(.*)$/);
            if (!pm) continue;
            const sm = pm[2].match(SESSION_ID_RE);
            gwPids.push({ pid: pm[1], sid: sm ? sm[1].toLowerCase() : null });
        }
    } catch (e) { /* ignore */ }
    for (const { pid, sid } of gwPids) {
        if (!sid) continue; // 通用网关（--no-session-persistence）跳过
        let port = null;
        try {
            const out = execFileSync('lsof',
                ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
                { encoding: 'utf8', timeout: 8000 });
            const m = out.match(/TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)/);
            if (m) port = parseInt(m[1], 10);
        } catch (e) { /* ignore */ }
        map.set(sid, { pid: parseInt(pid, 10), port });
    }
    return map;
}

let _cache = { map: new Map(), at: 0 };
const CACHE_MS = 4000;

/**
 * 扫描所有 gateway 进程：返回 Map<sessionId, { pid, port }>。
 * 注意：通用网关（--no-session-persistence）没有 --session-id，会被排除。
 * 端口从 netstat 的 LISTENING 行按 PID 反查。
 */
function scanSessions(force) {
    if (!force && _cache.map && _cache.map.size && (Date.now() - _cache.at) < CACHE_MS) {
        return _cache.map;
    }
    if (!IS_WIN) {
        _cache = { map: scanSessionsUnix(), at: Date.now() };
        return _cache.map;
    }
    const map = new Map();
    try {
        const envOut = execFileSync(PYTHON_EXE, [READENV, '--auto'], {
            encoding: 'utf8', timeout: 15000, windowsHide: true,
        });
        const pidSessions = new Map();
        for (const line of envOut.split(/\r?\n/)) {
            const m = line.match(/^GATEWAY\s+(\d+)/);
            if (m) pidSessions.set(m[1], null);
        }
        if (pidSessions.size) {
            const cmdOut = execFileSync(PYTHON_EXE, [READCMD, ...pidSessions.keys()], {
                encoding: 'utf8', timeout: 20000, windowsHide: true,
            });
            // 每行格式：PID <pid> :: <命令行>，从命令行提取 --session-id
            for (const line of cmdOut.split(/\r?\n/)) {
                const pm = line.match(/^PID\s+(\d+)\s+::/);
                if (!pm) continue;
                const sm = line.match(/--session-id\s+([0-9a-f]{8}-[0-9a-f-]{27,})/i);
                if (sm) pidSessions.set(pm[1], sm[1].toLowerCase());
            }
        }
        // netstat: 找每个 PID 的 127.0.0.1 监听端口
        let listening = '';
        try {
            listening = execFileSync('netstat', ['-ano'], {
                encoding: 'utf8', timeout: 10000, windowsHide: true,
            });
        } catch (e) { /* ignore */ }
        for (const [pid, sid] of pidSessions) {
            if (!sid) continue; // 通用网关跳过
            let port = null;
            const re = new RegExp('127\\.0\\.0\\.1:(\\d+)\\s+\\S+\\s+LISTENING\\s+' + pid + '\\b', 'i');
            const m = listening.match(re);
            if (m) port = parseInt(m[1], 10);
            map.set(sid, { pid: parseInt(pid, 10), port });
        }
    } catch (e) { /* ignore */ }
    _cache = { map, at: Date.now() };
    return map;
}

/** 返回当前有专属网关的 sessionId 集合（这些会话"忙碌"） */
function getActiveSessionIds(force) {
    return new Set(scanSessions(force).keys());
}

/** 返回 Map<sessionId, {pid, port}>，用于对该会话网关发 steer */
function getSessionPorts(force) {
    return scanSessions(force);
}

/** 某会话专属网关的端口；无专属网关返回 null */
function getSessionPort(sessionId) {
    if (!sessionId) return null;
    const info = scanSessions().get(String(sessionId).toLowerCase());
    return info ? info.port : null;
}

/** 判断某 sessionId 是否当前有专属网关（忙碌） */
function isSessionActive(sessionId) {
    if (!sessionId) return false;
    return scanSessions().has(String(sessionId).toLowerCase());
}

module.exports = { scanSessions, getActiveSessionIds, getSessionPorts, getSessionPort, isSessionActive };

if (require.main === module) {
    console.log('sessions:', JSON.stringify([...scanSessions(true).entries()]));
}
