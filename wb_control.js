/**
 * WorkBuddy 任务控制桥接：把手机端的 pause / resume / cancel / retry / select_option
 * 变成对目标会话的**真实协议操作**，而不是本地模拟回执。
 *
 * 能力来源（2026-11-22 从 CLI bundle 实证）：
 *   - ACP `session/steer`：向【活跃会话】正在执行的 Agent 实时注入一条用户消息
 *     （源码：handleSteer -> getRuntimeSession + isSteerableRunStatus + SteerInputBuffer）。
 *     参数 { sessionId, contentBlocks:[{type:'text',text}] }，返回 { steered, reason }。
 *     会话空闲时返回 { steered:false, reason:'idle' }。
 *   - 专属网关 `codebuddy --serve --session-id <uuid>`：每个活跃会话一个，持有该会话
 *     writer。steer 必须连到目标会话【自己的】专属网关端口才生效。
 *   - ACP `session/prompt`（经通用网关 + jsonl 回写）：对【空闲会话】可靠，作兜底。
 *
 * 注意：WorkBuddy 没有原生 pause/cancel turn 的 ACP 方法（session/cancel、
 * session/pause 均 Method not found）。因此 pause/resume/cancel 的真实语义是
 * "向会话注入一条明确的远程控制指令文本"，由 Agent 在下一个工具间隙消费执行。
 * 这比纯模拟回执真实得多——指令确实进入了目标会话并影响 Agent 行为。
 */
'use strict';

const bridge = require('./wb_acp_bridge');
const activity = require('./wb_session_activity');
const jsonlWriter = require('./wb_jsonl_writer');

/** 远程控制指令文本模板 */
const CONTROL_TEXT = {
    pause: '【远程控制·暂停】请立即暂停当前任务：停止执行任何工具调用，保留当前进度，等待我进一步指示。暂停后不要继续操作。',
    resume: '【远程控制·继续】请继续执行刚才暂停的任务，从中断处接着往下做。',
    cancel: '【远程控制·取消】请立即终止当前任务：不要再执行任何工具调用或文件修改，简要说明已停止即可。',
};

/**
 * ★ 切换会话模型（ACP `session/set_model`，2026-11-22 网关实证可用）。
 *   参数 { sessionId, modelId }，返回 { modelId } 并广播 session/update
 *   （sessionUpdate: config_option_update），下一轮对话即用新模型。
 * 路由：
 *   - 活跃会话（有专属网关）：直接在专属网关上 set_model（桌面端已加载会话，无需 load）
 *   - 空闲会话：通用网关 load 后 set_model
 * @returns { ok, channel, reason?, raw? }
 */
async function setSessionModel(sessionId, modelId, opts = {}) {
    const sid = String(sessionId || '');
    if (!sid || !modelId) return { ok: false, reason: 'bad-params' };
    const gwBase = await bridge.discoverGateway();
    if (!gwBase) return { ok: false, reason: 'no-gateway-password' };

    const port = activity.getSessionPort(sid);
    // 1) 活跃会话 → 专属网关直接切
    if (port) {
        const gw = { port: port.port, password: gwBase.password, pid: null };
        try {
            const conn = await bridge.acpConnect(gw);
            const r = await bridge.acpRpc(gw, conn.connectionId, 41, 'session/set_model',
                { sessionId: sid, modelId }, 10000);
            if (r.rpc && !r.rpc.error) {
                return { ok: true, channel: 'dedicated-gateway', raw: r.rpc.result };
            }
            console.log('[Model] 专属网关 set_model 失败:',
                JSON.stringify((r.rpc && r.rpc.error) || {}).slice(0, 150), '→ 回退通用网关');
        } catch (e) {
            console.log('[Model] 专属网关异常:', e.message, '→ 回退通用网关');
        }
    }
    // 2) 空闲会话 → 通用网关（load 后切；load 失败也照样尝试）
    try {
        const conn = await bridge.acpConnect(gwBase);
        const loaded = await bridge.loadSession(gwBase, conn.connectionId, sid, opts.cwd);
        if (!loaded.ok) {
            console.log('[Model] session/load 失败(仍尝试 set_model):', String(loaded.error).slice(0, 120));
        }
        const r = await bridge.acpRpc(gwBase, conn.connectionId, 42, 'session/set_model',
            { sessionId: sid, modelId }, 10000);
        if (r.rpc && r.rpc.error) {
            return { ok: false, reason: 'rpc-error: ' + JSON.stringify(r.rpc.error).slice(0, 200) };
        }
        return { ok: true, channel: port ? 'generic-gateway' : 'generic-gateway-loaded', raw: r.rpc.result };
    } catch (e) {
        return { ok: false, reason: 'exception: ' + e.message };
    }
}

