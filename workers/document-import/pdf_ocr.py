"""Native PDF blocks and conservative regional OCR. Imports native libraries lazily."""
import csv
import math
import time

from protocol import LIMITS, WorkerError, bounded_dimensions, image_dimensions, make_artifact, overlap, same_text
from runtime import INPUT, WORK, read_bounded, remaining, run_process


def open_pdf():
    import pymupdf
    with INPUT.open('rb') as stream:
        if not stream.read(8).startswith(b'%PDF-'):
            raise WorkerError('FILE_TYPE_MISMATCH')
    doc = pymupdf.open(str(INPUT), filetype='pdf')
    if doc.needs_pass:
        doc.close()
        raise WorkerError('IMPORT_PASSWORD_REQUIRED')
    if not 0 < doc.page_count <= LIMITS['pages']:
        doc.close()
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    return doc


def inspect_pdf():
    with open_pdf() as doc:
        warnings = []
        if doc.is_repaired:
            warnings.append('PDF_REPAIRED_REVIEW_REQUIRED')
        if doc.embfile_count():
            warnings.append('EMBEDDED_FILES_NOT_IMPORTED')
        return dict(totalPages=doc.page_count, warnings=warnings)


def rectangle(value, width, height):
    if len(value) != 4 or not all(math.isfinite(v) for v in value):
        raise WorkerError('IMPORT_PARSE_FAILED')
    box = [max(0, value[0]), max(0, value[1]), min(width, value[2]), min(height, value[3])]
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box


def tsv_blocks(path, page_number, region_id, box, scale, native):
    if path.stat().st_size > 8*1024**2:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    lines = {}
    word_count = 0
    with path.open(encoding='utf-8', newline='') as stream:
        for row in csv.DictReader(stream, delimiter='\t', quoting=csv.QUOTE_NONE):
            if row.get('level') != '5' or not row.get('text', '').strip():
                continue
            key = tuple(row[k] for k in ('block_num', 'par_num', 'line_num'))
            left, top, width, height = (float(row[k]) for k in ('left', 'top', 'width', 'height'))
            b = rectangle([box[0]+left/scale, box[1]+top/scale,
                           box[0]+(left+width)/scale, box[1]+(top+height)/scale], box[2], box[3])
            conf = float(row['conf'])
            if b is None or not math.isfinite(conf) or not 0 <= conf <= 100:
                raise WorkerError('IMPORT_OCR_FAILED')
            lines.setdefault(key, []).append((row['text'], b, conf))
            word_count += 1
            if word_count > 20_000:
                raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    blocks = []
    for words in lines.values():
        text = ' '.join(word[0] for word in words)
        b = [min(w[1][0] for w in words), min(w[1][1] for w in words),
             max(w[1][2] for w in words), max(w[1][3] for w in words)]
        duplicate = next((n['id'] for n in native if same_text(n['text'], text) and overlap(n['bbox'], b) >= .8), None)
        blocks.append(dict(id=f'p{page_number}-{region_id}-b{len(blocks)}', method='ocr', text=text, bbox=b,
                           confidence=sum(w[2] for w in words)/len(words), regionId=region_id, duplicateOf=duplicate))
    return blocks


def render(page, box):
    import pymupdf
    scale = bounded_dimensions(box[2]-box[0], box[3]-box[1])
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=pymupdf.Rect(box), alpha=False)
    if pix.width * pix.height > LIMITS['pixels']:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    return pix, scale


