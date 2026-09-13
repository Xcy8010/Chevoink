"""CI-only execution; policy and pinned-descriptor filesystem checks need no Docker/root."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

launcher = None
if os.name == 'posix':
    spec = importlib.util.spec_from_file_location('import_root_launcher', Path(__file__).resolve().parents[1] / 'privileged/root-launcher.py')
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)

IMAGE = 'sha256:' + 'a' * 64
NAME = 'document-import-12345678-1234-1234-1234-123456789abc'


@unittest.skipUnless(os.name == 'posix', 'Linux launcher policy; never a Windows privilege fallback')
class LauncherPolicyTests(unittest.TestCase):
    def test_only_exact_client_protocol(self):
        directory = launcher.STAGING + '/job-Ab12cd'
        args = launcher.fixed_args(IMAGE, directory, NAME)
        self.assertEqual(launcher.parse_args(args, IMAGE), ('run', NAME, directory, '/app/main.py'))
        health = launcher.fixed_args(IMAGE, directory, NAME, '/app/health.py')
        self.assertEqual(launcher.parse_args(health, IMAGE)[3], '/app/health.py')
        self.assertEqual(launcher.parse_args(['rm', '--force', NAME], IMAGE)[0], 'rm')
        self.assertEqual(launcher.parse_args(['ps', '-a', '--filter', 'name=^/' + NAME + '$', '--format', '{{.ID}}'], IMAGE)[0], 'ps')
        attacks = [args + ['--privileged'], ['exec', NAME, 'sh'], ['run', IMAGE], ['ps', '-a'],
                   ['inspect', NAME], ['rm', '--force', 'another-container'], ['kill', NAME],
                   launcher.fixed_args('sha256:' + 'b' * 64, directory, NAME),
                   launcher.fixed_args(IMAGE, '/etc', NAME),
                   launcher.fixed_args(IMAGE, launcher.STAGING + '/job-abc123/../other', NAME),
                   launcher.fixed_args(IMAGE, directory, NAME, '/app/tests/container_smoke.py')]
        # Changing ANY fixed security flag fails, including added capabilities and env.
        for index, value in enumerate(args):
            if value.startswith('--'):
                changed = args.copy(); changed[index] = '--privileged'; attacks.append(changed)
        for attack in attacks:
            with self.subTest(attack=attack), self.assertRaises(launcher.Denied):
                launcher.parse_args(attack, IMAGE)

    def fixture(self, parent):
        stage = parent / 'stage'; stage.mkdir(mode=0o700)
        job = stage / 'job-abc123'; job.mkdir(mode=0o755)
        data = b'fixed opaque source'
        request = dict(version='document-import/1', requestId=NAME.removeprefix('document-import-'),
                       sourceId='source', sourceHash=hashlib.sha256(data).hexdigest(), format='pdf',
                       timeoutMs=1000, ocrLanguages='chi_sim+eng')
        (job / 'source').write_bytes(data)
        (job / 'request.json').write_text(json.dumps(request))
        return stage, job, data

    def test_snapshot_not_live_user_bind_and_hash_is_verified(self):
        with tempfile.TemporaryDirectory(prefix='launcher-policy-') as root:
            parent = Path(root); stage, job, data = self.fixture(parent)
            with patch.object(launcher, 'STAGING', str(stage)):
                launcher.snapshot(str(job), parent / 'snapshot', os.getuid(), NAME, '/app/main.py')
                (job / 'source').write_bytes(b'changed after snapshot')
                self.assertEqual((parent / 'snapshot/source').read_bytes(), data)
                with self.assertRaises(launcher.Denied):
                    launcher.snapshot(str(job), parent / 'rejected', os.getuid(), NAME, '/app/main.py')

    def test_symlinks_hardlinks_and_nonregular_sources_rejected(self):
        for mode in ('symlink', 'hardlink', 'fifo', 'directory'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='launcher-policy-') as root:
                parent = Path(root); stage, job, data = self.fixture(parent)
                (job / 'source').unlink()
                target = parent / 'other'; target.write_bytes(data)
                if mode == 'symlink':
                    (job / 'source').symlink_to(target)
                elif mode == 'hardlink':
                    os.link(target, job / 'source')
                elif mode == 'fifo':
                    os.mkfifo(job / 'source')
                else:
                    (job / 'source').mkdir()
                with patch.object(launcher, 'STAGING', str(stage)), self.assertRaises((launcher.Denied, OSError)):
                    launcher.snapshot(str(job), parent / 'snapshot', os.getuid(), NAME, '/app/main.py')

    def test_symlink_job_and_ancestor_are_not_followed(self):
        with tempfile.TemporaryDirectory(prefix='launcher-policy-') as root:
            parent = Path(root); stage, job, _ = self.fixture(parent)
            alias = stage / 'job-def456'; alias.symlink_to(job, target_is_directory=True)
            with patch.object(launcher, 'STAGING', str(stage)), self.assertRaises(OSError):
                launcher.snapshot(str(alias), parent / 'snapshot', os.getuid(), NAME, '/app/main.py')
            ancestor = parent / 'alias'; ancestor.symlink_to(stage, target_is_directory=True)
            with self.assertRaises(OSError):
                launcher.open_directory(str(ancestor / job.name))

    def test_ownership_and_request_identity_are_mandatory(self):
        with tempfile.TemporaryDirectory(prefix='launcher-policy-') as root:
            parent = Path(root); stage, job, _ = self.fixture(parent)
            with patch.object(launcher, 'STAGING', str(stage)), self.assertRaises(launcher.Denied):
                launcher.snapshot(str(job), parent / 'snapshot', os.getuid() + 1, NAME, '/app/main.py')
            request = json.loads((job / 'request.json').read_text())
            for change in ({'requestId': 'other'}, {'timeoutMs': True}, {'path': '/etc/passwd'}, {'ocrLanguages': 'eng;sh'}):
                with self.assertRaises(launcher.Denied):
                    launcher.validate_request({**request, **change}, NAME)


if __name__ == '__main__':
    unittest.main()
