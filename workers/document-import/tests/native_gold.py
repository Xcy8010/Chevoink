"""Self-authored fixed Chinese recognition corpus; no downloaded/user document is used.
CER measures non-whitespace characters; raw CER is also emitted (never hidden).
This small clean-print gate is not a claim about handwriting or arbitrary customer PDFs.
"""
import hashlib
from pathlib import Path

from protocol import LIMITS

GOLD_LINES = (
    '第一章 清晨的书房',
    '清晨的阳光照进书房，窗外的树叶轻轻摇动。',
    '小林打开书本，认真阅读昨天没有读完的故事。',
    '桌上放着一杯温水，旁边是一支黑色的钢笔。',
    '他在纸上写下今天的计划，然后开始新的工作。',
    '第二章 回家的路',
    '傍晚的时候，天空出现了美丽的红色云霞。',
    '街道两旁亮起了灯光，远处传来了孩子的笑声。',
    '小林走过熟悉的小桥，看见家里的窗户还亮着。',
    '他知道，无论走得多远，总有人在家里等他。',
)


def distance(reference, actual):
    previous = list(range(len(actual) + 1))
    for index, char in enumerate(reference, 1):
        current = [index]
        for offset, candidate in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[offset] + 1, previous[offset - 1] + (char != candidate)))
        previous = current
    return previous[-1]


def run_gold(root, request):
    import pymupdf
    import pdf_ocr
    font = Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    assert font.is_file(), 'the reviewed Noto CJK font is mandatory'
    clean = pymupdf.open()
    page = clean.new_page(width=760, height=660)
    page.insert_font(fontname='gold', fontfile=str(font))
    for index, line in enumerate(GOLD_LINES):
        page.insert_text((35, 50 + index * 54), line, fontname='gold', fontsize=20, color=(0, 0, 0))
    pixels = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    raster = pixels.tobytes('png')
    assert pixels.width * pixels.height <= LIMITS['pixels']
    clean.close()
    scanned = pymupdf.open()
    page = scanned.new_page(width=760, height=660)
    page.insert_image(page.rect, stream=raster)
    assert not page.get_text().strip(), 'scan fixture must have NO hidden text layer'
    path = root / 'gold-scanned-chinese.pdf'
    scanned.save(path); scanned.close()
    pdf_ocr.INPUT = path
    result = pdf_ocr.process_page(1, {**request, 'ocrLanguages': 'chi_sim+eng'})
    assert result['page']['state'] == 'needs_review'
    assert result['page']['regions'] and result['artifacts']
    assert all(region['status'] != 'failed' for region in result['page']['regions'])
    actual = '\n'.join(b['text'] for b in result['page']['blocks'] if b['method'] == 'ocr' and not b['duplicateOf'])
    reference = '\n'.join(GOLD_LINES)
    compact = lambda text: ''.join(text.split())
    report = dict(referenceChars=len(compact(reference)), recognizedChars=len(compact(actual)),
                  characterErrorRate=distance(compact(reference), compact(actual)) / len(compact(reference)),
                  rawCharacterErrorRate=distance(reference, actual) / len(reference),
                  normalization='remove Unicode whitespace only; punctuation and character variants are NOT normalized',
                  threshold=0.02, sourceHash=hashlib.sha256(path.read_bytes()).hexdigest(),
                  referenceHash=hashlib.sha256(reference.encode()).hexdigest(),
                  recognizedHash=hashlib.sha256(actual.encode()).hexdigest())
    # Do not tune the denominator or hide a failing native recognizer result.
    assert report['characterErrorRate'] <= report['threshold'], report
    return report
