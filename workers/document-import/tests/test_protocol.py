"""Host-safe tests: protocol, supervisor fakes, TSV data. No native document parser runs."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from protocol import LIMITS, VERSION, WorkerError, bounded_dimensions, encode, failed_page, finalize, image_dimensions, make_artifact, overlap, response, same_text, validate_request
import main
from pdf_ocr import tsv_blocks
from runtime import assert_sandbox

REQUEST = dict(version=VERSION, requestId='req1', sourceId='source1', sourceHash='a'*64,
               format='pdf', timeoutMs=1000, ocrLanguages='chi_sim+eng')


class ProtocolTests(unittest.TestCase):
    def test_request_whitelist(self):
        self.assertEqual(validate_request(REQUEST), REQUEST)
        for change in ({'path': '/etc/passwd'}, {'sourceId': '../escape'}, {'format': 'sh'}, {'timeoutMs': True},
                       {'timeoutMs': 0}, {'timeoutMs': LIMITS['taskMs']+1}, {'ocrLanguages': 'eng;sh'}, {'sourceHash': 'x'*64}):
            with self.subTest(change=change), self.assertRaises(WorkerError):
                validate_request({**REQUEST, **change})

    def test_page_count_conservation(self):
        result = response(REQUEST)
        result['totalPages'] = 2
        result['pages'] = [dict(page=1, width=10, height=10, state='native', warnings=[], blocks=[], regions=[]),
                           failed_page(2, 'IMPORT_OCR_FAILED')]
        final = finalize(result)
        self.assertFalse(final['coverage']['complete'])
        self.assertEqual(sum(final['coverage']['counts'].values()), 2)
        self.assertEqual(final['coverage']['processedPages'], 1)
        self.assertEqual(final['outcome'], 'needs_review')

    def test_unknown_total_is_not_complete(self):
        self.assertFalse(finalize(response(REQUEST))['coverage']['complete'])

    def test_render_pixels(self):
        for w, h in ((612, 792), (14400, 14400), (1, 10000)):
            scale = bounded_dimensions(w, h)
            self.assertLessEqual(w*h*scale*scale, LIMITS['pixels'])
        for w, h in ((0, 10), (-1, 2), (float('nan'), 1), (float('inf'), 1), (20000, 20000)):
            with self.assertRaises(WorkerError):
                bounded_dimensions(w, h)

    def test_artifact_caps(self):
        a = make_artifact('sample', b'pure fixture', 'image/png', 3, 4)
        self.assertEqual(a['sha256'], hashlib.sha256(b'pure fixture').hexdigest())
        with self.assertRaises(WorkerError):
            make_artifact('sample', b'a'*(LIMITS['imageBytes']+1), 'image/png', 1, 1)
        with self.assertRaises(WorkerError):
            make_artifact('sample', b'a', 'image/png', 100000, 100000)

    def test_image_header_bombs_and_format_mismatch(self):
        png = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR'
        self.assertEqual(image_dimensions(png+(2).to_bytes(4, 'big')+(3).to_bytes(4, 'big')), (2, 3))
        with self.assertRaises(WorkerError):
            image_dimensions(png+(100000).to_bytes(4, 'big')+(100000).to_bytes(4, 'big'))
        with self.assertRaises(WorkerError):
            image_dimensions(b'<svg onload="evil"/>')
        with self.assertRaises(WorkerError):
            image_dimensions(b'\xff\xd8\xff\xc0\x00\x00')

    def test_duplicate_evidence_is_spatial_and_does_not_rewrite_text(self):
        self.assertTrue(same_text('原 文', '原文'))
        self.assertFalse(same_text('原文', '原又'))
        self.assertEqual(overlap([0, 0, 10, 10], [50, 50, 60, 60]), 0)
        self.assertEqual(overlap([0, 0, 10, 10], [1, 1, 2, 2]), 1)

    def test_tsv_preserves_lines_and_duplicate_reference(self):
        with tempfile.TemporaryDirectory(prefix='document-worker-tsv-') as root:
            tsv = Path(root) / 'synthetic.tsv'
            tsv.write_text('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
                           '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96\t原文\n', encoding='utf-8')
            blocks = tsv_blocks(tsv, 1, 'p1-r1', [0, 0, 100, 100], 1,
                                [{'id': 'p1-n1', 'text': '原文', 'bbox': [0, 0, 10, 10]}])
            self.assertEqual(blocks[0]['text'], '原文')
            self.assertEqual(blocks[0]['duplicateOf'], 'p1-n1')

    def test_no_native_fallback_outside_container(self):
        if not Path('/.dockerenv').exists():
            with self.assertRaises(WorkerError):
                assert_sandbox()

    def test_supervisor_preserves_earlier_pages_on_later_failure(self):
        with tempfile.TemporaryDirectory(prefix='document-worker-supervisor-') as root:
            source = Path(root) / 'source'
            source.write_bytes(b'opaque pure fixture -- NOT parsed')
            req = {**REQUEST, 'sourceHash': hashlib.sha256(source.read_bytes()).hexdigest()}
            page = dict(page=1, width=10, height=10, state='verified_blank', warnings=[], blocks=[], regions=[])
            with patch.object(main, 'INPUT', source), patch.object(main, 'WORK', Path(root)), patch.object(main, 'run_stage',
                    side_effect=[dict(totalPages=3, warnings=[]), dict(page=page, artifacts=[]),
                                 WorkerError('IMPORT_DEADLINE_EXCEEDED'), WorkerError('IMPORT_OCR_FAILED')]):
                result = json.loads(encode(main.main(req)))
            self.assertEqual([p['state'] for p in result['pages']], ['verified_blank', 'failed', 'failed'])
            self.assertEqual(result['coverage']['processedPages'], 1)
            self.assertFalse(result['coverage']['complete'])
            self.assertEqual(source.read_bytes(), b'opaque pure fixture -- NOT parsed')

    def test_contract_limits_match_typescript(self):
        # Cross-language drift guard for every hard ceiling (numeric expressions only).
        import re
        source = (Path(__file__).resolve().parents[1] / 'protocol.ts').read_text(encoding='utf-8')
        for key, value in LIMITS.items():
            expression = re.search(r'\b'+key+r': ([0-9_* ]+)[,\n]', source).group(1)
            self.assertEqual(int(eval(expression, {'__builtins__': {}}, {})), value, key)


if __name__ == '__main__':
    unittest.main()