/**
 * 向【活跃会话】注入 steer 指令。
 * @returns { ok, steered, reason, channel:'steer', port } —— steered=false 时调用方应回退
 */
async function steerTo(sessionId, text, opts = {}) {
    const sid = String(sessionId || '');
    const port = activity.getSessionPort(sid);
    if (!port) return { ok: false, steered: false, reason: 'no-dedicated-gateway', channel: 'steer' };

    const gwBase = await bridge.discoverGateway();
    if (!gwBase) return { ok: false, steered: false, reason: 'no-gateway-password', channel: 'steer' };
    // 专属网关与通用网关共享 gateway 密码（health 已验证同一 token 可用）
    const gw = { port, password: gwBase.password, pid: null };

    try {
        const conn = await bridge.acpConnect(gw);
        const r = await bridge.acpRpc(gw, conn.connectionId, 21, 'session/steer', {
            sessionId: sid,
            contentBlocks: [{ type: 'text', text }],
        }, opts.timeoutMs || 20000);
        if (r.rpc && r.rpc.error) {
            return { ok: false, steered: false, reason: 'rpc-error: ' + JSON.stringify(r.rpc.error), channel: 'steer', port };
        }
        const result = (r.rpc && r.rpc.result) || {};
        return {
            ok: !!result.steered,
            steered: !!result.steered,
            reason: result.reason || (result.steered ? 'steered' : 'unknown'),
            channel: 'steer',
            port,
            raw: result,
        };
    } catch (e) {
        return { ok: false, steered: false, reason: 'exception: ' + e.message, channel: 'steer', port };
    }
}

/**
 * ★ 原生回答 AskUserQuestion。
 *
 * WorkBuddy 网关扩展方法 `_codebuddy.ai/resolveInterruption`（源码 handleResolveInterruption）：
 *   参数 { sessionId, toolCallId, decision:'allow', answers }
 *   answers 的 key 可以是 question 文本、question.id，或 `q_<序号>`；value 是选中的答案文本。
 *   对 AskUserQuestion 会走 askService.doneAsk(answers, toolCallId) 真正把答案填回工具调用，
 *   Agent 随即按用户的选择继续执行 —— 这是与桌面端点击选项完全同源的通路。
 *
 * @param {string} sessionId 目标会话
 * @param {string} callId AskUserQuestion 的 toolCallId
 * @param {object} answers 例如 { q_0: '选项A' }
 */
async function answerQuestion(sessionId, callId, answers, opts = {}) {
    const sid = String(sessionId || '');
    if (!sid || !callId) return { ok: false, reason: 'missing-session-or-callId', channel: 'resolveInterruption' };
    const port = activity.getSessionPort(sid);
    if (!port) return { ok: false, reason: 'no-dedicated-gateway', channel: 'resolveInterruption' };

    const gwBase = await bridge.discoverGateway();
    if (!gwBase) return { ok: false, reason: 'no-gateway-password', channel: 'resolveInterruption' };
    const gw = { port, password: gwBase.password, pid: null };

    try {
        const conn = await bridge.acpConnect(gw);
        const r = await bridge.acpRpc(gw, conn.connectionId, 31, '_codebuddy.ai/resolveInterruption', {
            sessionId: sid,
            toolCallId: callId,
            decision: 'allow',
            answers: answers || {},
        }, opts.timeoutMs || 20000);
        if (r.rpc && r.rpc.error) {
            return { ok: false, reason: 'rpc-error: ' + JSON.stringify(r.rpc.error), channel: 'resolveInterruption', port };
        }
        const result = (r.rpc && r.rpc.result) || {};
        // resolved=true 表示答案已注入；queued=true 表示问题尚未挂起（已记为提前回答）
        return {
            ok: !!result.resolved || !!result.queued,
            resolved: !!result.resolved,
            queued: !!result.queued,
            reason: result.resolved ? 'resolved' : (result.queued ? 'queued' : 'not-resolved'),
            channel: 'resolveInterruption',
            port,
            raw: result,
        };
    } catch (e) {
        return { ok: false, reason: 'exception: ' + e.message, channel: 'resolveInterruption', port };
    }
}

