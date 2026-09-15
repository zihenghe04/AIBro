"""Supervise an approved argv in an opened cwd; stop its group if the host dies."""
import json, os, signal, subprocess, sys, time
if __name__ == '__main__':
    fd, expected_parent = int(sys.argv[1]), int(sys.argv[3])
    argv = json.loads(sys.argv[2])
    if os.getppid() != expected_parent:
        sys.exit(125)
    os.fchdir(fd)
    os.close(fd)
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL)
    while child.poll() is None:
        if os.getppid() != expected_parent:
            os.killpg(os.getpgrp(), signal.SIGKILL)
        time.sleep(.05)
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
