"""Container-only execution helpers; no host native parsing fallback exists."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

from protocol import LIMITS, WorkerError

INPUT = Path('/input/source')
WORK = Path('/work')


def read_bounded(path, maximum):
    """Bound the actual read, not only a prior stat (including if a file grows)."""
    if path.is_symlink():
        raise WorkerError('IMPORT_PROTOCOL_INVALID')
    with path.open('rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise WorkerError('IMPORT_PROTOCOL_INVALID')
        chunks = []
        length = 0
        while length <= maximum:
            chunk = stream.read(min(65536, maximum + 1 - length))
            if not chunk:
                return b''.join(chunks)
            length += len(chunk)
            chunks.append(chunk)
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')


def assert_sandbox():
    if os.name != 'posix' or os.getuid() != 10001 or not Path('/.dockerenv').exists():
        raise WorkerError('IMPORT_SANDBOX_REQUIRED')
    mounts = {line.split()[1]: line.split()[3].split(',') for line in Path('/proc/mounts').read_text().splitlines()}
    if ('ro' not in mounts.get('/', []) or 'ro' not in mounts.get('/input', []) or
            'rw' not in mounts.get('/work', []) or set(os.listdir('/sys/class/net')) != {'lo'}):
        raise WorkerError('IMPORT_SANDBOX_REQUIRED')


def remaining(deadline, ceiling):
    value = min(ceiling, deadline - time.monotonic())
    if value <= 0:
        raise WorkerError('IMPORT_DEADLINE_EXCEEDED')
    return value


def run_process(args, seconds, new_session=True):
    # File-size rlimit + tmpfs bound all intermediate output; never collect raw tool logs.
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, shell=False, start_new_session=new_session,
                            env={'PATH': '/usr/bin:/bin', 'HOME': '/work', 'TMPDIR': '/tmp',
                                 'LANG': 'C.UTF-8', 'OMP_THREAD_LIMIT': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
    try:
        proc.wait(timeout=seconds)
        if proc.returncode:
            raise WorkerError('IMPORT_PARSE_FAILED')
    except subprocess.TimeoutExpired:
        raise WorkerError('IMPORT_DEADLINE_EXCEEDED') from None
    finally:
        # Kill the entire process group, including LibreOffice/OCR grandchildren, even on success.
        try:
            if new_session:
                os.killpg(proc.pid, signal.SIGKILL)
            elif proc.poll() is None:
                proc.kill()
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)


def run_stage(stage, request, deadline, page=None):
    output = WORK / 'part.json'
    output.unlink(missing_ok=True)
    args = ['/usr/bin/python3', '/app/main.py', '--stage', stage]
    if page is not None:
        args.append(str(page))
    run_process(args, remaining(deadline, LIMITS['nativeMs'] / 1000))
    if not output.is_file() or output.stat().st_size > LIMITS['responseBytes']:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    data = json.loads(read_bounded(output, LIMITS['responseBytes']))
    output.unlink()
    if 'error' in data:
        raise WorkerError(data['error'])
    return data
