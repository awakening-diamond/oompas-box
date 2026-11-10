// OOMPAS Server: a small window that runs the OOMPAS Box server (node server.mjs),
// shows its log, and stops it (and every ffmpeg it started) when you press Stop or
// close the window. Nothing keeps running hidden in the background.
//
// Build (MinGW):
//   x86_64-w64-mingw32-windres app.rc -O coff -o app.res
//   x86_64-w64-mingw32-g++ -O2 -municode -mwindows -static -o "OOMPAS Server.exe"
//       oompas_server_app.cpp app.res -lws2_32 -liphlpapi -lcomctl32 -lshell32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <shellapi.h>
#include <iphlpapi.h>
#include <string>
#include <vector>
#include <map>
#include <thread>
#include <atomic>

#define WM_APP_LOG    (WM_APP + 1)   // lParam: std::string* (UTF-8)
#define WM_APP_EXITED (WM_APP + 2)   // wParam: exit code
#define WM_APP_STOPPED_OLD (WM_APP + 3)

enum { ID_START = 100, ID_STOP, ID_RESTART, ID_GUIDE, ID_GROOVY, ID_WIDE, ID_BARS, ID_AUTO, ID_LOG, ID_FOLDER };
enum State { STOPPED, STARTING, RUNNING, STOPPING };

static HINSTANCE g_inst;
static HWND g_wnd, g_status, g_watch, g_hint, g_log, g_wideLabel, g_wide, g_bars, g_auto;
static HWND g_btn[6];
static HFONT g_font, g_bold, g_mono;
static int g_dpi = 96;

static State g_state = STOPPED;
static HANDLE g_job = nullptr;        // the server and everything it starts
static HANDLE g_appJob = nullptr;     // Groovy windows opened from here
static HANDLE g_proc = nullptr;
static std::atomic_bool g_stopRequested{ false };
static bool g_restart = false;
static bool g_closing = false;
static std::string g_token;
static int g_port = 8090;
static std::wstring g_dir, g_ini;
static std::string g_partial;
static std::wstring g_addr;
static std::map<std::wstring, std::wstring> g_watching;   // TV address -> channel

static int S(int v) { return MulDiv(v, g_dpi, 96); }

