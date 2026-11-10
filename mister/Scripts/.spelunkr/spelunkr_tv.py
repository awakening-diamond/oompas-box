#!/usr/bin/env python3
"""OOMPAS Box for MiSTer.

Plays OOMPAS Box channels streamed from your PC (see pc-server/) on the
MiSTer's framebuffer at 320x240 / 15 kHz, using the same mplayer and
video-mode trick as MiSTer SAM and mister_plex. Controller or keyboard
flips channels.

  spelunkr_tv.py           run the TV (normally started by spelunkr.sh)
  spelunkr_tv.py --check   check the server and print the channel list
  spelunkr_tv.py --learn   print controller button numbers for spelunkr.ini
"""
import configparser
import errno
import fcntl
import glob
import json
import os
import re
import select
import signal
import struct
import threading
import subprocess
import sys
import time
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
INI = os.environ.get('SPELUNKR_INI', '/media/fat/Scripts/spelunkr.ini')
CARD = os.environ.get('SPELUNKR_CARD', '/media/fat')
MISTER_INI = os.path.join(CARD, 'MiSTer.ini')
MENU_RBF = os.path.join(CARD, 'menu.rbf')
# Started from the "OOMPAS Box" core entry (an MGL that loads the menu core under the
# name OOMPAS) rather than from the Scripts menu.
CORE_NAME = 'OOMPAS'
CORE_MGL = os.path.join(CARD, 'OOMPAS Box.mgl')
FROM_CORE = '--from-core' in sys.argv
MISTER_CMD = '/dev/MiSTer_cmd'
LAST_FILE = os.path.join(BASE, 'last_channel')
DRY = os.environ.get('SPELUNKR_DRY') == '1'
SAM_CRT_MODE = '320,-16,32,32,240,1,3,13,5670'   # MiSTer SAM / mister_plex default

DEFAULTS = {
    'server': 'auto',
    'remember_server': 'yes',
    'quality': 'auto',
    'start_channel': '',
    'video_mode': 'auto',
    'override_ini': 'yes',
    'fb_mode': 'scaler',
    'display_wait': '2.5',
    'quit_buttons': '6,8',
    'next_buttons': '',
    'prev_buttons': '',
    'recall_buttons': '',
    'guide_buttons': '',
    'mplayer_args': '',
    'banner_overlay': 'auto',
    'picture_width': '100',
    'picture_height': '100',
    'picture_x': '0',
    'picture_y': '0',
    'brightness': '0',
    'contrast': '100',
    'saturation': '100',
}

PICTURE_KEYS = (('picture_width', 'pw'), ('picture_height', 'ph'), ('picture_x', 'px'), ('picture_y', 'py'),
                ('brightness', 'br'), ('contrast', 'ct'), ('saturation', 'sat'))


def picture_query(cfg):
    q = ''
    for key, short in PICTURE_KEYS:
        val = cfg.get(key, '').strip()
        try:
            float(val)
        except ValueError:
            continue
        if val != DEFAULTS[key]:
            q += '&%s=%s' % (short, val)
    return q


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def load_config():
    cp = configparser.ConfigParser(inline_comment_prefixes=(';', '#'))
    cp.read_dict({'spelunkr': DEFAULTS})
    if os.path.exists(INI):
        with open(INI) as f:
            text = f.read()
        if not text.lstrip().startswith('['):
            text = '[spelunkr]\n' + text
        cp.read_string(text)
    c = dict(cp['spelunkr'])
    server = c['server'].strip().replace('http://', '').rstrip('/')
    if server and ':' not in server:
        server += ':8090'
    c['server'] = server

    def nums(key):
        return {int(x) for x in c[key].replace(' ', '').split(',') if x.isdigit()}
    c['quit'], c['next'], c['prev'], c['recall'] = nums('quit_buttons'), nums('next_buttons'), nums('prev_buttons'), nums('recall_buttons')
    c['guide'] = nums('guide_buttons')
    return c


def save_ini_values(values):
    """Update keys in spelunkr.ini in place, keeping comments; append any that are missing."""
    try:
        with open(INI) as f:
            lines = f.read().split('\n')
    except OSError:
        lines = ['[spelunkr]']
    done = set()
    for i, line in enumerate(lines):
        m = re.match(r'^(\s*)([A-Za-z_]+)(\s*=\s*)([^;#]*?)(\s*[;#].*)?$', line)
        if m and m.group(2).lower() in values:
            key = m.group(2).lower()
            lines[i] = m.group(1) + m.group(2) + m.group(3) + str(values[key]) + (m.group(5) or '')
            done.add(key)
    missing = [k for k in values if k not in done]
    if missing:
        while lines and not lines[-1].strip():
            lines.pop()
        lines += [''] + ['%s = %s' % (k, values[k]) for k in missing]
    with open(INI, 'w') as f:
        f.write('\n'.join(lines).rstrip('\n') + '\n')


def sh(cmd):
    if DRY:
        log('[dry] ' + ' '.join(cmd))
        return 0
    return subprocess.call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def mister_cmd(text):
    if DRY:
        log('[dry] MiSTer_cmd: ' + text)
        return
    with open(MISTER_CMD, 'w') as f:
        f.write(text + '\n')