def process_page(number, request):
    import pymupdf
    artifacts = []
    ocr_deadline = time.monotonic() + LIMITS['ocrMs']/1000
    with open_pdf() as doc:
        page = doc[number-1]
        original_rotation = page.rotation
        # All returned boxes use the unrotated, top-left PDF point coordinate system.
        page.set_rotation(0)
        width, height = page.rect.width, page.rect.height
        bounded_dimensions(width, height)
        result = dict(page=number, width=width, height=height, state='native', warnings=[], blocks=[], regions=[])
        if original_rotation:
            result['warnings'].append('ROTATED_PAGE_REVIEW_REQUIRED')
        if page.first_annot is not None or page.first_widget is not None:
            result['warnings'].append('ANNOTATIONS_OR_FORMS_REVIEW_REQUIRED')
        flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        raw = page.get_text('dict', flags=flags, sort=False)
        native = result['blocks']
        native_chars = 0
        for block in raw['blocks']:
            for line in block.get('lines', []):
                text = ''.join(span.get('text', '') for span in line.get('spans', []))
                if not text.strip():
                    continue
                box = rectangle(line['bbox'], width, height)
                if box is None:
                    result['warnings'].append('OUTSIDE_PAGE_TEXT')
                    continue
                native.append(dict(id=f'p{number}-n{len(native)}', method='native', text=text, bbox=box,
                                   confidence=None, regionId=None, duplicateOf=None))
                native_chars += len(text)
                if '\ufffd' in text or any(0xe000 <= ord(ch) <= 0xf8ff or (ord(ch) < 32 and ch not in '\n\r\t') for ch in text):
                    result['warnings'].append('UNRELIABLE_NATIVE_TEXT')
                if len(native) > 10_000 or native_chars > LIMITS['pageTextChars']:
                    raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        native.sort(key=lambda b: (b['bbox'][1], b['bbox'][0]))
        for first, second in zip(native, native[1:]):
            if (overlap(first['bbox'], second['bbox']) > .1 or
                    abs(first['bbox'][1]-second['bbox'][1]) < 4 and first['bbox'][2] < second['bbox'][0]-20):
                result['warnings'].append('READING_ORDER_REVIEW_REQUIRED')
                break
        boxes = []
        for info in page.get_image_info():
            if info['width'] * info['height'] > LIMITS['pixels']:
                raise WorkerError('IMPORT_LIMIT_EXCEEDED')
            box = rectangle(info['bbox'], width, height)
            if box is not None:
                # Merge overlapping image placements so the same region is OCR'd once.
                joined = True
                while joined:
                    joined = False
                    for prior in boxes[:]:
                        if overlap(prior, box) > 0:
                            box = [min(prior[0], box[0]), min(prior[1], box[1]), max(prior[2], box[2]), max(prior[3], box[3])]
                            boxes.remove(prior); joined = True
                boxes.append(box)
            if len(boxes) > LIMITS['regions']:
                raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        drawings = page.get_drawings()
        if boxes and drawings:
            result['warnings'].append('VECTOR_CONTENT_NOT_OCR_REVIEW_REQUIRED')
        if not native and not boxes:
            pix, _ = render(page, [0, 0, width, height])
            if all(channel >= 254 for channel in pix.samples):
                result['state'] = 'verified_blank' if not result['warnings'] else 'needs_review'
                return dict(page=result, artifacts=artifacts)
            boxes = [[0, 0, width, height]]
        # Vector paths can contain outlined text even when native text is present.
        elif not boxes and drawings:
            boxes = [[0, 0, width, height]]
            result['warnings'].append('VECTOR_CONTENT_REVIEW_REQUIRED')
        for index, box in enumerate(boxes):
            region_id = f'p{number}-r{index}'
            region = dict(id=region_id, bbox=box, status='needs_review', artifactId=None, warnings=['OCR_REVIEW_REQUIRED'])
            result['regions'].append(region)
            try:
                pix, scale = render(page, box)
                png = pix.tobytes('png')
                artifact = make_artifact(region_id+'-image', png, 'image/png', pix.width, pix.height)
                artifacts.append(artifact)
                region['artifactId'] = artifact['id']
                image_path = WORK / 'ocr.png'
                image_path.write_bytes(png)
                tsv = WORK / 'ocr.tsv'
                tsv.unlink(missing_ok=True)
                run_process(['/usr/bin/tesseract', str(image_path), '/work/ocr', '-l', request['ocrLanguages'],
                             '--oem', '1', '--psm', '3', 'tsv'], remaining(ocr_deadline, LIMITS['ocrMs']/1000), new_session=False)
                extracted = tsv_blocks(tsv, number, region_id, box, scale, [b for b in native if b['method'] == 'native'])
                if not extracted:
                    region['warnings'].append('OCR_EMPTY_UNCLASSIFIED_IMAGE')
                else:
                    native.extend(extracted)
                    if min(b['confidence'] for b in extracted) < 80:
                        region['warnings'].append('OCR_LOW_CONFIDENCE')
            except (WorkerError, OSError, ValueError, KeyError) as exc:
                region['status'] = 'failed'
                region['warnings'] = [exc.code if isinstance(exc, WorkerError) else 'IMPORT_OCR_FAILED']
        if sum(len(b['text']) for b in native) > LIMITS['pageTextChars']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        result['warnings'] = list(dict.fromkeys(result['warnings']))[:32]
        if result['warnings'] or result['regions']:
            result['state'] = 'needs_review'
        return dict(page=result, artifacts=artifacts)


def process_image(request):
    # Decode/re-encode inside the same sandbox; PDF adapter then supplies identical coverage semantics.
    global INPUT
    import pymupdf
    image_dimensions(read_bounded(INPUT, LIMITS['inputBytes']))
    with INPUT.open('rb') as stream:
        magic = stream.read(16)
    if not (magic.startswith(b'\x89PNG\r\n\x1a\n') or magic.startswith(b'\xff\xd8\xff')):
        raise WorkerError('FILE_TYPE_MISMATCH')
    # MuPDF parsing is already inside memory/time-limited container; reject dimensions before rendering.
    image = pymupdf.open(str(INPUT), filetype='png' if magic.startswith(b'\x89PNG') else 'jpeg')
    try:
        page = image[0]
        if page.rect.width*page.rect.height > LIMITS['pixels']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        pdf_bytes = image.convert_to_pdf()
    finally:
        image.close()
    pdf_path = WORK / 'image.pdf'
    pdf_path.write_bytes(pdf_bytes)
    # Internal fixed path only, never supplied by request.
    INPUT = pdf_path
    return process_page(1, request)