// ---------------------------------------------------------------- text helpers
static std::wstring W(const std::string& s)
{
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}
static std::string U(const std::wstring& w)
{
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static void AppendLog(const std::wstring& text)
{
    std::wstring t;
    for (wchar_t c : text) { if (c == L'\n') t += L"\r\n"; else if (c != L'\r') t += c; }
    int len = GetWindowTextLengthW(g_log);
    if (len > 400000)
    {
        SendMessageW(g_log, EM_SETSEL, 0, len / 2);
        SendMessageW(g_log, EM_REPLACESEL, FALSE, (LPARAM)L"");
        len = GetWindowTextLengthW(g_log);
    }
    SendMessageW(g_log, EM_SETSEL, len, len);
    SendMessageW(g_log, EM_REPLACESEL, FALSE, (LPARAM)t.c_str());
    SendMessageW(g_log, EM_SCROLLCARET, 0, 0);
}
static void Note(const std::wstring& s) { AppendLog(L"• " + s + L"\n"); }

// ---------------------------------------------------------------- settings
static std::wstring IniGet(const wchar_t* sec, const wchar_t* key, const wchar_t* def)
{
    wchar_t buf[512];
    GetPrivateProfileStringW(sec, key, def, buf, 512, g_ini.c_str());
    return buf;
}
static void IniSet(const wchar_t* sec, const wchar_t* key, const std::wstring& v)
{
    WritePrivateProfileStringW(sec, key, v.c_str(), g_ini.c_str());
}
static const wchar_t* WIDE_KEYS[] = { L"fit", L"zoom", L"fill" };

static void EnsureIni()
{
    if (GetFileAttributesW(g_ini.c_str()) != INVALID_FILE_ATTRIBUTES) return;
    const char* text =
        "; OOMPAS Server settings. The app writes [app] itself.\r\n"
        "[app]\r\nwidescreen=fit\r\nbars=1\r\nautostart=1\r\n\r\n"
        "; Any other server setting goes here, one per line (see README.md), e.g.\r\n"
        "; MAXRATE=2500\r\n; DENOISE=0\r\n; PORT=8090\r\n[env]\r\n";
    HANDLE f = CreateFileW(g_ini.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr);
    if (f != INVALID_HANDLE_VALUE) { DWORD n; WriteFile(f, text, (DWORD)strlen(text), &n, nullptr); CloseHandle(f); }
}

// [env] lines as KEY, VALUE pairs
static std::vector<std::pair<std::wstring, std::wstring>> IniEnv()
{
    std::vector<std::pair<std::wstring, std::wstring>> out;
    std::vector<wchar_t> buf(32768);
    DWORD n = GetPrivateProfileSectionW(L"env", buf.data(), (DWORD)buf.size(), g_ini.c_str());
    for (DWORD i = 0; i < n; )
    {
        std::wstring line(&buf[i]);
        i += (DWORD)line.size() + 1;
        size_t eq = line.find(L'=');
        if (line.empty() || line[0] == L';' || eq == std::wstring::npos) continue;
        out.push_back({ line.substr(0, eq), line.substr(eq + 1) });
    }
    return out;
}

// ---------------------------------------------------------------- status
static void UpdateButtons()
{
    EnableWindow(g_btn[0], g_state == STOPPED);
    EnableWindow(g_btn[1], g_state == RUNNING || g_state == STARTING);
    EnableWindow(g_btn[2], g_state == RUNNING || g_state == STARTING);
}

static void SetStatus(const std::wstring& s) { SetWindowTextW(g_status, s.c_str()); }

static void UpdateWatching()
{
    if (g_state != RUNNING) { SetWindowTextW(g_watch, L""); return; }
    if (g_watching.empty()) { SetWindowTextW(g_watch, L"Nobody is watching right now."); return; }
    std::wstring s = L"Watching: ";
    bool first = true;
    for (auto& w : g_watching) { if (!first) s += L",  "; s += w.second + L"  (" + w.first + L")"; first = false; }
    SetWindowTextW(g_watch, s.c_str());
}

static void SetState(State st)
{
    g_state = st;
    switch (st)
    {
    case STOPPED:  SetStatus(L"○  Server stopped"); break;
    case STARTING: SetStatus(L"◌  Starting…"); break;
    case RUNNING:  SetStatus(L"●  Server running" + (g_addr.empty() ? L"" : L"  ·  " + g_addr)); break;
    case STOPPING: SetStatus(L"◌  Stopping…"); break;
    }
    if (st != RUNNING) g_watching.clear();
    UpdateWatching();
    UpdateButtons();
}

// Reads the server's log lines to keep the status line up to date.
static void ParseLine(const std::wstring& line)
{
    if (line.find(L"server ready on port") != std::wstring::npos) { SetState(RUNNING); return; }
    size_t k = line.find(L"server=");
    if (k != std::wstring::npos && line.find(L"spelunkr.ini") != std::wstring::npos)
    {
        std::wstring a = line.substr(k + 7);
        while (!a.empty() && iswspace(a.back())) a.pop_back();
        // Prefer the direct-cable (Internet Connection Sharing) address.
        if (g_addr.empty() || a.rfind(L"192.168.137.", 0) == 0) g_addr = a;
        if (g_state == RUNNING) SetState(RUNNING);
        return;
    }
    // "08:00:00 + 192.168.137.44 tuned to 9 SCFI — 1 watching"
    size_t p = line.find(L" + ");
    size_t t = line.find(L" tuned to ");
    if (p != std::wstring::npos && t != std::wstring::npos && t > p)
    {
        std::wstring addr = line.substr(p + 3, t - p - 3);
        std::wstring ch = line.substr(t + 10);
        size_t d = ch.find(L" — ");
        if (d != std::wstring::npos) ch = ch.substr(0, d);
        size_t paren = ch.find(L" (sound only");
        if (paren != std::wstring::npos) return;   // the guide's background sound
        g_watching[addr] = ch;
        UpdateWatching();
        return;
    }
    p = line.find(L" - ");
    size_t l = line.find(L" left ");
    if (p != std::wstring::npos && l != std::wstring::npos && l > p)
    {
        g_watching.erase(line.substr(p + 3, l - p - 3));
        UpdateWatching();
    }
}

// ---------------------------------------------------------------- the server process
static DWORD WINAPI ReaderThread(LPVOID arg)
{
    HANDLE rd = (HANDLE)arg;
    char buf[4096];
    DWORD n;
    while (ReadFile(rd, buf, sizeof buf, &n, nullptr) && n > 0)
        PostMessageW(g_wnd, WM_APP_LOG, 0, (LPARAM)new std::string(buf, n));
    CloseHandle(rd);
    return 0;
}

// Waits for the server to end, then ends anything it left running (ffmpeg), which also
// closes the log pipe, then tells the window. Gets its own copies of the handles.
static void WatchThread(HANDLE proc, HANDLE job, HANDLE reader)
{
    WaitForSingleObject(proc, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(proc, &code);
    TerminateJobObject(job, 0);
    if (WaitForSingleObject(reader, 2000) != WAIT_OBJECT_0)
    {
        CancelSynchronousIo(reader);       // something outside the job still holds the pipe
        WaitForSingleObject(reader, 1000);
    }
    CloseHandle(reader); CloseHandle(proc); CloseHandle(job);
    PostMessageW(g_wnd, WM_APP_EXITED, code, 0);
}

// Which program is listening on this TCP port (0 if none).
static DWORD PortOwner(int port)
{
    DWORD size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    std::vector<char> buf(size + 4096);
    size = (DWORD)buf.size();
    if (GetExtendedTcpTable(buf.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != NO_ERROR) return 0;
    auto* t = (MIB_TCPTABLE_OWNER_PID*)buf.data();
    for (DWORD i = 0; i < t->dwNumEntries; i++)
        if (ntohs((u_short)t->table[i].dwLocalPort) == port) return t->table[i].dwOwningPid ? t->table[i].dwOwningPid : (DWORD)-1;
    return 0;
}

static std::wstring ProcessName(DWORD pid)
{
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return L"";
    wchar_t buf[MAX_PATH]; DWORD n = MAX_PATH;
    std::wstring name;
    if (QueryFullProcessImageNameW(h, 0, buf, &n)) { name = buf; size_t s = name.find_last_of(L"\\/"); if (s != std::wstring::npos) name = name.substr(s + 1); }
    CloseHandle(h);
    return name;
}

static std::string RandomToken()
{
    static const char* hex = "0123456789abcdef";
    std::string s;
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    unsigned long long x = c.QuadPart ^ ((unsigned long long)GetCurrentProcessId() << 32) ^ GetTickCount64() * 2654435761ULL;
    for (int i = 0; i < 24; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; s += hex[x & 15]; }
    return s;
}

static void StartServer()
{
    if (g_state != STOPPED) return;
    EnsureIni();

    // Port from the settings
    g_port = 8090;
    for (auto& kv : IniEnv()) if (_wcsicmp(kv.first.c_str(), L"PORT") == 0) g_port = _wtoi(kv.second.c_str());

    // An old server still running (for example from start-server.bat, or left over)?
    DWORD pid = PortOwner(g_port);
    if (pid == (DWORD)-1)
    {
        Note(L"Something is already using port " + std::to_wstring(g_port) + L" (maybe an old server window). If the server can't start, close that first.");
        pid = 0;
    }
    if (pid)
    {
        std::wstring name = ProcessName(pid);
        std::wstring msg = L"Something is already using port " + std::to_wstring(g_port) + L": " +
            (name.empty() ? L"PID " + std::to_wstring(pid) : name + L" (PID " + std::to_wstring(pid) + L")") +
            L".\n\nThis is most likely an OOMPAS server that's still running in the background. "
            L"Stop it and start the server here?";
        if (MessageBoxW(g_wnd, msg.c_str(), L"OOMPAS Server", MB_YESNO | MB_ICONQUESTION) != IDYES) return;
        HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
        if (!h || !TerminateProcess(h, 0))
        {
            Note(L"Couldn't stop it (PID " + std::to_wstring(pid) + L"). Close it in Task Manager, then press Start.");
            if (h) CloseHandle(h);
            return;
        }
        WaitForSingleObject(h, 3000);
        CloseHandle(h);
        Note(L"Stopped the old server (PID " + std::to_wstring(pid) + L").");
        Sleep(300);
    }

    wchar_t found[MAX_PATH];
    if (!SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr))
    {
        Note(L"Node.js isn't installed. Open PowerShell and run:  winget install OpenJS.NodeJS.LTS   then reopen this app.");
        return;
    }
    if (!SearchPathW(nullptr, L"ffmpeg.exe", nullptr, MAX_PATH, found, nullptr))
        Note(L"FFmpeg wasn't found. Open PowerShell and run:  winget install Gyan.FFmpeg   then reopen this app.");
    if (GetFileAttributesW((g_dir + L"server.mjs").c_str()) == INVALID_FILE_ATTRIBUTES)
    {
        Note(L"server.mjs isn't next to this app. Keep OOMPAS Server.exe in the pc-server folder.");
        return;
    }

    // Settings for the server (inherited by node)
    int wide = (int)SendMessageW(g_wide, CB_GETCURSEL, 0, 0);
    SetEnvironmentVariableW(L"WIDESCREEN", WIDE_KEYS[wide < 0 ? 0 : wide]);
    SetEnvironmentVariableW(L"BARS", Button_GetCheck(g_bars) == BST_CHECKED ? L"1" : L"0");
    g_token = RandomToken();
    SetEnvironmentVariableW(L"OOMPAS_APP_TOKEN", W(g_token).c_str());
    SetEnvironmentVariableW(L"NO_COLOR", L"1");
    for (auto& kv : IniEnv()) SetEnvironmentVariableW(kv.first.c_str(), kv.second.c_str());

    SECURITY_ATTRIBUTES sa = { sizeof sa, nullptr, TRUE };
    HANDLE rd, wr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) { Note(L"Couldn't create a pipe."); return; }
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);

    STARTUPINFOW si = { sizeof si };
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul; si.hStdOutput = wr; si.hStdError = wr;
    PROCESS_INFORMATION pi = {};
    std::wstring cmd = L"node.exe server.mjs";

    // A job that ends the server and every ffmpeg it started, even if this app crashes.
    g_job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {};
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof li);

    BOOL ok = CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, g_dir.c_str(), &si, &pi);
    CloseHandle(wr);
    CloseHandle(nul);
    if (!ok)
    {
        Note(L"Couldn't start node.exe (error " + std::to_wstring(GetLastError()) + L").");
        CloseHandle(rd); CloseHandle(g_job); g_job = nullptr;
        return;
    }
    AssignProcessToJobObject(g_job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    g_proc = pi.hProcess;
    g_stopRequested = false;
    g_partial.clear();
    g_addr.clear();
    HANDLE reader = CreateThread(nullptr, 0, ReaderThread, rd, 0, nullptr);
    HANDLE p2 = nullptr, j2 = nullptr, me = GetCurrentProcess();
    DuplicateHandle(me, g_proc, me, &p2, 0, FALSE, DUPLICATE_SAME_ACCESS);
    DuplicateHandle(me, g_job, me, &j2, 0, FALSE, DUPLICATE_SAME_ACCESS);
    std::thread(WatchThread, p2, j2, reader).detach();
    Note(L"Starting the server…");
    SetState(STARTING);
}