def fetch_channels(server, timeout=10):
    with urllib.request.urlopen('http://%s/channels.json' % server, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    chans = sorted(data['channels'], key=lambda c: int(c['dial']))
    if not chans:
        raise RuntimeError('the server has no channels')
    return chans


def local_networks():
    """This MiSTer's IPv4 addresses (wired or Wi-Fi), as (address, prefix length)."""
    out = []
    try:
        text = subprocess.run(['ip', '-4', '-o', 'addr', 'show'], capture_output=True, text=True, timeout=3).stdout
    except Exception:
        text = ''
    for m in re.finditer(r'inet (\d+\.\d+\.\d+\.\d+)/(\d+)', text):
        addr, plen = m.group(1), int(m.group(2))
        if not addr.startswith('127.'):
            out.append((addr, plen))
    if not out:                                   # no 'ip' tool: busybox ifconfig instead
        try:
            text = subprocess.run(['ifconfig'], capture_output=True, text=True, timeout=3).stdout
        except Exception:
            text = ''
        for m in re.finditer(r'inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)', text):
            if not m.group(1).startswith('127.'):
                out.append((m.group(1), 24))
    if not out:                                   # last resort: the kernel's routing table
        try:
            with open('/proc/net/route') as f:
                next(f)
                for line in f:
                    p = line.split()
                    dest, mask = int(p[1], 16), int(p[7], 16)
                    if mask and dest and p[0] != 'lo':
                        out.append(('.'.join(str(b) for b in struct.pack('<I', dest)), bin(mask).count('1')))
        except (OSError, ValueError, IndexError):
            pass
    return out


def probe(server, timeout=0.8):
    """Number of channels if an OOMPAS Box server answers at host:port, else 0."""
    try:
        with urllib.request.urlopen('http://%s/channels.json' % server, timeout=timeout) as r:
            return len(json.loads(r.read().decode()).get('channels', []))
    except Exception:
        return 0


def find_servers(port='8090'):
    """Look for OOMPAS Box servers on this MiSTer's networks: every address in each
    local /24 (plus 192.168.137.1, the PC on a cable shared from Windows), checked
    64 at a time. Takes a couple of seconds. Returns [(server, channels)]."""
    from concurrent.futures import ThreadPoolExecutor
    hosts = ['192.168.137.1']
    for addr, plen in local_networks():
        if addr.startswith('169.254.'):
            continue                       # no address from a router or the PC yet
        base = addr.rsplit('.', 1)[0]
        hosts += ['%s.%d' % (base, n) for n in range(1, 255) if '%s.%d' % (base, n) != addr]
    hosts = list(dict.fromkeys(hosts))
    servers = ['%s:%s' % (h, port) for h in hosts]
    with ThreadPoolExecutor(64) as pool:
        found = [(sv, n) for sv, n in zip(servers, pool.map(probe, servers)) if n]
    return found


def route_iface(host):
    """The network interface used to reach host (e.g. eth0, wlan0), from the kernel's
    routing table: the most specific matching route wins."""
    try:
        ip = struct.unpack('<I', bytes(int(x) for x in host.split('.')))[0]
        best = ('', -1)
        with open('/proc/net/route') as f:
            next(f)
            for line in f:
                p = line.split()
                dest, mask = int(p[1], 16), int(p[7], 16)
                bits = bin(mask).count('1')
                if ip & mask == dest and bits > best[1]:
                    best = (p[0], bits)
        return best[0]
    except Exception:
        return ''


def high_quality(cfg):
    """quality = high | normal | auto. auto: high when the server is reached over a
    network cable (eth*), normal over Wi-Fi, where the bigger stream would stutter."""
    q = cfg.get('quality', 'auto').strip().lower()
    if q in ('high', 'normal'):
        return q == 'high'
    cached = cfg.get('_hq')
    if cached is None:
        cached = cfg['_hq'] = route_iface(cfg['server'].split(':')[0]).startswith(('eth', 'en'))
        log('Picture quality: %s (%s)' % ('high' if cached else 'normal', 'wired' if cached else 'Wi-Fi or unknown'))
    return cached


def placeholder(server):
    host = (server or '').split(':')[0].strip().lower()
    return not host or host in ('auto', 'scan') or 'xxx' in host


# ------------------------------------------------------------------ display
class Display:
    """Puts the menu core into a 320x240 15 kHz framebuffer mode, and back."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.mounts = []

    def crt(self):
        return self.cfg['fb_mode'].strip().lower() == 'crt'

    def size(self):
        return (640, 240) if self.crt() else (320, 240)

    def ini_files(self):
        # MiSTer.ini plus the alternates (MiSTer_*.ini). Any of them can be the active one,
        # so the override goes into all of them.
        files = [MISTER_INI] if os.path.exists(MISTER_INI) else []
        files += sorted(glob.glob(os.path.join(CARD, 'MiSTer_*.ini')))
        return files

    def mounted_files(self):
        if DRY:
            return list(self.mounts)
        with open('/proc/mounts') as f:
            points = {line.split()[1] for line in f if len(line.split()) > 1}
        return [p for p in [MISTER_INI] + glob.glob(os.path.join(CARD, 'MiSTer_*.ini')) if p in points]

    def unmount_all(self):
        for p in set(self.mounted_files()) | set(self.mounts):
            sh(['umount', p])
        self.mounts = []

    def override_one(self, path, index):
        out, inside, section, own_mode, own_main = [], False, '', '', ''
        with open(path, errors='replace') as f:
            for line in f:
                s = line.strip().lower()
                if s.startswith('[') and s.endswith(']'):
                    section = s
                    inside = (s == '[menu]')
                    if inside:
                        continue
                if section == '[mister]':
                    key, _, val = line.split(';')[0].partition('=')
                    if key.strip().lower() == 'video_mode' and val.count(',') >= 8:
                        own_mode = val.strip()
                    if key.strip().lower() == 'main':
                        own_main = val.strip()
                if not inside:
                    out.append(line.rstrip('\r\n'))
        mode = self.cfg['video_mode'].strip()
        auto = mode.lower() in ('', 'auto')
        if self.crt():
            # Main 20261010+: framebuffer sized for 15 kHz analog without the scaler
            # (for analog/composite paths that can't take scaler output). The analog
            # signal is the menu's native 15 kHz one, so video_mode is left alone.
            menu = (['video_mode=' + mode] if not auto else []) + ['vga_scaler=0', 'direct_video=0', 'fb_terminal=2']
            # If this ini runs a different Main (e.g. SuperStation ConsoleMode) that predates
            # fb_terminal=2, run the stock Main for the menu while watching.
            if own_main and own_main != 'MiSTer' and stock_main_supports_crt_fb():
                menu.append('main=MiSTer')
        else:
            if auto:
                # Your own 15 kHz modeline from [MiSTer] is the one your TV is known to like.
                mode = own_mode or SAM_CRT_MODE
            menu = ['video_mode=' + mode, 'vga_scaler=1', 'direct_video=0', 'fb_terminal=1']
        out += ['', '[Menu]', '; temporary, from Spelunkr TV'] + menu + ['']
        tmp = '/tmp/spelunkr_ini_%d.ini' % index
        with open(tmp, 'w') as f:
            f.write('\n'.join(out))
        if sh(['mount', '--bind', tmp, path]) == 0:
            self.mounts.append(path)
            log('%s -> [Menu] %s' % (os.path.basename(path), ' '.join(menu)))
        else:
            log('Could not apply the override to %s (bind mount failed)' % path)

    def override_ini(self):
        if self.cfg['override_ini'].lower() not in ('yes', '1', 'true'):
            return
        self.unmount_all()                       # left over from a crash
        files = self.ini_files()
        if not files:
            log('No MiSTer.ini found; skipping the video-mode override')
        for i, path in enumerate(files):
            self.override_one(path, i)

    def show_framebuffer(self):
        sh([os.path.join(BASE, 'mbc'), 'raw_seq', ':43'])   # F9: Linux framebuffer on
        log('Picture restored')

    def setup(self):
        self.override_ini()
        # Reload so the temporary settings take effect; as a core, reload the core entry.
        mister_cmd('load_core ' + (CORE_MGL if FROM_CORE and os.path.exists(CORE_MGL) else MENU_RBF))
        time.sleep(float(self.cfg['display_wait']))
        sh([os.path.join(BASE, 'mbc'), 'raw_seq', ':43'])   # F9: show the Linux framebuffer
        w, h = self.size()
        sh(['vmode', '-r', str(w), str(h), 'rgb32'])
        self.blank()

    def blank(self):
        if DRY:
            return
        try:
            with open('/sys/class/graphics/fbcon/cursor_blink', 'w') as f:
                f.write('0')
        except OSError:
            pass
        try:
            with open('/dev/tty1', 'w') as f:
                f.write('\033[?25l\033[2J\033[H')
        except OSError:
            pass

    def restore(self, reload_menu=True):
        if DRY:
            log('[dry] restore display')
        else:
            try:
                with open('/dev/tty1', 'w') as f:
                    f.write('\033[2J\033[H\033[?25h')
            except OSError:
                pass
        self.unmount_all()
        if reload_menu:
            mister_cmd('load_core ' + MENU_RBF)


def stock_main_supports_crt_fb():
    try:
        with open(os.path.join(CARD, 'MiSTer'), 'rb') as f:
            return b'fb_terminal=2' in f.read()
    except OSError:
        return False


def current_core():
    try:
        with open('/tmp/CORENAME') as f:
            return f.read().strip()
    except OSError:
        return ''


# ------------------------------------------------------------------- player
BMOVL_FIFO = '/tmp/oompas_bmovl'


def mplayer_exe():
    return os.environ.get('SPELUNKR_MPLAYER', os.path.join(BASE, 'mplayer'))


PLAYER_PID = '/tmp/spelunkr_mplayer.pid'


def die_with_parent():
    # If this script is killed outright (the Scripts window closed, say), take mplayer
    # with it; a leftover mplayer keeps streaming, so the PC sends two streams.
    try:
        import ctypes
        ctypes.CDLL('libc.so.6', use_errno=True).prctl(1, signal.SIGKILL)   # PR_SET_PDEATHSIG
    except Exception:
        pass


def kill_stray_player():
    """Stop an mplayer left running by an earlier copy of the TV. mplayer runs in its
    own process group, and its stream cache is a second process in that group that
    can outlive it, still pulling the stream, so the whole group goes."""
    try:
        with open(PLAYER_PID) as f:
            pid = int(f.read().strip())
        os.killpg(pid, signal.SIGKILL)
        log('Stopped a leftover mplayer (group %d)' % pid)
    except (OSError, ValueError):
        pass


class Player:
    def __init__(self, cfg):
        self.cfg = cfg
        self.proc = None
        self.overlay = False          # mplayer's bmovl filter, for the banner
        self.buf = b''
        self.last_pos = None
        self.last_bytes = None
        self.last_progress = time.time()

    def start(self):
        exe = mplayer_exe()
        cmd = [exe, '-slave', '-idle', '-quiet', '-msglevel', 'all=2:global=4',
               '-input', 'nodefault-bindings:conf=/dev/null', '-noconsolecontrols', '-nolirc',
               '-fs', '-demuxer', 'lavf', '-lavfdopts', 'probesize=131072:analyzeduration=1',
               '-cache', '8192', '-cache-min', '4', '-framedrop', '-ao', 'alsa']
        # Playback starts as soon as a little has arrived; the server sends ~10 s ahead on
        # tune-in and starts each show early, and this 8 MB cache holds that as a reserve
        # (about 25 s of video) so a slow patch from archive.org doesn't freeze the picture.
        if self.overlay:
            cmd += ['-vf-add', 'bmovl=1:0:%s' % BMOVL_FIFO]   # starts hidden, per-pixel alpha
        cmd += self.cfg['mplayer_args'].split()
        env = dict(os.environ, LD_LIBRARY_PATH=BASE)
        prefix = [] if DRY else ['nice', '-n', '-20']
        kill_stray_player()
        self.proc = subprocess.Popen(prefix + cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=open('/tmp/spelunkr-mplayer.log', 'ab'), env=env,
                                     preexec_fn=die_with_parent, start_new_session=True)
        try:
            with open(PLAYER_PID, 'w') as f:
                f.write(str(self.proc.pid))
        except OSError:
            pass
        os.set_blocking(self.proc.stdout.fileno(), False)
        log('mplayer started (pid %d)' % self.proc.pid)

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def send(self, line):
        if not self.alive():
            return
        try:
            self.proc.stdin.write((line + '\n').encode())
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def play(self, url):
        self.last_pos = None
        self.last_bytes = None
        self.last_progress = time.time()
        self.send('loadfile "%s"' % url)

    def poll_output(self):
        try:
            data = self.proc.stdout.read()
        except (OSError, ValueError):
            data = None
        if not data:
            return
        self.buf += data
        *lines, self.buf = self.buf.split(b'\n')
        for line in lines:
            if line.startswith(b'ANS_TIME_POSITION='):
                try:
                    pos = float(line.split(b'=', 1)[1])
                except ValueError:
                    continue
                if pos < 0:          # "no time" (with the banner overlay filter, mplayer often can't say)
                    continue
                if self.last_pos is None or pos > self.last_pos + 0.1:
                    self.last_progress = time.time()
                self.last_pos = pos
            elif line.startswith(b'ANS_stream_pos='):
                # Bytes read from the stream: if they keep coming, playback isn't stuck,
                # even when mplayer is slow to report a time position.
                try:
                    n = int(line.split(b'=', 1)[1])
                except ValueError:
                    continue
                if self.last_bytes is not None and n > self.last_bytes:
                    self.last_progress = time.time()
                self.last_bytes = n

    def ask_position(self):
        self.send('pausing_keep_force get_time_pos')
        self.send('pausing_keep_force get_property stream_pos')

    def stop(self):
        if not self.alive():
            return
        self.send('quit')
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)   # and its cache process, if it lingers
        except OSError:
            pass


# -------------------------------------------------------------------- input
JS = struct.Struct('IhBB')                  # time, value, type, number
EV = struct.Struct('llHHi')                 # struct input_event (native long size)
JS_BUTTON, JS_AXIS, JS_INIT = 0x01, 0x02, 0x80
EV_KEY = 0x01
KEY_ESC, KEY_F12 = 1, 88
KEYS = {103: 'next', 104: 'next', 78: 'next',           # Up, PgUp, keypad +
        108: 'prev', 109: 'prev', 74: 'prev',           # Down, PgDn, keypad -
        105: 'left', 14: 'recall',                      # Left, Backspace
        106: 'right', 34: 'guide', 15: 'guide',         # Right, G, Tab
        25: 'settings',                                 # P
        1: 'quit', 16: 'quit',                          # Esc, Q
        28: 'enter', 96: 'enter'}                       # Enter, keypad Enter
DIGITS = {2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 11: 0,
          79: 1, 80: 2, 81: 3, 75: 4, 76: 5, 77: 6, 71: 7, 72: 8, 73: 9, 82: 0}
VERTICAL, HORIZONTAL = (1, 7), (0, 6)


class Inputs:
    def __init__(self, cfg, learn=False):
        self.cfg = cfg
        self.learn = learn
        self.devs = {}          # path -> file object
        self.axes = {}          # (path, axis) -> -1/0/1
        self.scanned = 0

    def rescan(self):
        if time.time() - self.scanned < 2:
            return
        self.scanned = time.time()
        paths = set(glob.glob('/dev/input/js*')) | set(glob.glob('/dev/input/event*'))
        for p in list(self.devs):
            if p not in paths:
                self.devs.pop(p).close()
        for p in paths - set(self.devs):
            try:
                f = open(p, 'rb', buffering=0)
                os.set_blocking(f.fileno(), False)
                self.devs[p] = f
            except OSError:
                pass

    def poll(self, timeout):
        self.rescan()
        if not self.devs:
            time.sleep(timeout)
            return []
        try:
            ready, _, _ = select.select(list(self.devs.values()), [], [], timeout)
        except (OSError, ValueError):
            self.scanned = 0
            return []
        actions = []
        for f in ready:
            path = next((p for p, d in self.devs.items() if d is f), None)
            try:
                data = f.read(4096) or b''
            except OSError:
                self.devs.pop(path, None)
                continue
            if '/js' in path:
                for i in range(0, len(data) - JS.size + 1, JS.size):
                    actions += self.js_event(path, *JS.unpack_from(data, i))
            else:
                for i in range(0, len(data) - EV.size + 1, EV.size):
                    _, _, typ, code, value = EV.unpack_from(data, i)
                    if typ == EV_KEY and value == 0 and code in (KEY_F12, KEY_ESC):
                        actions.append('f12_up' if code == KEY_F12 else 'esc_up')   # MiSTer acts on release
                    if typ == EV_KEY and value == 1 and code < 0x100:
                        if code in KEYS:
                            actions.append(KEYS[code])
                        elif code in DIGITS:
                            actions.append(('digit', DIGITS[code]))
        return actions

    def js_event(self, path, _t, value, typ, number):
        if typ & JS_INIT:
            return []
        if typ & JS_BUTTON and value == 1:
            if self.learn:
                print('  %s: button %d' % (os.path.basename(path), number), flush=True)
                return []
            for name in ('quit', 'next', 'prev', 'recall', 'guide'):
                if number in self.cfg[name]:
                    return [name]
            return []
        if typ & JS_AXIS:
            state = -1 if value < -16000 else 1 if value > 16000 else 0
            key = (path, number)
            if state == self.axes.get(key, 0):
                return []
            self.axes[key] = state
            if self.learn and state:
                print('  %s: axis %d %s' % (os.path.basename(path), number, '-' if state < 0 else '+'), flush=True)
                return []
            if number in VERTICAL and state:
                return ['next' if state < 0 else 'prev']   # d-pad up = channel up
            if number in HORIZONTAL and state:
                return ['left' if state < 0 else 'right']  # left = last channel, right = guide
        return []



# -------------------------------------------------------------- framebuffer
FBIOGET_VSCREENINFO = 0x4600


class Framebuffer:
    """Writes RGBA frames from the server straight into /dev/fb0 in its pixel order."""

    def __init__(self, fallback_size):
        self.path = os.environ.get('SPELUNKR_FB', '/dev/fb0')
        self.w, self.h = fallback_size
        self.yoffset = 0
        self.order = (16, 8, 0, 24)          # byte shifts of R, G, B, A (BGRA is the usual MiSTer order)
        self.stride = self.w * 4
        try:
            with open(self.path, 'rb') as f:
                buf = bytearray(160)
                fcntl.ioctl(f.fileno(), FBIOGET_VSCREENINFO, buf)
            v = struct.unpack_from('8I12I', buf)
            if v[6] == 32 and v[0] and v[1]:
                self.w, self.h, self.yoffset = v[0], v[1], v[5]
                self.order = (v[8], v[11], v[14], v[17] if v[18] else 24)
        except (OSError, struct.error):
            pass
        try:
            with open('/sys/class/graphics/fb0/stride') as f:
                self.stride = int(f.read().strip()) or self.w * 4
        except (OSError, ValueError):
            self.stride = self.w * 4

    def show(self, rgba):
        if len(rgba) != self.w * self.h * 4:
            raise ValueError('frame is %d bytes, expected %dx%d' % (len(rgba), self.w, self.h))
        out = bytearray(len(rgba))
        for src, shift in enumerate(self.order):
            out[shift // 8::4] = rgba[src::4]
        mode = 'r+b' if os.path.exists(self.path) else 'wb'
        with open(self.path, mode, buffering=0) as f:
            row = self.w * 4
            if self.stride == row:
                f.seek(self.yoffset * self.stride)
                f.write(out)
            else:
                for y in range(self.h):
                    f.seek((self.yoffset + y) * self.stride)
                    f.write(out[y * row:(y + 1) * row])


class Banner:
    """The channel banner: number, name, clock, the program and an info box, drawn by the
    server and laid over the picture by mplayer's bmovl filter, so it shows the moment
    Left is pressed (the stream itself runs several seconds ahead of the screen)."""

    SHOW_FOR = 6

    def __init__(self, tv):
        self.tv = tv
        self.available = False
        self.seq = 0

    def setup(self):
        if DRY:
            return
        try:
            out = subprocess.run([mplayer_exe(), '-vf', 'help'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=15, env=dict(os.environ, LD_LIBRARY_PATH=BASE)).stdout
            self.available = b'bmovl' in out
        except (OSError, subprocess.SubprocessError):
            self.available = False
        if self.tv.cfg.get('banner_overlay', 'auto').strip().lower() in ('off', 'no', '0', 'false'):
            self.available = False
        if self.available:
            try:
                if os.path.exists(BMOVL_FIFO) and not stat_is_fifo(BMOVL_FIFO):
                    os.remove(BMOVL_FIFO)
                if not os.path.exists(BMOVL_FIFO):
                    os.mkfifo(BMOVL_FIFO)
            except OSError as e:
                log('Banner overlay unavailable (%s)' % e)
                self.available = False
        log('Banner overlay: %s' % ('on' if self.available else 'not available; the server draws the banner on tune-in'))

    def show(self, delay=0.0):
        if not self.available:
            return
        self.seq += 1
        threading.Thread(target=self._show, args=(self.seq, delay), daemon=True).start()

    def cancel(self):
        self.seq += 1

    def _open(self, wait):
        end = time.time() + wait
        while True:
            try:
                fd = os.open(BMOVL_FIFO, os.O_WRONLY | os.O_NONBLOCK)
                fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) & ~os.O_NONBLOCK)
                return fd
            except OSError as e:
                if e.errno == errno.ENXIO and time.time() < end:    # the video isn't up yet
                    time.sleep(0.2)
                    continue
                return None

    def _show(self, seq, delay):
        tv = self.tv
        time.sleep(delay)
        if seq != self.seq or tv.overlay_open():
            return
        w, h = tv.display.size()
        url = 'http://%s/banner.rgba?dial=%d&w=%d&h=%d%s' % (tv.cfg['server'], tv.current, w, h, picture_query(tv.cfg))
        try:
            with urllib.request.urlopen(url, timeout=6) as r:
                data = r.read()
        except Exception as e:
            log('Banner failed: %s' % e)
            return
        if len(data) != w * h * 4 or seq != self.seq:
            return
        row = w * 4
        rows = [y for y in range(h) if data[y * row + 3:(y + 1) * row:4].strip(b'\x00')]
        if not rows:
            return
        top, bottom = rows[0], rows[-1]
        fd = self._open(4)
        if fd is None:
            return
        try:
            os.write(fd, ('RGBA32 %d %d 0 %d 0 1\n' % (w, bottom - top + 1, top)).encode())
            view = memoryview(data)[top * row:(bottom + 1) * row]
            while view:
                view = view[os.write(fd, view):]
            os.write(fd, b'SHOW\n')
        except OSError as e:
            log('Banner write failed: %s' % e)
        finally:
            os.close(fd)
        time.sleep(self.SHOW_FOR)
        if seq == self.seq:
            self.hide()

    def hide(self):
        fd = self._open(0)
        if fd is not None:
            try:
                os.write(fd, b'HIDE\n')
            except OSError:
                pass
            os.close(fd)


def stat_is_fifo(path):
    import stat
    try:
        return stat.S_ISFIFO(os.stat(path).st_mode)
    except OSError:
        return False


class Guide:
    """The OOMPAS BOX guide, drawn straight onto the screen so browsing is instant.
    The channel's sound keeps playing underneath (audio-only stream), and the picture
    box shows a still of it that refreshes every few seconds. Frames for the rows
    above and below are fetched ahead of time."""

    IDLE_CLOSE = 90
    REFRESH = 5

    def __init__(self, tv):
        self.tv = tv
        self.open = False
        self.index = 0
        self.touched = 0
        self.fb = None
        self.cache = {}                 # sel -> (time, frame bytes)
        self.lock = threading.Lock()
        self.wanted = []
        self.wake = threading.Event()
        self.shown_at = 0
        self.info = False               # Left shows everything about the highlighted program
        threading.Thread(target=self.worker, daemon=True).start()

    def entries(self):
        return len(self.tv.dials) + 1             # + the PICTURE SETTINGS row

    def sel_at(self, i):
        i %= self.entries()
        return 'settings' if i >= len(self.tv.dials) else str(self.tv.dials[i])

    def url(self, sel):
        return 'http://%s/guide.rgba?sel=%s&ch=%d&w=%d&h=%d%s%s' % (
            self.tv.cfg['server'], sel, self.tv.current, self.fb.w, self.fb.h, '&info=1' if self.info else '', picture_query(self.tv.cfg))

    def key(self, sel):
        return sel + ('/info' if self.info else '')

    def fetch(self, sel):
        key = self.key(sel)
        with urllib.request.urlopen(self.url(sel), timeout=6) as r:
            frame = r.read()
        with self.lock:
            self.cache[key] = (time.time(), frame)
        return frame

    def worker(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            while self.open:
                with self.lock:
                    todo = [s for s in self.wanted if self.key(s) not in self.cache or time.time() - self.cache[self.key(s)][0] > 20]
                if not todo:
                    break
                try:
                    self.fetch(todo[0])
                except Exception as e:
                    log('Guide prefetch failed: %s' % e)
                    break

    def prefetch(self):
        self.wanted = [self.sel_at(self.index + 1), self.sel_at(self.index - 1), self.sel_at(self.index + 2), self.sel_at(self.index - 2)]
        self.wake.set()

    def show(self):
        tv = self.tv
        self.index = tv.dials.index(tv.current) if tv.current in tv.dials else 0
        tv.banner.cancel()
        self.info = False
        tv.play_audio_only()
        time.sleep(0.4)                           # let mplayer let go of the picture
        self.fb = Framebuffer(tv.display.size())
        with self.lock:
            self.cache.clear()
        self.open = True
        self.touched = time.time()
        log('Guide open')
        self.draw(fresh=True)

    def draw(self, fresh=False):
        sel = self.sel_at(self.index)
        with self.lock:
            hit = self.cache.get(self.key(sel))
        try:
            frame = hit[1] if (hit and not fresh and time.time() - hit[0] < 20) else self.fetch(sel)
            self.fb.show(frame)
        except Exception as e:
            log('Guide draw failed: %s' % e)
        self.shown_at = time.time()
        self.prefetch()

    def close(self, tune=None):
        self.open = False
        log('Guide closed')
        self.tv.tune(tune if tune is not None else self.tv.current, force=True)

    def handle(self, action):
        self.touched = time.time()
        if action == 'next':                      # d-pad up moves the highlight up the list
            self.index = (self.index - 1) % self.entries()
            self.draw()
        elif action == 'prev':
            self.index = (self.index + 1) % self.entries()
            self.draw()
        elif action in ('right', 'enter'):
            if self.index == len(self.tv.dials):
                self.open = False
                self.tv.settings.show(self.fb)
            else:
                self.close(self.tv.dials[self.index])
        elif action == 'left':                    # program info for the highlighted channel, and back
            if self.index < len(self.tv.dials):
                self.info = not self.info
                self.draw()
        elif action in ('guide', 'recall', 'quit'):
            self.close()

    def tick(self):
        if not self.open:
            return
        if time.time() - self.touched > self.IDLE_CLOSE:
            self.close()
        elif time.time() - self.shown_at > self.REFRESH:
            self.draw(fresh=True)                 # clock, progress and the picture box move on


class Settings:
    """On-TV picture settings. The server draws a calibration screen with the
    current values applied, so you see the result as you change them."""

    ROWS = [('picture_width', 1, 50, 100), ('picture_height', 1, 50, 100),
            ('picture_x', 2, -80, 80), ('picture_y', 2, -60, 60),
            ('brightness', 5, -100, 100), ('contrast', 5, 0, 300), ('saturation', 5, 0, 300),
            ('reset',), ('done',)]
    IDLE_CLOSE = 120

    def __init__(self, tv):
        self.tv = tv
        self.open = False
        self.index = 0
        self.fb = None
        self.dirty = False
        self.touched = 0

    def show(self, fb=None):
        tv = self.tv
        if fb is None:
            tv.play_audio_only()
            time.sleep(0.4)
            fb = Framebuffer(tv.display.size())
        self.fb = fb
        self.open = True
        self.index = 0
        self.dirty = True
        self.touched = time.time()
        log('Picture settings open')

    def value(self, key):
        try:
            return int(float(self.tv.cfg.get(key, DEFAULTS[key])))
        except ValueError:
            return int(DEFAULTS[key])

    def handle(self, action):
        self.touched = time.time()
        row = self.ROWS[self.index]
        if action == 'next':
            self.index = (self.index - 1) % len(self.ROWS)
        elif action == 'prev':
            self.index = (self.index + 1) % len(self.ROWS)
        elif action in ('left', 'right') and len(row) == 4:
            key, step, lo, hi = row
            v = self.value(key) + (step if action == 'right' else -step)
            self.tv.cfg[key] = str(max(lo, min(hi, v)))
        elif action in ('right', 'enter') and row[0] == 'reset':
            for r in self.ROWS[:7]:
                self.tv.cfg[r[0]] = DEFAULTS[r[0]]
        elif (action in ('right', 'enter') and row[0] == 'done') or action in ('quit', 'guide', 'settings', 'recall'):
            self.close()
            return
        else:
            return
        self.dirty = True

    def close(self):
        self.open = False
        values = {r[0]: self.value(r[0]) for r in self.ROWS[:7]}
        try:
            save_ini_values(values)
            log('Picture settings saved: ' + ' '.join('%s=%s' % kv for kv in values.items()))
        except OSError as e:
            log('Could not save picture settings: %s' % e)
        self.tv.tune(self.tv.current, force=True)

    def tick(self):
        if not self.open:
            return
        if time.time() - self.touched > self.IDLE_CLOSE:
            self.close()
        elif self.dirty:
            self.draw()

    def draw(self):
        self.dirty = False
        url = 'http://%s/settings.rgba?sel=%d&w=%d&h=%d%s' % (self.tv.cfg['server'], self.index, self.fb.w, self.fb.h, picture_query(self.tv.cfg))
        try:
            with urllib.request.urlopen(url, timeout=6) as r:
                self.fb.show(r.read())
        except Exception as e:
            log('Settings draw failed: %s' % e)


# --------------------------------------------------------------------- main
class TV:
    def __init__(self, cfg, channels):
        self.cfg = cfg
        self.channels = channels
        self.dials = [int(c['dial']) for c in channels]
        self.current = None
        self.previous = None
        self.digits = ''
        self.digits_at = 0
        self.player = Player(cfg)
        self.inputs = Inputs(cfg)
        self.display = Display(cfg)
        self.guide = Guide(self)
        self.settings = Settings(self)
        self.banner = Banner(self)
        # MiSTer's OSD (F12) switches the Linux framebuffer off, and closing it doesn't
        # switch it back. Track the OSD so we can bring the picture back, and so keys
        # meant for the OSD don't change channels.
        self.osd_open = False
        self.osd_seen = 0
        self.refb_at = None
        self.running = True

    def first_channel(self):
        for raw in (self.cfg['start_channel'], self.read_last()):
            if raw and raw.strip().isdigit() and int(raw) in self.dials:
                return int(raw)
        return self.dials[0]

    def read_last(self):
        try:
            with open(LAST_FILE) as f:
                return f.read().strip()
        except OSError:
            return ''

    def tune(self, dial, force=False):
        if dial not in self.dials:
            log('No channel %s' % dial)
            return
        if dial != self.current:
            self.previous = self.current
        self.current = dial
        name = next(c['name'] for c in self.channels if int(c['dial']) == dial)
        log('Tuning %d %s' % (dial, name))
        w, h = self.display.size()
        # With the overlay, the banner is laid over the picture here; otherwise the server draws it into the stream.
        self.player.play('http://%s/tune/%d.ts?w=%d&h=%d%s%s%s' % (self.cfg['server'], dial, w, h,
                                                              '&nobanner=1' if self.banner.available else '', picture_query(self.cfg),
                                                              '&quality=high' if high_quality(self.cfg) else ''))
        self.banner.show(delay=2.0)
        try:
            with open(LAST_FILE, 'w') as f:
                f.write(str(dial))
        except OSError:
            pass

    def play_audio_only(self):
        # Sound of the current channel without video, so the guide or settings can use the screen.
        self.player.play('http://%s/tune/%d.ts?audioonly=1' % (self.cfg['server'], self.current))

    def step(self, delta):
        i = self.dials.index(self.current) if self.current in self.dials else 0
        self.tune(self.dials[(i + delta) % len(self.dials)])

    def overlay_open(self):
        return self.guide.open or self.settings.open

    def handle(self, action):
        if action == 'f12_up':
            self.osd_open = not self.osd_open
            log('OSD %s' % ('open' if self.osd_open else 'closed'))
            self.osd_seen = time.time()
            if not self.osd_open:
                self.refb_at = time.time() + 0.4
            return
        if self.osd_open:
            self.osd_seen = time.time()
            if action == 'esc_up':                 # Esc closes the OSD too
                self.osd_open = False
                log('OSD closed (Esc)')
                self.refb_at = time.time() + 0.4
            return                                 # everything else belongs to the OSD
        if action == 'esc_up':
            return
        if self.settings.open:
            self.settings.handle(action)
            return
        if self.guide.open:
            self.guide.handle(action)
            return
        if action in ('right', 'guide'):
            self.guide.show()
        elif action == 'settings':
            self.settings.show()
        elif action == 'left':                    # show the banner: what's on, and what's next
            if self.banner.available:
                self.banner.show()
            else:                                  # no overlay: re-tune, and the server draws it in
                self.tune(self.current, force=True)
        elif action == 'quit':
            self.running = False
        elif action == 'next':
            self.step(1)
        elif action == 'prev':
            self.step(-1)
        elif action == 'recall' and self.previous is not None:
            self.tune(self.previous)
        elif action == 'enter' and self.digits:
            self.tune(int(self.digits))
            self.digits = ''
        elif isinstance(action, tuple):
            self.digits = (self.digits + str(action[1]))[-3:]
            self.digits_at = time.time()

    def run(self):
        self.display.setup()
        self.banner.setup()
        self.player.overlay = self.banner.available
        self.player.start()
        self.tune(self.first_channel())
        last_ask = 0
        while self.running:
            for a in self.inputs.poll(0.25):
                self.handle(a)
            if self.digits and time.time() - self.digits_at > 1.5:
                self.handle('enter')
            if not self.running:
                break
            if self.refb_at and time.time() >= self.refb_at:
                self.refb_at = None
                self.display.show_framebuffer()
            if self.osd_open and time.time() - self.osd_seen > 45:
                log('OSD idle; assuming it closed')    # it may have timed out by itself
                self.osd_open = False
                self.display.show_framebuffer()
            self.guide.tick()
            self.settings.tick()
            if not self.player.alive():
                log('mplayer exited; restarting')
                self.player.start()
                if self.overlay_open():
                    self.play_audio_only()
                else:
                    self.tune(self.current)
            self.player.poll_output()
            if time.time() - last_ask > 5:
                last_ask = time.time()
                self.player.ask_position()
                if time.time() - self.player.last_progress > 25:
                    log('Playback stalled (position %s, bytes %s); re-tuning' % (self.player.last_pos, self.player.last_bytes))
                    if self.overlay_open():
                        self.play_audio_only()
                    else:
                        self.tune(self.current)
            core = current_core()
            if core and core.upper() != (CORE_NAME if FROM_CORE else 'MENU') and not DRY:
                log('Another core (%s) was launched; stepping aside' % core)
                self.shutdown(reload_menu=False)
                return
        self.shutdown()

    def shutdown(self, reload_menu=True):
        self.running = False
        self.player.stop()
        self.display.restore(reload_menu)
        log('Bye')


def main():
    cfg = load_config()
    if '--learn' in sys.argv:
        print('Press buttons and move the d-pad on your controller (Ctrl+C or wait 30 s to stop):', flush=True)
        inp, end = Inputs(cfg, learn=True), time.time() + 30
        while time.time() < end:
            inp.poll(0.5)
        return 0
    port = cfg['server'].split(':')[-1] if ':' in cfg['server'] and not placeholder(cfg['server']) else '8090'
    channels = None
    if not placeholder(cfg['server']):
        try:
            channels = fetch_channels(cfg['server'], timeout=3)
        except Exception as e:
            print('No answer from the server at %s (%s); looking for it on the network...' % (cfg['server'], e), flush=True)
    else:
        print('Looking for the OOMPAS Box server on the network...', flush=True)
    if channels is None or '--find' in sys.argv:
        found = find_servers(port)
        if not found:
            print('No OOMPAS Box server found. Is server.mjs running on your PC, and is port %s' % port)
            print('allowed through its firewall? You can also set server= in %s.' % INI)
            if FROM_CORE and not DRY:
                mister_cmd('load_core ' + MENU_RBF)    # don't leave the core sitting on a blank menu
            return 1
        for sv, n in found:
            print('  found %s (%d channels)' % (sv, n))
        pick = next((sv for sv, _ in found if sv == cfg['server']), found[0][0])
        if pick != cfg['server']:
            cfg['server'] = pick
            if cfg.get('remember_server', 'yes').lower() in ('yes', '1', 'true'):
                try:
                    save_ini_values({'server': pick})
                    print('Saved server = %s in %s' % (pick, INI))
                except OSError as e:
                    print('(Could not save it to %s: %s)' % (INI, e))
        log('Using the server at %s' % pick)
        channels = fetch_channels(pick)
    if '--check' in sys.argv:
        print('Server OK: %d channels' % len(channels))
        print('  ' + ', '.join('%s %s' % (c['dial'], c['name']) for c in channels[:12]) + (' ...' if len(channels) > 12 else ''))
        return 0
    # Only one TV at a time: a second copy (Scripts menu + core entry, say) would fight
    # the first over the screen, sound and settings.
    lock = open('/tmp/spelunkr_tv.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log('The TV is already running; not starting a second copy')
        return 0
    lock.write(str(os.getpid())); lock.flush()
    tv = TV(cfg, channels)

    def stop(*_):
        tv.running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)      # the Scripts window closing
    try:
        tv.run()
    except Exception as e:
        log('Crashed: %r' % e)
        tv.shutdown()
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
