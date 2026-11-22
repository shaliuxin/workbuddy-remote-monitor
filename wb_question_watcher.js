/**
 * 真实 AskUserQuestion 监听器。
 *
 * 每轮扫描所有会话 jsonl 的尾部，检测 Agent 真实发起的 AskUserQuestion 工具调用
 * （type=function_call, name=AskUserQuestion），解析其 questions/options，
 * 转成 selection_request 推给手机端。用 callId 去重，已回答的不再推。
 *
 * jsonl 实证格式（2026-11-22，从 3c70967e 会话取证）：
 *   问题: {"type":"function_call","name":"AskUserQuestion","callId":"chatcmpl-tool-xxx",
 *          "arguments":"{\"questions\":[{\"question\":\"...\",\"header\":\"...\",
 *          \"options\":[{\"label\":\"...\",\"description\":\"...\"}]}]}", "sessionId":"..."}
 *   回答: {"type":"function_call_result","name":"AskUserQuestion","callId":"chatcmpl-tool-xxx",
 *          "output":{"text":" · 问题 → 选项label\n..."}}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.workbuddy', 'projects');

// callId -> { sessionId, taskId, questions, pushedAt, answered }
const _seen = new Map();

// file -> { mtimeMs, size } 未变则跳过，避免每 2 秒全量重读大文件
const _fileCache = new Map();
// 只读文件尾部（AskUserQuestion 一定出现在最近的消息里）
const TAIL_BYTES = 512 * 1024;

function readTail(file) {
    const st = fs.statSync(file);
    const prev = _fileCache.get(file);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return null; // 未变
    _fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size });
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        let txt = buf.toString('utf8');
        if (start > 0) {
            // 丢弃被截断的首行
            const nl = txt.indexOf('\n');
            txt = nl >= 0 ? txt.slice(nl + 1) : '';
        }
        return txt;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * 扫描一次，返回本轮【新发现且未回答】的问题数组。
 * @param {Set<string>} activeSessionIds 只监听当前活跃会话（可选；为空则全部）
 * @param {function} getTaskIdForSession (sessionId) => taskId（用于匹配手机卡片）
 */
function scanOnce(activeSessionIds, getTaskIdForSession) {
    const found = [];
    let files = [];
    try {
        for (const ws of fs.readdirSync(PROJECTS_DIR)) {
            const dir = path.join(PROJECTS_DIR, ws);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const f of fs.readdirSync(dir)) {
                if (/^[0-9a-f-]{36}\.jsonl$/i.test(f)) files.push(path.join(dir, f));
            }
        }
    } catch (e) { return found; }

    for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        if (activeSessionIds && activeSessionIds.size && !activeSessionIds.has(sessionId)) continue;
        let txt;
        try { txt = readTail(file); } catch (e) { continue; }
        if (txt === null) continue; // 文件未变化，跳过
        const lines = txt.split(/\r?\n/);

        const answeredCallIds = new Set();
        for (const line of lines) {
            if (!line || line.indexOf('"function_call_result"') < 0) continue;
            let o; try { o = JSON.parse(line); } catch (e) { continue; }
            if (o.type === 'function_call_result' && o.name === 'AskUserQuestion' && o.callId) {
                answeredCallIds.add(o.callId);
                if (_seen.has(o.callId)) _seen.get(o.callId).answered = true;
            }
        }

        for (const line of lines) {
            if (!line || line.indexOf('AskUserQuestion') < 0) continue;
            let o; try { o = JSON.parse(line); } catch (e) { continue; }
            if (o.type !== 'function_call' || o.name !== 'AskUserQuestion' || !o.callId) continue;
            if (answeredCallIds.has(o.callId)) continue; // 已回答，跳过
            if (_seen.has(o.callId)) continue;            // 已推送，跳过

            let args;
            try { args = JSON.parse(o.arguments || '{}'); } catch (e) { continue; }
            const questions = Array.isArray(args.questions) ? args.questions : [];
            if (!questions.length) continue;

            const taskId = getTaskIdForSession ? getTaskIdForSession(sessionId) : sessionId;
            const rec = { callId: o.callId, sessionId, taskId, questions, pushedAt: Date.now(), answered: false };
            _seen.set(o.callId, rec);
            found.push(rec);
        }
    }
    return found;
}

/**
 * 把一个 question 转成手机端的 selection_request。
 * 一个 AskUserQuestion 可能含多个 question，逐条推送（每条一个 requestId）。
 */
function toSelectionRequests(rec) {
    return rec.questions.map((q, idx) => ({
        type: 'selection_request',
        requestId: rec.callId + '#' + idx, // 携带 callId，回传时可定位
        callId: rec.callId,
        qIndex: idx,
        taskId: rec.taskId,
        sessionId: rec.sessionId,
        prompt: (q.header ? '【' + q.header + '】' : '') + (q.question || '请做出选择'),
        options: (q.options || []).map((op) => ({
            value: op.label,   // label 作为 value（WorkBuddy 回答记录用 label）
            label: op.label || op.description || '',
            description: op.description || '',
        })),
    }));
}

/** 根据 requestId 找回问题记录（用于回传答案） */
function resolveRequest(requestId) {
    if (!requestId) return null;
    const callId = String(requestId).split('#')[0];
    return _seen.get(callId) || null;
}

/**
 * 兜底：服务端重启后 _seen 为空，直接从目标会话 jsonl 里把该 callId 的问题捞回来。
 * （手机上的选项可能是重启前推下去的，点选时内存里已经没有记录）
 */
function resolveFromSession(sessionId, callId, projectsDir) {
    if (!sessionId || !callId) return null;
    const base = projectsDir || PROJECTS_DIR;
    let file = null;
    try {
        for (const ws of fs.readdirSync(base)) {
            const p = path.join(base, ws, sessionId + '.jsonl');
            if (fs.existsSync(p)) { file = p; break; }
        }
    } catch (e) { return null; }
    if (!file) return null;
    let txt;
    try { txt = readTail(file); } catch (e) { return null; }
    if (txt === null) {
        // 文件未变化（缓存跳过），直接读尾部
        try {
            const st = fs.statSync(file);
            const start = Math.max(0, st.size - TAIL_BYTES);
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(st.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            txt = buf.toString('utf8');
        } catch (e) { return null; }
    }
    for (const line of String(txt).split(/\r?\n/)) {
        if (!line || line.indexOf(callId) < 0) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type !== 'function_call' || o.name !== 'AskUserQuestion' || o.callId !== callId) continue;
        let args; try { args = JSON.parse(o.arguments || '{}'); } catch (e) { return null; }
        const questions = Array.isArray(args.questions) ? args.questions : [];
        if (!questions.length) return null;
        const rec = { callId, sessionId, taskId: sessionId, questions, pushedAt: Date.now(), answered: false };
        _seen.set(callId, rec);
        return rec;
    }
    return null;
}

/** 标记某问题已回答（避免重复推送） */
function markAnswered(callId) {
    const rec = _seen.get(callId);
    if (rec) rec.answered = true;
}

/** 清理过旧的记录（>2h），防止内存无限增长 */
function prune(maxAgeMs = 2 * 3600 * 1000) {
    const now = Date.now();
    for (const [k, v] of _seen) {
        if (now - v.pushedAt > maxAgeMs) _seen.delete(k);
    }
}

module.exports = {
    scanOnce, toSelectionRequests, resolveRequest, resolveFromSession, markAnswered, prune, PROJECTS_DIR,
    stats() {
        let answered = 0;
        for (const v of _seen.values()) if (v.answered) answered += 1;
        return { tracked: _seen.size, answered, pending: _seen.size - answered };
    },
};