// Ask the server to quit (it closes its streams and cleans up), then make sure.
static bool HttpQuit(int port, const std::string& token)
{
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    DWORD to = 1500;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&to, sizeof to);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&to, sizeof to);
    sockaddr_in a = {};
    a.sin_family = AF_INET; a.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    bool ok = false;
    if (connect(s, (sockaddr*)&a, sizeof a) == 0)
    {
        std::string req = "GET /quit?token=" + token + " HTTP/1.0\r\nHost: localhost\r\n\r\n";
        if (send(s, req.data(), (int)req.size(), 0) > 0)
        {
            char buf[256];
            ok = recv(s, buf, sizeof buf, 0) > 0;
        }
    }
    closesocket(s);
    return ok;
}

static void StopWorker(HANDLE proc, HANDLE job, int port, std::string token)
{
    HttpQuit(port, token);
    if (WaitForSingleObject(proc, 4000) != WAIT_OBJECT_0) TerminateJobObject(job, 1);
}

static void StopServer(bool wait)
{
    if (!(g_state == RUNNING || g_state == STARTING)) return;
    g_stopRequested = true;
    SetState(STOPPING);
    if (wait) { StopWorker(g_proc, g_job, g_port, g_token); return; }
    // The worker gets its own copies of the handles (the window closes its own when the server ends).
    HANDLE p = nullptr, j = nullptr, me = GetCurrentProcess();
    DuplicateHandle(me, g_proc, me, &p, 0, FALSE, DUPLICATE_SAME_ACCESS);
    DuplicateHandle(me, g_job, me, &j, 0, FALSE, DUPLICATE_SAME_ACCESS);
    std::thread([p, j, port = g_port, token = g_token] { StopWorker(p, j, port, token); CloseHandle(p); CloseHandle(j); }).detach();
}

