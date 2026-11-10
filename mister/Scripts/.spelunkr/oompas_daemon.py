#!/usr/bin/env python3
"""OOMPAS Box launcher. Started at boot from /media/fat/linux/user-startup.sh.

Watches which core is loaded. When it's the "OOMPAS Box" entry (the menu core
loaded under the name OOMPAS), it starts the TV; the TV stops itself when
another core or the plain menu is loaded."""
import os
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
CORE = 'OOMPAS'
PIDFILE = '/tmp/oompas_daemon.pid'


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def already_running():
    try:
        with open(PIDFILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid != os.getpid()
    except (OSError, ValueError):
        return False


def corename():
    try:
        with open('/tmp/CORENAME') as f:
            return f.read().strip()
    except OSError:
        return ''


def main():
    if already_running():
        return 0
    with open(PIDFILE, 'w') as f:
        f.write(str(os.getpid()))
    log('OOMPAS Box launcher ready')
    child, last_start = None, 0
    while True:
        if corename().upper() == CORE and (child is None or child.poll() is not None):
            if time.time() - last_start > 15:          # don't hammer if the TV keeps failing
                last_start = time.time()
                log('OOMPAS Box core loaded; starting the TV')
                child = subprocess.Popen([sys.executable, os.path.join(BASE, 'spelunkr_tv.py'), '--from-core'],
                                         stdout=open('/tmp/spelunkr.log', 'a'), stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
        time.sleep(0.5)


if __name__ == '__main__':
    sys.exit(main())