/** 从会话 jsonl 提取最后一条用户消息（用于 retry），排除远程控制注入模板 */function lastUserText(sessionId, projectsDir) {
    const file = jsonlWriter.findConversationFile(sessionId, projectsDir);
    if (!file) return null;
    try {
        const lines = require('fs').readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            let o;
            try { o = JSON.parse(lines[i]); } catch (e) { continue; }
            if (o.type !== 'message' || o.role !== 'user') continue;
            const text = (o.content || []).map((c) => (c && c.text) || '').join('').trim();
            if (!text || /^【远程控制[·•]/.test(text)) continue;
            return text;
        }
    } catch (e) { /* ignore */ }
    return null;
}

/**
 * 统一控制入口。
 * @param {string} sessionId 目标会话
 * @param {string} action pause|resume|cancel|retry|select_option
 * @param {object} params 动作参数（select_option 用 value/label）
 * @param {string} projectsDir 会话 jsonl 根目录
 */
async function controlAction(sessionId, action, params = {}, projectsDir) {
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, error: '无法从 taskId 解析 sessionId' };

    // retry：取最后一条真实用户消息重新投递（空闲会话走 ACP + jsonl 回写）
    if (action === 'retry') {
        const lastText = lastUserText(sid, projectsDir);
        if (!lastText) return { ok: false, error: '找不到可重试的上一条用户消息' };
        const cwd = require('path').dirname(jsonlWriter.findConversationFile(sid, projectsDir) || '.');
        // 先尝试 steer（活跃会话原地重跑），失败回退 ACP prompt
        const st = await steerTo(sid, '【远程控制·重试】请重新执行上一条任务：\n' + lastText);
        if (st.ok) {
            return { ok: true, channel: 'steer', message: '已向活跃会话注入重试指令', detail: st };
        }
        const r = await bridge.sendPrompt(sid, cwd, '请重新执行：' + lastText, {
            projectsDir, promptTimeoutMs: 45000,
        });
        return r.ok
            ? { ok: true, channel: 'acp', message: '已重新提交上一条任务', writeBack: r.writeBack }
            : { ok: false, error: r.error, channel: 'acp' };
    }

    // select_option：把用户选择作为消息送回会话
    if (action === 'select_option') {
        const value = params.value != null ? params.value : '';
        const label = params.label || value;
        const text = '【远程选择】我选择：' + label + (label !== value ? '（' + value + '）' : '') + '。请据此继续。';
        return await deliverControl(sid, text, projectsDir, '选择已回传');
    }

    // pause / resume / cancel
    const text = CONTROL_TEXT[action];
    if (!text) return { ok: false, error: '未知控制动作: ' + action };
    return await deliverControl(sid, text, projectsDir, {
        pause: '暂停指令已送达', resume: '继续指令已送达', cancel: '取消指令已送达',
    }[action]);
}

/**
 * 投递控制文本：优先 steer（活跃会话实时注入），失败/EOL 则回退 ACP prompt（空闲会话）。
 */
async function deliverControl(sessionId, text, projectsDir, successLabel) {
    const st = await steerTo(sessionId, text);
    if (st.ok) {
        return { ok: true, channel: 'steer', message: successLabel + '（实时注入执行中会话）', detail: st };
    }
    console.log('[Control] steer 不可用(' + st.reason + ')，回退 ACP prompt 到', sessionId.slice(0, 8));
    const cwd = require('path').dirname(jsonlWriter.findConversationFile(sessionId, projectsDir) || '.');
    const r = await bridge.sendPrompt(sessionId, cwd, text, {
        projectsDir, promptTimeoutMs: 45000,
    });
    return r.ok
        ? { ok: true, channel: 'acp', message: successLabel + '（会话空闲，已作为消息投递）', writeBack: r.writeBack, steerReason: st.reason }
        : { ok: false, error: r.error, channel: 'acp', steerReason: st.reason };
}

module.exports = { steerTo, answerQuestion, controlAction, lastUserText, deliverControl, setSessionModel, CONTROL_TEXT };

if (require.main === module) {
    const [, , sid, action, ...rest] = process.argv;
    if (!sid || !action) {
        console.log('用法: node wb_control.js <sessionId> <pause|resume|cancel|retry|select_option> [value]');
        process.exit(1);
    }
    const projectsDir = require('path').join(require('os').homedir(), '.workbuddy', 'projects');
    controlAction(sid, action, { value: rest[0], label: rest[0] }, projectsDir)
        .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); });
}