static void OnExited(DWORD code)
{
    // Closing the job ends anything the server left behind (ffmpeg).
    if (g_job) { TerminateJobObject(g_job, 0); CloseHandle(g_job); g_job = nullptr; }
    if (g_proc) { CloseHandle(g_proc); g_proc = nullptr; }
    if (!g_partial.empty()) { AppendLog(W(g_partial) + L"\n"); g_partial.clear(); }
    bool expected = g_stopRequested;
    SetState(STOPPED);
    if (expected) Note(L"Server stopped.");
    else
    {
        Note(L"The server quit by itself (code " + std::to_wstring(code) + L"). The reason is just above.");
        SetStatus(L"○  Server stopped — see the log below");
    }
    if (g_closing) { DestroyWindow(g_wnd); return; }
    if (g_restart) { g_restart = false; StartServer(); }
}

static void OpenGroovy()
{
    std::wstring bat = g_dir + L"start-groovy.bat";
    if (GetFileAttributesW(bat.c_str()) == INVALID_FILE_ATTRIBUTES) { Note(L"start-groovy.bat isn't in this folder."); return; }
    if (g_state == STOPPED) StartServer();
    std::wstring cmd = L"cmd.exe /c \"" + bat + L"\"";
    STARTUPINFOW si = { sizeof si };
    PROCESS_INFORMATION pi = {};
    if (CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, FALSE, CREATE_NEW_CONSOLE | CREATE_SUSPENDED, nullptr, g_dir.c_str(), &si, &pi))
    {
        AssignProcessToJobObject(g_appJob, pi.hProcess);   // closes with this app
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        Note(L"Opened the Groovy window (it closes with this app).");
    }
}

