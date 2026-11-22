#!/usr/bin/env node
/**
 * 打包脚本：生成自包含的绿色分发包（无需目标机器安装 Node / npm install）
 *
 * 用法：
 *   node build-package.js          # Windows 版（zip）
 *   node build-package.js --mac    # macOS 版（tar.gz，含 arm64 + x64 双架构 Node）
 *
 * 产物目录：dist/
 *
 * 包含：
 *   runtime/node(.exe) —— 内置 Node 运行时（Windows 取本机；macOS 从 nodejs.org 下载官方二进制）
 *   *.js / *.html      —— 服务端 + 控制台全部代码
 *   node_modules/ws    —— 唯一第三方依赖，已预装
 *   启动脚本           —— Windows: *.bat；macOS: *.sh
 *   使用说明.txt
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const VERSION = '1.2.1';
const NODE_VERSION = '22.22.2';
const TARGET = process.argv.includes('--mac') ? 'mac' : 'win';
const NAME = TARGET === 'mac' ? `WorkBuddyMonitor-macos-${VERSION}` : `WorkBuddyMonitor-${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);

const JS_FILES = [
    'workbuddy-monitor-server.js',
    'wb-console-server.js',
    'wb-console.html',
    'wb_acp_bridge.js',
    'wb_session_activity.js',
    'wb_control.js',
    'wb_question_watcher.js',
    'wb_jsonl_writer.js',
];

const FILES_WIN = [
    ...JS_FILES,
    'wb_inject.py',
    'start-console.bat',
    'stop-console.bat',
    'stop-monitor-server-by-port.bat',
];

const FILES_MAC = [
    ...JS_FILES,
    'start-console.sh',
    'stop-console.sh',
    'stop-monitor-server.sh',
];

const README_WIN = `WorkBuddy 任务监控 · Windows 便携版 ${VERSION}
================================================

这是一个「解压即用」的自包含分发包，目标电脑无需安装 Node.js，
也无需联网执行 npm install（Node 运行时和依赖 ws 已全部打进包里）。

一、最快上手（三步）
1. 把整个文件夹解压到任意位置（路径不要含特殊符号）。
2. 双击「start-console.bat」，会弹出控制台窗口并自动打开浏览器页面。
3. 在网页里点「启动」，服务端跑起来（监听 48787 端口）。

网页上会显示：服务端地址、Token、小程序连接串（一键复制）、
手机在线数、任务数、活跃会话、运行时长、实时日志。

二、手机端接入
1. 手机与电脑连同一个 WiFi，防火墙放行 TCP 48787（首次弹窗允许即可）。
2. 小程序「设置」里填入网页显示的服务端地址与 Token。

三、端口
· 监控服务端：48787（0.0.0.0）
· 控制台面板：48790（仅本机 127.0.0.1，被占自动顺延 48791-48795）

四、控制台功能
启动 / 停止 / 重启 / 重置 Token / 实时日志 / 在线数与活跃会话。

五、可选依赖 Python
「UI 模拟注入」通道需要 Python；没有也能用 —— 自动改走 steer 协议。
启动日志会打印 Python 检测结果。

六、常见问题
· 双击 bat 一闪而过：在 cmd 里手动执行看报错。
· 手机连不上：先在手机浏览器开 http://<电脑IP>:48787/token 验证网络。
· Token 忘了：控制台点「重置 Token」，手机需重填。
`;

const README_MAC = `WorkBuddy 任务监控 · macOS 便携版 ${VERSION}
================================================

这是一个「解压即用」的自包含分发包：内置 arm64 + x64 双架构官方 Node
运行时，目标 Mac 无需安装 Node.js，也无需联网安装依赖。

一、最快上手（三步）
1. 解压到任意位置，打开「终端」，进入该文件夹：
       cd <解压路径>/WorkBuddyMonitor-macos-${VERSION}
2. 启动控制台（会自动打开浏览器管理页面）：
       bash start-console.sh
3. 在网页里点「启动」，服务端跑起来（监听 48787 端口）。

网页上会显示：服务端地址、Token、小程序连接串（一键复制）、
手机在线数、任务数、活跃会话、运行时长、实时日志。

二、手机端接入
1. 手机与 Mac 连同一个 WiFi。首次启动 macOS 可能弹「是否允许接受入站连接」，
   点「允许」；若没弹，手动放行 TCP 48787。
2. 小程序「设置」里填入网页显示的服务端地址与 Token。

三、端口
· 监控服务端：48787（0.0.0.0）
· 控制台面板：48790（仅本机 127.0.0.1，被占自动顺延 48791-48795）

四、macOS 版能力说明（重要）
完全可用：
· 任务监控与实时推送、手机查看任务列表与状态
· 控制台的全部管理功能（启动/停止/重启/重置 Token/日志）
· 重置 Token、问题推送（AskUserQuestion → 手机选择）
依赖 WorkBuddy 网关环境（尽力而为）：
· 发消息 / 暂停 / 继续 / 重试 / 选项回传等「控制指令」需要读取
  WorkBuddy 网关进程的 CODEBUDDY_GATEWAY_PASSWORD 环境变量。
  macOS 出于安全对跨进程环境读取有限制，若读取失败，
  这些指令会在手机端返回明确的「网关不可用」提示，不影响监控功能。

五、常见问题
· 提示 runtime/node-arm64 无法执行：
  在终端执行  chmod +x runtime/node-arm64 runtime/node-x64
· 手机连不上：先在手机浏览器开 http://<Mac的IP>:48787/token 验证网络。
· Token 忘了：控制台点「重置 Token」，手机需重填。
`;

function human(n) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function rmrf(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function downloadMacNode(arch, outDir) {
    const fname = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${fname}`;
    const tgz = path.join(DIST, fname);
    const tmp = path.join(DIST, `node-extract-${arch}`);
    if (fs.existsSync(tgz)) {
        console.log(`  ${fname} 已存在，跳过下载`);
    } else {
        console.log(`  下载 ${fname} ...`);
        execFileSync('curl', ['-fsSL', '--retry', '2', '-o', fname, url], { timeout: 600000, cwd: DIST });
    }
    rmrf(tmp);
    fs.mkdirSync(tmp, { recursive: true });
    // 注意：Windows 的 bsdtar 会把绝对路径里的 "C:" 当成远程主机名（须用 cwd+相对路径）；
    // 且 node tar.gz 里的 bin/corepack、bin/npm 是符号链接，Windows 无特权创建会失败，
    // 我们只需要 bin/node 一个文件，直接抽取该成员（strip 2 层目录前缀）。
    execFileSync('tar',
        ['-xzf', fname, '-C', path.basename(tmp), '--strip-components=2',
         `node-v${NODE_VERSION}-darwin-${arch}/bin/node`],
        { timeout: 300000, cwd: DIST });
    const nodeBin = path.join(tmp, 'node');
    if (!fs.existsSync(nodeBin)) throw new Error(`解压后未找到 ${nodeBin}`);
    const dest = path.join(outDir, arch === 'arm64' ? 'node-arm64' : 'node-x64');
    fs.copyFileSync(nodeBin, dest);
    rmrf(tmp);
    try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
    return dest;
}

(function main() {
    console.log(`=== 打包 WorkBuddy 监控便携版 ${VERSION}（${TARGET === 'mac' ? 'macOS' : 'Windows'}） ===`);

    rmrf(STAGE);
    fs.mkdirSync(STAGE, { recursive: true });

    // 1) 代码文件
    const files = TARGET === 'mac' ? FILES_MAC : FILES_WIN;
    const missing = [];
    for (const f of files) {
        const src = path.join(ROOT, f);
        if (!fs.existsSync(src)) { missing.push(f); continue; }
        fs.copyFileSync(src, path.join(STAGE, f));
    }
    if (missing.length) console.warn('[警告] 以下文件缺失：', missing.join(', '));
    console.log('[1/5] 代码文件已复制:', files.length - missing.length, '个');

    // 2) 第三方依赖
    const wsSrc = path.join(ROOT, 'node_modules', 'ws');
    if (!fs.existsSync(wsSrc)) throw new Error('缺少 node_modules/ws，请先 npm install ws');
    copyDir(wsSrc, path.join(STAGE, 'node_modules', 'ws'));
    console.log('[2/5] 依赖已内联: node_modules/ws');

    // 3) Node 运行时
    const rtDir = path.join(STAGE, 'runtime');
    fs.mkdirSync(rtDir, { recursive: true });
    if (TARGET === 'win') {
        const nodeExe = process.execPath;
        fs.copyFileSync(nodeExe, path.join(rtDir, 'node.exe'));
        console.log('[3/5] 内置 Node 运行时: runtime/node.exe (' + human(fs.statSync(nodeExe).size) + ')');
    } else {
        console.log('[3/5] 下载 macOS 官方 Node v' + NODE_VERSION + '（arm64 + x64）...');
        const a = downloadMacNode('arm64', rtDir);
        const b = downloadMacNode('x64', rtDir);
        console.log('      runtime/node-arm64 (' + human(fs.statSync(a).size) + ')');
        console.log('      runtime/node-x64   (' + human(fs.statSync(b).size) + ')');
    }

    // 4) 说明文件
    fs.writeFileSync(path.join(STAGE, '使用说明.txt'), TARGET === 'mac' ? README_MAC : README_WIN, 'utf8');
    console.log('[4/5] 已生成 使用说明.txt');

    // 5) 压缩
    if (TARGET === 'win') {
        const zip = path.join(DIST, NAME + '.zip');
        try {
            execFileSync('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
                `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
            ], { stdio: 'inherit', timeout: 300000 });
            console.log('[5/5] 已压缩: ' + path.basename(zip) + ' (' + human(fs.statSync(zip).size) + ')');
        } catch (e) {
            console.warn('[5/5] 压缩失败（文件夹仍然可用）:', e.message);
        }
    } else {
        // macOS 包必须用 tar.gz：zip 无法可靠保留 unix 可执行权限
        // （同样用 cwd+相对路径，避免 bsdtar 把 "C:" 当远程主机）
        const tgzName = NAME + '.tar.gz';
        execFileSync('tar', ['-czf', tgzName, NAME], { timeout: 600000, cwd: DIST });
        console.log('[5/5] 已打包: ' + tgzName + ' (' + human(fs.statSync(path.join(DIST, tgzName)).size) + ')');
    }

    console.log('');
    console.log('完成：');
    console.log('  文件夹:', STAGE);
})();
