"""No user document, database, URL or network input. Run in the normal restricted sandbox."""
import hashlib
import json
from pathlib import Path

from protocol import PARSER_VERSION
from runtime import assert_sandbox, read_bounded, run_process


def probe():
    assert_sandbox()
    import pymupdf
    import uno  # noqa: F401 -- proves the UNO Python bridge can load in this image
    import olefile  # noqa: F401
    run_process(['/usr/bin/libreoffice', '--version'], 5)
    run_process(['/usr/bin/tesseract', '--version'], 5)
    languages = {}
    for language in ('eng', 'chi_sim', 'chi_tra'):
        data = read_bounded(Path('/usr/share/tesseract-ocr/5/tessdata') / (language + '.traineddata'), 64 * 1024**2)
        if not data:
            raise RuntimeError('missing language')
        languages[language] = hashlib.sha256(data).hexdigest()
    # Production health performs dependency self-checks only, not even synthetic document
    # conversion/OCR. All document-processing acceptance belongs exclusively to native CI.
    if not pymupdf.VersionBind.startswith('1.25.'):
        raise RuntimeError('unexpected native PDF runtime')
    return dict(version='document-import-health/1', ready=True, parserVersion=PARSER_VERSION,
                capabilities=['doc', 'pdf', 'ocr:chi_sim+eng', 'ocr:chi_tra+eng', 'ocr:eng'], languages=languages)


if __name__ == '__main__':
    print(json.dumps(probe(), separators=(',', ':')))