static void SettingChanged()
{
    int wide = (int)SendMessageW(g_wide, CB_GETCURSEL, 0, 0);
    IniSet(L"app", L"widescreen", WIDE_KEYS[wide < 0 ? 0 : wide]);
    IniSet(L"app", L"bars", Button_GetCheck(g_bars) == BST_CHECKED ? L"1" : L"0");
    IniSet(L"app", L"autostart", Button_GetCheck(g_auto) == BST_CHECKED ? L"1" : L"0");
    if (g_state == RUNNING || g_state == STARTING)
        SetWindowTextW(g_hint, L"Press Restart to use the new picture setting (the TV re-tunes by itself).");
}

// ---------------------------------------------------------------- window
static void Layout()
{
    RECT r; GetClientRect(g_wnd, &r);
    int m = S(12), x = m, y = m, w = r.right - 2 * m;
    MoveWindow(g_status, x, y, w, S(26), TRUE); y += S(28);
    MoveWindow(g_watch, x, y, w, S(20), TRUE); y += S(28);
    int bw = S(104), bh = S(30), gap = S(8);
    for (int i = 0; i < 6; i++) MoveWindow(g_btn[i], x + i * (bw + gap), y, bw, bh, TRUE);
    y += bh + S(12);
    MoveWindow(g_wideLabel, x, y + S(4), S(84), S(20), TRUE);
    MoveWindow(g_wide, x + S(86), y, S(250), S(200), TRUE);
    MoveWindow(g_bars, x + S(350), y + S(2), S(140), S(22), TRUE);
    MoveWindow(g_auto, x + S(496), y + S(2), S(250), S(22), TRUE);
    y += S(30);
    MoveWindow(g_hint, x, y, w, S(20), TRUE); y += S(24);
    MoveWindow(g_log, x, y, w, r.bottom - y - m, TRUE);
}

