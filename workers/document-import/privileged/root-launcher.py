#!/usr/bin/python3 -I
"""Root-owned, sudo-only Docker capability. Stdlib only; no user modules/config/commands.

Accept EXACTLY the application's fixed run, rm and scoped ps argv. Reconstruct commands
and mount a ROOT-OWNED snapshot, never a caller-controlled path after a pathname check.
Install outside the application checkout, root:root 0755, with root-owned ancestors.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

CONFIG = Path('/etc/chevoink-document-import/launcher.json')
STAGING = '/opt/chevoink/shared/document-import-staging'
STATE = Path('/var/lib/chevoink-document-import-launcher')
NAME = re.compile(r'document-import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
MAX_SOURCE = 50 * 1024**2
MAX_RESPONSE = 64 * 1024**2
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent',
       'DOCKER_HOST': 'unix:///var/run/docker.sock',
       'DOCKER_CONFIG': '/nonexistent/chevoink-document-import-config'}


class Denied(Exception):
    pass


def fixed_args(image, directory, name, script='/app/main.py'):
    return ['run', '--rm', '--pull=never', '--name', name,
            '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true', '--pids-limit=96', '--cpus=1',
            '--memory=1g', '--memory-swap=1g', '--ipc=none', '--restart=no', '--stop-timeout=1',
            '--label=org.chevoink.document-import=protocol-v1', '--ulimit=nofile=256:256',
            '--ulimit=fsize=67108864:67108864', '--ulimit=core=0:0', '--log-driver=none',
            '--tmpfs=/work:rw,noexec,nosuid,nodev,size=268435456,uid=10001,gid=10001,mode=700',
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=1777',
            '--mount', f'type=bind,src={directory},dst=/input,readonly',
            '--env=HOME=/work', '--env=TMPDIR=/tmp', '--env=OMP_THREAD_LIMIT=1',
            '--env=LANG=C.UTF-8', '--env=PYTHONDONTWRITEBYTECODE=1',
            '--entrypoint=/usr/bin/python3', image, script]


def parse_args(args, image):
    if not IMAGE.fullmatch(image):
        raise Denied()
    if len(args) == 3 and args[:2] == ['rm', '--force'] and NAME.fullmatch(args[2]):
        return 'rm', args[2], None, None
    if len(args) == 6 and args[:3] == ['ps', '-a', '--filter'] and args[4:] == ['--format', '{{.ID}}']:
        match = re.fullmatch(r'name=\^/(document-import-[a-f0-9-]+)\$', args[3])
        if match and NAME.fullmatch(match[1]):
            return 'ps', match[1], None, None
    if len(args) == len(fixed_args(image, '', '')) and args[:4] == ['run', '--rm', '--pull=never', '--name']:
        name = args[4]
        mount = args[args.index('--mount') + 1] if '--mount' in args else ''
        match = re.fullmatch(r'type=bind,src=(' + re.escape(STAGING) + r'/job-[A-Za-z0-9]{6}),dst=/input,readonly', mount)
        if NAME.fullmatch(name) and match and args[-1] in ('/app/main.py', '/app/health.py'):
            directory = match[1]
            if args == fixed_args(image, directory, name, args[-1]):
                return 'run', name, directory, args[-1]
    raise Denied()


def open_directory(path, root_owned=False):
    """Pin EVERY component with openat + O_NOFOLLOW; no realpath-then-open race."""
    if not path.startswith('/') or any(p in ('', '.', '..') for p in path.split('/')[1:]):
        raise Denied()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split('/')[1:]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
            info = os.fstat(fd)
            if root_owned and (info.st_uid != 0 or info.st_mode & 0o022):
                raise Denied()
        return fd
    except BaseException:
        os.close(fd)
        raise


def checked_file(directory_fd, name, owner, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_size > maximum:
        os.close(fd); raise Denied()
    return fd


def read_fd(fd, maximum):
    chunks = []; length = 0
    while length <= maximum:
        chunk = os.read(fd, min(65536, maximum + 1 - length))
        if not chunk:
            return b''.join(chunks)
        chunks.append(chunk); length += len(chunk)
    raise Denied()


def read_config():
    parent = open_directory(str(CONFIG.parent), root_owned=True)
    try:
        fd = checked_file(parent, CONFIG.name, 0, 4096)
        try:
            if os.fstat(fd).st_mode & 0o022:
                raise Denied()
            value = json.loads(read_fd(fd, 4096))
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    if (set(value) != {'image', 'uid'} or type(value['uid']) is not int or value['uid'] <= 0 or
            not isinstance(value['image'], str) or not IMAGE.fullmatch(value['image']) or
            os.environ.get('SUDO_UID') != str(value['uid'])):
        raise Denied()
    return value


def validate_request(request, name):
    if not isinstance(request, dict) or set(request) != {'version', 'requestId', 'sourceId', 'sourceHash', 'format', 'timeoutMs', 'ocrLanguages'}:
        raise Denied()
    if (request['version'] != 'document-import/1' or request['requestId'] != name.removeprefix('document-import-') or
            not isinstance(request['sourceId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', request['sourceId']) or
            not isinstance(request['sourceHash'], str) or not HASH.fullmatch(request['sourceHash']) or
            request['format'] not in ('doc', 'pdf', 'image') or type(request['timeoutMs']) is not int or
            not 1000 <= request['timeoutMs'] <= 1_800_000 or request['ocrLanguages'] not in ('chi_sim+eng', 'chi_tra+eng', 'eng')):
        raise Denied()


def snapshot(directory, destination, uid, name, script):
    parent = open_directory(STAGING)
    job_fd = source_fd = request_fd = None
    try:
        info = os.fstat(parent)
        if info.st_uid != uid or info.st_mode & 0o077:
            raise Denied()
        job_fd = os.open(directory.rsplit('/', 1)[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(job_fd)
        if info.st_uid != uid or info.st_mode & 0o022:
            raise Denied()
        request_fd = checked_file(job_fd, 'request.json', uid, 4096)
        request = json.loads(read_fd(request_fd, 4096)); validate_request(request, name)
        source_fd = checked_file(job_fd, 'source', uid, MAX_SOURCE)
        destination.mkdir(mode=0o755)
        destination.chmod(0o755)  # root umask is 077; the mounted child must admit UID 10001.
        digest = hashlib.sha256(); length = 0
        with (destination / 'source').open('xb') as output:
            while length <= MAX_SOURCE:
                data = os.read(source_fd, min(65536, MAX_SOURCE + 1 - length))
                if not data:
                    break
                length += len(data)
                if length > MAX_SOURCE:
                    raise Denied()
                output.write(data); digest.update(data)
            output.flush(); os.fsync(output.fileno())
        if not length or digest.hexdigest() != request['sourceHash']:
            raise Denied()
        if script == '/app/health.py' and (request['sourceId'] != 'health' or request['format'] != 'pdf' or
                request['timeoutMs'] != 15000 or digest.hexdigest() != hashlib.sha256(b'document-import-health/1').hexdigest()):
            raise Denied()
        (destination / 'request.json').write_text(json.dumps(request), encoding='utf-8')
        for file in ('source', 'request.json'):
            (destination / file).chmod(0o444)
        return request
    finally:
        for fd in (source_fd, request_fd, job_fd, parent):
            if fd is not None:
                os.close(fd)


def docker(args, timeout=3, maximum=4096, stream=False, cancel=None):
    process = subprocess.Popen(['/usr/bin/docker', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=ENV, shell=False, start_new_session=True)
    chunks = []; length = 0; deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline or (cancel is not None and cancel.exists()):
                    raise Denied()
                for key, _ in selector.select(min(.25, max(.001, deadline - time.monotonic()))):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj); continue
                    length += len(data)
                    if length > maximum:
                        raise Denied()
                    if stream:
                        sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
                    else:
                        chunks.append(data)
        code = process.wait(timeout=max(.001, deadline - time.monotonic()))
        return code, b''.join(chunks).decode('utf-8', errors='strict').strip()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
        process.stdout.close()


def owned_container(record):
    target = record.get('cid') or record['name']
    template = '{{.Id}}|{{.Image}}|{{index .Config.Labels "org.chevoink.document-import.launcher"}}'
    code, output = docker(['inspect', '--format', template, target])
    if code:
        status, inventory = docker(['ps', '-a', '--filter', f'name=^/{record["name"]}$', '--format', '{{.ID}}'])
        if status or inventory:
            raise Denied()
        return None
    parts = output.split('|')
    if len(parts) != 3 or not HASH.fullmatch(parts[0]) or parts[1] != record['image'] or parts[2] != record['nonce']:
        raise Denied()
    if record.get('cid') and record['cid'] != parts[0]:
        raise Denied()
    return parts[0]


def remove_owned(record):
    cid = owned_container(record)
    if cid:
        code, _ = docker(['rm', '--force', cid])
        if code or owned_container(record) is not None:
            raise Denied()


def erase_input(job):
    # Only root-created exact files. No recursive removal of any path is ever requested.
    for name in ('source', 'request.json'):
        (job / 'input' / name).unlink(missing_ok=True)
    try:
        (job / 'input').rmdir()
    except FileNotFoundError:
        pass


def write_record(job, record):
    temporary = job / 'record.tmp'
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(record, stream); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(job / 'record.json')


def load_record(job, uid):
    if job.is_symlink() or not job.is_dir():
        raise Denied()
    fd = open_directory(str(job), root_owned=True)
    try:
        source = checked_file(fd, 'record.json', 0, 4096)
        try:
            record = json.loads(read_fd(source, 4096))
        finally:
            os.close(source)
    finally:
        os.close(fd)
    if record['uid'] != uid or record['name'] != job.name or not IMAGE.fullmatch(record['image']) or not HASH.fullmatch(record['nonce']):
        raise Denied()
    return record


def bounded_inventory(uid):
    jobs = []; total = 0
    with os.scandir(STATE) as entries:
        for entry in entries:
            if entry.name == 'active.lock':
                continue
            if len(jobs) >= 256 or not NAME.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):
                raise Denied()
            job = Path(entry.path); jobs.append(job)
            try:
                total += (job / 'input' / 'source').stat().st_size
            except FileNotFoundError:
                pass
    # At most one old completed receipt is retired per new run, after proving no container.
    for job in jobs:
        done = job / 'done'
        if done.exists() and time.time() - done.stat().st_mtime > 600:
            remove_owned(load_record(job, uid)); erase_input(job)
            for name in ('cancelled', 'done', 'record.json'):
                (job / name).unlink(missing_ok=True)
            job.rmdir(); jobs.remove(job); break
    if len(jobs) >= 255 or total + MAX_SOURCE > 256 * 1024**2:
        raise Denied()


def main(args):
    if os.geteuid() != 0 or os.name != 'posix':
        raise Denied()
    os.umask(0o077)
    config = read_config()
    action, name, directory, script = parse_args(args, config['image'])
    def expired(_signum, _frame):
        raise Denied()
    signal.signal(signal.SIGALRM, expired)
    # Also bounds blocking source I/O / a caller that stops draining its stdout pipe.
    signal.alarm(1860 if action == 'run' else 15)
    # STATE is provisioned root:root 0700, never created beneath caller-owned directories.
    state_fd = open_directory(str(STATE), root_owned=True)
    os.close(state_fd)
    if STATE.stat().st_mode & 0o077:
        raise Denied()
    job = STATE / name
    if action != 'run':
        record = load_record(job, config['uid'])
        if action == 'ps':
            cid = owned_container(record)
            print(cid or ('' if (job / 'done').exists() else 'pending'))
        else:
            (job / 'cancelled').touch(exist_ok=True)
            remove_owned(record)
            # Pending create is uncertain, not "successfully removed". The running launcher
            # observes this durable cancellation before it ever starts an attached container.
            if not (job / 'done').exists() and not record.get('cid'):
                raise Denied()
        return
    with (STATE / 'active.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        bounded_inventory(config['uid'])
        job.mkdir(mode=0o700)  # O_EXCL semantics: a caller cannot reuse another job's name.
        record = {'name': name, 'uid': config['uid'], 'image': config['image'], 'nonce': uuid.uuid4().hex + uuid.uuid4().hex, 'cid': ''}
        write_record(job, record)
        try:
            request = snapshot(directory, job / 'input', config['uid'], name, script)
            if (job / 'cancelled').exists():
                raise Denied()
            command = fixed_args(config['image'], str(job / 'input'), name, script)
            command[0] = 'create'
            command.insert(-2, '--label=org.chevoink.document-import.launcher=' + record['nonce'])
            code, cid = docker(command)
            if code or not HASH.fullmatch(cid):
                raise Denied()
            record['cid'] = cid; write_record(job, record)
            if (job / 'cancelled').exists():
                raise Denied()
            code, _ = docker(['start', '--attach', cid], timeout=request['timeoutMs'] / 1000,
                             maximum=16384 if script == '/app/health.py' else MAX_RESPONSE,
                             stream=True, cancel=job / 'cancelled')
            if code:
                raise Denied()
        finally:
            # On daemon uncertainty retain the bounded snapshot and record for operator cleanup.
            remove_owned(record)
            erase_input(job)
            (job / 'done').touch(exist_ok=True)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except BaseException:
        # Never leak source bytes, root paths, Docker diagnostics or tracebacks to the caller.
        sys.stderr.write('DOCUMENT_IMPORT_LAUNCHER_DENIED\n')
        sys.exit(125)
