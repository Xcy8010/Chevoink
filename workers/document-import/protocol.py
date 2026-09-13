"""Pure protocol helpers. Importing this module never opens a source document."""
import base64
import hashlib
import json
import math
import re

VERSION = 'document-import/1'
PARSER_VERSION = 'lo25.2-pymupdf1.25-tesseract5.5-prototype1'
LIMITS = dict(inputBytes=50*1024**2, responseBytes=64*1024**2,
              artifactBytes=32*1024**2, imageBytes=4*1024**2,
              artifacts=128, pixels=20_000_000, pages=1000, regions=64,
              textChars=5_000_000, pageTextChars=100_000, blocks=100_000,
              taskMs=1_800_000, nativeMs=120_000, ocrMs=60_000)
STATES = ('native', 'ocr', 'needs_review', 'failed', 'verified_blank')


class WorkerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def validate_request(value):
    keys = {'version', 'requestId', 'sourceId', 'sourceHash', 'format', 'timeoutMs', 'ocrLanguages'}
    valid = isinstance(value, dict) and set(value) == keys
    if valid:
        valid = (value['version'] == VERSION and
                 all(isinstance(value[k], str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', value[k])
                     for k in ('requestId', 'sourceId')) and
                 isinstance(value['sourceHash'], str) and re.fullmatch(r'[a-f0-9]{64}', value['sourceHash']) and
                 value['format'] in ('doc', 'pdf', 'image') and
                 type(value['timeoutMs']) is int and 1000 <= value['timeoutMs'] <= LIMITS['taskMs'] and
                 value['ocrLanguages'] in ('chi_sim+eng', 'chi_tra+eng', 'eng'))
    if not valid:
        raise WorkerError('IMPORT_PROTOCOL_INVALID')
    return value


def response(request):
    return dict(version=VERSION, parserVersion=PARSER_VERSION,
                **{k: request[k] for k in ('requestId', 'sourceId', 'sourceHash', 'format')},
                outcome='needs_review', error=None, warnings=[], totalPages=None,
                pages=[], artifacts=[], convertedArtifactId=None,
                coverage=dict(complete=False, processedPages=0, counts=dict.fromkeys(STATES, 0)))


def failed_page(number, code):
    return dict(page=number, width=0, height=0, state='failed', warnings=[code], blocks=[], regions=[])


def finalize(result):
    counts = dict.fromkeys(STATES, 0)
    for page in result['pages']:
        counts[page['state']] += 1
    complete = (result['format'] != 'doc' and result['totalPages'] is not None and
                result['totalPages'] > 0 and len(result['pages']) == result['totalPages'] and
                not result['error'] and not result['warnings'] and
                not counts['failed'] and not counts['needs_review'])
    result['coverage'] = dict(complete=complete, processedPages=len(result['pages'])-counts['failed'], counts=counts)
    if result['error']:
        result['outcome'] = 'failed'
    elif result['outcome'] != 'converted':
        result['outcome'] = 'parsed' if complete else 'needs_review'
    return result


def encode(result):
    raw = json.dumps(finalize(result), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
    if len(raw) > LIMITS['responseBytes']:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    return raw


def make_artifact(artifact_id, raw, media_type, width=None, height=None):
    limit = LIMITS['imageBytes'] if media_type == 'image/png' else LIMITS['artifactBytes']
    if not raw or len(raw) > limit:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    a = dict(id=artifact_id, mediaType=media_type, sha256=hashlib.sha256(raw).hexdigest(),
             byteLength=len(raw), base64=base64.b64encode(raw).decode('ascii'))
    if width is not None:
        if width <= 0 or height <= 0 or width * height > LIMITS['pixels']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        a.update(width=width, height=height)
    return a


def bounded_dimensions(width, height, dpi=160):
    if not all(math.isfinite(x) and 0 < x <= 14400 for x in (width, height)):
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    scale = min(dpi / 72, math.sqrt(LIMITS['pixels'] / (width * height)) * .99)
    return scale


def same_text(a, b):
    # For duplicate evidence only: never normalize the retained original text.
    return ''.join(a.split()) == ''.join(b.split()) and bool(a.strip())


def overlap(a, b):
    area = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    denominator = min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))
    return area / denominator if denominator > 0 else 0


def image_dimensions(raw):
    """Header-only PNG/JPEG probe before native decoding. No extensions, URLs or decompression."""
    width = height = 0
    if len(raw) >= 24 and raw[:8] == b'\x89PNG\r\n\x1a\n' and raw[12:16] == b'IHDR':
        width, height = int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')
    elif raw[:2] == b'\xff\xd8':
        index = 2
        while index+4 <= len(raw):
            if raw[index] != 0xff:
                break
            while index < len(raw) and raw[index] == 0xff:
                index += 1
            if index >= len(raw):
                break
            marker = raw[index]; index += 1
            if marker in (0xd9, 0xda):
                break
            if marker == 0x01 or 0xd0 <= marker <= 0xd7:
                continue
            size = int.from_bytes(raw[index:index+2], 'big')
            if size < 2 or index+size > len(raw):
                break
            if marker in (0xc0, 0xc1, 0xc2) and size >= 8:
                height = int.from_bytes(raw[index+3:index+5], 'big')
                width = int.from_bytes(raw[index+5:index+7], 'big')
                break
            index += size
    if not width or not height:
        raise WorkerError('FILE_TYPE_MISMATCH')
    if width*height > LIMITS['pixels']:
        raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    return width, height
