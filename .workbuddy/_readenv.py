#!/usr/bin/env python3
"""读取指定 Windows 进程的环境变量，筛选 auth/token/key 相关键。"""
import sys, ctypes
from ctypes import wintypes

k = ctypes.windll.kernel32
n = ctypes.windll.ntdll
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k.ReadProcessMemory.restype = wintypes.BOOL

PROCESS_ALL = 0x1F0FFF

class PBI(ctypes.Structure):
    _fields_ = [('ExitStatus', ctypes.c_void_p), ('PebBaseAddress', ctypes.c_void_p),
                ('AffinityMask', ctypes.c_void_p), ('BasePriority', ctypes.c_void_p),
                ('UniqueProcessId', ctypes.c_void_p), ('InheritedFromUniqueProcessId', ctypes.c_void_p)]

def read_mem(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    rd = ctypes.c_size_t(0)
    ok = k.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(rd))
    return buf.raw[:rd.value] if ok else None

def read_env(pid):
    h = k.OpenProcess(PROCESS_ALL, False, pid)
    if not h:
        return {'ERROR': 'OpenProcess failed %d' % k.GetLastError()}
    try:
        pbi = PBI(); ret = ctypes.c_ulong(0)
        st = n.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), ctypes.byref(ret))
        if st != 0:
            return {'ERROR': 'NtQuery %x' % (st & 0xffffffff)}
        peb = pbi.PebBaseAddress
        raw = read_mem(h, peb + 0x20, 8)
        if not raw or len(raw) < 8:
            return {'ERROR': 'read PEB+20 failed'}
        procparams = int.from_bytes(raw[:8], 'little')
        raw2 = read_mem(h, procparams + 0x80, 16)
        if not raw2 or len(raw2) < 16:
            return {'ERROR': 'read env struct failed'}
        envlen = int.from_bytes(raw2[:2], 'little')
        # 实测此进程(WorkBuddy 用自定义 PEB 布局)：pp+0x80 处 8 字节直接就是
        # Environment buffer 指针的完整值(如 0x000002b0922d2850)，不是标准 UNICODE_STRING。
        envbuf = int.from_bytes(raw2[0:8], 'little')
        data = read_mem(h, envbuf, envlen)
        if not data:
            return {'ERROR': 'read env buf failed len=%d' % envlen}
        text = data.decode('utf-16-le', errors='replace')
        result = {}
        for line in text.split('\x00'):
            if '=' in line:
                key, val = line.split('=', 1)
                if any(s in key.upper() for s in ('TOKEN', 'AUTH', 'API_KEY', 'SECRET', 'CODEBUDDY', 'WB_', 'PORT')):
                    result[key] = val
        return result
    finally:
        k.CloseHandle(h)

def enum_processes(name_contains="WorkBuddy"):
    """用 Toolhelp32Snapshot 枚举进程名含关键字的 PID。"""
    TH32CS_SNAPPROCESS = 0x2
    class PE32(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                    ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', ctypes.c_long),
                    ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pe = PE32(); pe.dwSize = ctypes.sizeof(pe)
    pids = []
    ok = k.Process32FirstW(snap, ctypes.byref(pe))
    while ok:
        if name_contains.lower() in pe.szExeFile.lower():
            pids.append(pe.th32ProcessID)
        ok = k.Process32NextW(snap, ctypes.byref(pe))
    k.CloseHandle(snap)
    return pids


if len(sys.argv) > 1 and sys.argv[1] == '--auto':
    # 自动发现 gateway：找带 CODEBUDDY_GATEWAY_PASSWORD 的 WorkBuddy 进程
    # 输出格式：GATEWAY <pid> <password>
    for pid in enum_processes("WorkBuddy"):
        env = read_env(pid)
        pwd = env.get('CODEBUDDY_GATEWAY_PASSWORD')
        if pwd:
            print('GATEWAY %d %s' % (pid, pwd))
    sys.exit(0)

for pid in [int(x) for x in sys.argv[1:]]:
    print('=== PID %d ===' % pid)
    env = read_env(pid)
    for key, val in env.items():
        v = val if len(val) <= 120 else val[:120] + '...'
        print('  %s = %s' % (key, v))
