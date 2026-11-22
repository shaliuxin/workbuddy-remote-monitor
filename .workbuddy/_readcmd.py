#!/usr/bin/env python3
"""读取指定进程的命令行（PEB->ProcessParameters->CommandLine）。"""
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

def read_cmdline(pid):
    h = k.OpenProcess(PROCESS_ALL, False, pid)
    if not h: return 'OpenProcess failed %d' % k.GetLastError()
    try:
        pbi = PBI(); ret = ctypes.c_ulong(0)
        st = n.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), ctypes.byref(ret))
        if st != 0: return 'NtQuery %x' % (st & 0xffffffff)
        peb = pbi.PebBaseAddress
        raw = read_mem(h, peb + 0x20, 8)
        if not raw or len(raw) < 8: return 'read PEB+20 failed'
        pp = int.from_bytes(raw[:8], 'little')
        # RTL_USER_PROCESS_PARAMETERS.CommandLine = UNICODE_STRING at +0x70
        us = read_mem(h, pp + 0x70, 16)
        if not us or len(us) < 16: return 'read cmdline US failed'
        length = int.from_bytes(us[0:2], 'little')
        maxlen = int.from_bytes(us[2:4], 'little')
        bufptr = int.from_bytes(us[8:16], 'little')
        if not bufptr or length == 0: return 'empty cmdline len=%d max=%d ptr=%x' % (length, maxlen, bufptr)
        data = read_mem(h, bufptr, length)
        if not data: return 'read cmdline buf failed len=%d ptr=%x' % (length, bufptr)
        return data.decode('utf-16-le', errors='replace')
    finally:
        k.CloseHandle(h)

def enum_processes(name_contains="WorkBuddy"):
    TH32CS_SNAPPROCESS = 0x2
    class PE32(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                    ('th32ModuleID', ctypes.c_void_p), ('cntThreads', wintypes.DWORD),
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

if len(sys.argv) > 1:
    pids = [int(x) for x in sys.argv[1:]]
else:
    pids = enum_processes("WorkBuddy")
sys.stderr.write('enum count=%d\n' % len(pids))
for pid in pids:
    line = 'PID %d :: %s' % (pid, read_cmdline(pid))
    line = line.encode('ascii', 'replace').decode('ascii')
    print(line)