static HWND Make(const wchar_t* cls, const wchar_t* text, DWORD style, int id, HFONT font)
{
    HWND h = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 10, 10, g_wnd, (HMENU)(INT_PTR)id, g_inst, nullptr);
    SendMessageW(h, WM_SETFONT, (WPARAM)font, TRUE);
    return h;
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg)
    {
    case WM_CREATE:
    {
        g_wnd = h;
        g_status = Make(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, 0, g_bold);
        g_watch = Make(L"STATIC", L"", SS_LEFT | SS_NOPREFIX | SS_ENDELLIPSIS, 0, g_font);
        const wchar_t* names[6] = { L"Start", L"Stop", L"Restart", L"Open guide", L"Groovy…", L"Open folder" };
        for (int i = 0; i < 6; i++) g_btn[i] = Make(L"BUTTON", names[i], BS_PUSHBUTTON | WS_TABSTOP, ID_START + i, g_font);
        g_wideLabel = Make(L"STATIC", L"Widescreen:", SS_LEFT, 0, g_font);
        g_wide = Make(WC_COMBOBOXW, L"", CBS_DROPDOWNLIST | WS_TABSTOP | WS_VSCROLL, ID_WIDE, g_font);
        SendMessageW(g_wide, CB_ADDSTRING, 0, (LPARAM)L"Fit – show the whole picture");
        SendMessageW(g_wide, CB_ADDSTRING, 0, (LPARAM)L"Zoom – trim the sides a little");
        SendMessageW(g_wide, CB_ADDSTRING, 0, (LPARAM)L"Fill – fill the 4:3 screen");
        g_bars = Make(L"BUTTON", L"Trim black bars", BS_AUTOCHECKBOX | WS_TABSTOP, ID_BARS, g_font);
        g_auto = Make(L"BUTTON", L"Start the server when this opens", BS_AUTOCHECKBOX | WS_TABSTOP, ID_AUTO, g_font);
        g_hint = Make(L"STATIC", L"Closing this window stops the server.", SS_LEFT | SS_NOPREFIX, 0, g_font);
        g_log = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
            0, 0, 10, 10, h, (HMENU)ID_LOG, g_inst, nullptr);
        SendMessageW(g_log, WM_SETFONT, (WPARAM)g_mono, TRUE);
        SendMessageW(g_log, EM_SETLIMITTEXT, 0, 0);

        std::wstring wide = IniGet(L"app", L"widescreen", L"fit");
        int sel = 0;
        for (int i = 0; i < 3; i++) if (_wcsicmp(wide.c_str(), WIDE_KEYS[i]) == 0) sel = i;
        SendMessageW(g_wide, CB_SETCURSEL, sel, 0);
        Button_SetCheck(g_bars, IniGet(L"app", L"bars", L"1") != L"0" ? BST_CHECKED : BST_UNCHECKED);
        Button_SetCheck(g_auto, IniGet(L"app", L"autostart", L"1") != L"0" ? BST_CHECKED : BST_UNCHECKED);
        SetState(STOPPED);
        Layout();
        if (Button_GetCheck(g_auto) == BST_CHECKED) PostMessageW(h, WM_COMMAND, ID_START, 0);
        return 0;
    }
    case WM_SIZE: Layout(); return 0;
    case WM_GETMINMAXINFO: { auto* mm = (MINMAXINFO*)lp; mm->ptMinTrackSize.x = S(780); mm->ptMinTrackSize.y = S(360); return 0; }
    case WM_CTLCOLORSTATIC:
    {
        HDC dc = (HDC)wp;
        if ((HWND)lp == g_log) break;
        SetBkMode(dc, TRANSPARENT);
        if ((HWND)lp == g_status)
            SetTextColor(dc, g_state == RUNNING ? RGB(0, 130, 60) : g_state == STOPPED ? RGB(120, 120, 120) : RGB(170, 110, 0));
        if ((HWND)lp == g_hint) SetTextColor(dc, RGB(110, 110, 110));
        return (LRESULT)GetSysColorBrush(COLOR_WINDOW);
    }
    case WM_COMMAND:
        switch (LOWORD(wp))
        {
        case ID_START: SetWindowTextW(g_hint, L"Closing this window stops the server."); StartServer(); break;
        case ID_STOP: g_restart = false; StopServer(false); break;
        case ID_RESTART: SetWindowTextW(g_hint, L"Closing this window stops the server."); g_restart = true; StopServer(false); break;
        case ID_GUIDE: { std::wstring u = L"http://localhost:" + std::to_wstring(g_port) + L"/"; ShellExecuteW(h, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL); break; }
        case ID_GROOVY: OpenGroovy(); break;
        case ID_FOLDER: ShellExecuteW(h, L"open", g_dir.c_str(), nullptr, nullptr, SW_SHOWNORMAL); break;
        case ID_WIDE: if (HIWORD(wp) == CBN_SELCHANGE) SettingChanged(); break;
        case ID_BARS: case ID_AUTO: if (HIWORD(wp) == BN_CLICKED) SettingChanged(); break;
        }
        return 0;
    case WM_APP_LOG:
    {
        std::string* s = (std::string*)lp;
        g_partial += *s;
        delete s;
        size_t nl;
        std::wstring out;
        while ((nl = g_partial.find('\n')) != std::string::npos)
        {
            std::wstring line = W(g_partial.substr(0, nl));
            g_partial.erase(0, nl + 1);
            if (!line.empty() && line.back() == L'\r') line.pop_back();
            ParseLine(line);
            out += line + L"\n";
        }
        if (!out.empty()) AppendLog(out);
        return 0;
    }
    case WM_APP_EXITED: OnExited((DWORD)wp); return 0;
    case WM_CLOSE:
        if (g_state == RUNNING || g_state == STARTING || g_state == STOPPING)
        {
            g_closing = true;
            g_restart = false;
            ShowWindow(h, SW_HIDE);
            if (g_state != STOPPING) StopServer(false);
            // OnExited destroys the window once the server has gone. Just in case:
            SetTimer(h, 1, 8000, nullptr);
            return 0;
        }
        DestroyWindow(h);
        return 0;
    case WM_TIMER:
        if (wp == 1) { if (g_job) TerminateJobObject(g_job, 1); DestroyWindow(h); }
        return 0;
    case WM_DESTROY:
        if (g_job) { TerminateJobObject(g_job, 1); CloseHandle(g_job); g_job = nullptr; }
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR, int show)
{
    g_inst = inst;
    // One window at a time: bring the existing one forward.
    HANDLE single = CreateMutexW(nullptr, TRUE, L"OOMPAS-Server-App");
    if (GetLastError() == ERROR_ALREADY_EXISTS)
    {
        if (HWND other = FindWindowW(L"OOMPASServerApp", nullptr)) { ShowWindow(other, SW_RESTORE); SetForegroundWindow(other); }
        return 0;
    }

    SetProcessDPIAware();
    HDC dc = GetDC(nullptr); g_dpi = GetDeviceCaps(dc, LOGPIXELSY); ReleaseDC(nullptr, dc);
    INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&icc);
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);

    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    g_dir = path;
    g_dir = g_dir.substr(0, g_dir.find_last_of(L"\\/") + 1);
    g_ini = g_dir + L"OOMPAS Server.ini";

    g_appJob = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {};
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_appJob, JobObjectExtendedLimitInformation, &li, sizeof li);

    g_font = CreateFontW(-S(14), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    g_bold = CreateFontW(-S(18), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    g_mono = CreateFontW(-S(13), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Consolas");

    WNDCLASSEXW wc = { sizeof wc };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
    wc.hIconSm = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    wc.lpszClassName = L"OOMPASServerApp";
    RegisterClassExW(&wc);

    HWND h = CreateWindowExW(0, wc.lpszClassName, L"OOMPAS Server", WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, S(860), S(560), nullptr, nullptr, inst, nullptr);
    ShowWindow(h, show);
    UpdateWindow(h);

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0)
    {
        if (!IsDialogMessageW(h, &m)) { TranslateMessage(&m); DispatchMessageW(&m); }
    }
    if (g_appJob) CloseHandle(g_appJob);   // closes Groovy windows opened from here
    WSACleanup();
    if (single) CloseHandle(single);
    return 0;
}
