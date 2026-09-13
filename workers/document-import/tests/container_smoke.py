"""Opt-in native smoke, ONLY inside the exact sandbox contract. Self-authored synthetic fixtures."""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, '/app')
from protocol import VERSION
from runtime import assert_sandbox, run_process


def main():
    assert_sandbox()
    import pymupdf
    import pdf_ocr
    import libreoffice_convert
    from health import probe
    from native_gold import run_gold
    health = probe()
    root = Path('/work')
    request = dict(version=VERSION, requestId='smoke', sourceId='synthetic', sourceHash='a'*64,
                   format='pdf', timeoutMs=120000, ocrLanguages='eng')
    native = pymupdf.open()
    p = native.new_page(width=400, height=300)
    p.insert_text((30, 60), 'Chapter 1 Synthetic native fixture', fontsize=14)
    native_path = root / 'native.pdf'
    native.save(native_path)
    native.close()
    pdf_ocr.INPUT = native_path
    assert pdf_ocr.inspect_pdf()['totalPages'] == 1
    result = pdf_ocr.process_page(1, request)
    assert result['page']['state'] == 'native', result['page']['warnings']
    assert any('Synthetic native fixture' in b['text'] for b in result['page']['blocks'])
    with pymupdf.open(native_path) as document:
        raster = document[0].get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes('png')
    mixed = pymupdf.open()
    p = mixed.new_page(width=400, height=400)
    p.insert_text((30, 25), 'Native header', fontsize=12)
    p.insert_image(pymupdf.Rect(0, 50, 400, 350), stream=raster)
    mixed_path = root / 'mixed.pdf'
    mixed.save(mixed_path); mixed.close()
    pdf_ocr.INPUT = mixed_path
    result = pdf_ocr.process_page(1, request)
    assert result['page']['state'] == 'needs_review'
    assert result['page']['regions'] and result['artifacts']
    assert any(b['method'] == 'ocr' and b['text'].strip() for b in result['page']['blocks'])
    assert any(b['method'] == 'native' and 'Native header' in b['text'] for b in result['page']['blocks'])
    image_path = root / 'image.png'
    image_path.write_bytes(raster)
    pdf_ocr.INPUT = image_path
    image_result = pdf_ocr.process_image(request)
    assert image_result['page']['state'] == 'needs_review' and image_result['artifacts']
    # Generate a real OLE Word 97 DOC from self-authored text INSIDE the sandbox.
    text_path = root / 'sample.txt'
    text_path.write_text('Chapter 1\nSynthetic real DOC conversion fixture.\n', encoding='utf-8')
    run_process(['/usr/bin/libreoffice', '-env:UserInstallation=file:///work/fixture-profile',
                 '--headless', '--norestore', '--convert-to', 'doc:MS Word 97', '--outdir', '/work', str(text_path)], 45)
    doc_path = root / 'sample.doc'
    assert doc_path.read_bytes()[:8] == bytes.fromhex('d0cf11e0a1b11ae1')
    libreoffice_convert.INPUT = doc_path
    converted = libreoffice_convert.convert()
    assert converted['artifact']['mediaType'].endswith('document')
    # Verify real conversion text, not merely an OOXML-looking signature.
    import base64
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(converted['artifact']['base64']))) as archive:
        assert 'Synthetic real DOC conversion fixture.' in archive.read('word/document.xml').decode()
    chinese = run_gold(root, request)
    print(json.dumps({'passed': ['native-pdf', 'mixed-regional-ocr', 'image-ocr', 'real-ole-doc-to-docx'],
                      'nativeFixtureHash': hashlib.sha256(native_path.read_bytes()).hexdigest(),
                      'chineseGold': chinese, 'health': health,
                      'note': 'Self-authored clean print only; no handwriting/adversarial corpus quality claim.'}))


if __name__ == '__main__':
    main()
