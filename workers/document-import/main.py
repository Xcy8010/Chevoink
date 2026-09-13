"""One request, one container. Source stays read-only; stdout is the sole result channel."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from protocol import LIMITS, WorkerError, encode, failed_page, response, validate_request
from runtime import INPUT, WORK, assert_sandbox, read_bounded, run_stage


def read_request():
    path = Path('/input/request.json')
    if path.stat().st_size > 4096:
        raise WorkerError('IMPORT_PROTOCOL_INVALID')
    return validate_request(json.loads(read_bounded(path, 4096)))


def main(request):
    result = response(request)
    deadline = time.monotonic() + request['timeoutMs']/1000 - .25
    try:
        if INPUT.is_symlink() or not INPUT.is_file() or not 0 < INPUT.stat().st_size <= LIMITS['inputBytes']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        if hashlib.sha256(read_bounded(INPUT, LIMITS['inputBytes'])).hexdigest() != request['sourceHash']:
            raise WorkerError('IMPORT_PROTOCOL_INVALID')
        if request['format'] == 'doc':
            part = run_stage('doc', request, deadline)
            result.update(outcome='converted', artifacts=[part['artifact']], convertedArtifactId=part['artifact']['id'])
            result['warnings'] = ['DOC_CONVERSION_REQUIRES_DOCX_PARSER', 'DOC_FIDELITY_REVIEW_REQUIRED']
        else:
            if request['format'] == 'pdf':
                info = run_stage('inspect', request, deadline)
                result.update(totalPages=info['totalPages'], warnings=info['warnings'])
            else:
                result['totalPages'] = 1
            artifact_bytes = chars = block_count = 0
            exhausted = None
            for number in range(1, result['totalPages']+1):
                if exhausted:
                    result['pages'].append(failed_page(number, exhausted))
                    continue
                try:
                    part = run_stage('page' if request['format'] == 'pdf' else 'image', request, deadline, number)
                    new_bytes = sum(a['byteLength'] for a in part['artifacts'])
                    new_chars = sum(len(b['text']) for b in part['page']['blocks'])
                    new_blocks = len(part['page']['blocks'])
                    if (artifact_bytes+new_bytes > LIMITS['artifactBytes'] or
                            len(result['artifacts'])+len(part['artifacts']) > LIMITS['artifacts'] or
                            chars+new_chars > LIMITS['textChars'] or block_count+new_blocks > LIMITS['blocks']):
                        exhausted = 'IMPORT_LIMIT_EXCEEDED'
                        raise WorkerError(exhausted)
                    artifact_bytes += new_bytes; chars += new_chars; block_count += new_blocks
                    result['pages'].append(part['page'])
                    result['artifacts'].extend(part['artifacts'])
                except WorkerError as exc:
                    result['pages'].append(failed_page(number, exc.code))
                    if time.monotonic() >= deadline:
                        exhausted = 'IMPORT_DEADLINE_EXCEEDED'
                finally:
                    # Constant, private tmpfs paths only; source is never removed or rewritten.
                    for name in ('ocr.png', 'ocr.tsv', 'image.pdf', 'part.json'):
                        (WORK / name).unlink(missing_ok=True)
    except WorkerError as exc:
        result.update(outcome='failed', error=exc.code)
    except Exception:
        result.update(outcome='failed', error='IMPORT_PARSE_FAILED')
    return result


def stage(name, request):
    try:
        if name == 'doc':
            from libreoffice_convert import convert
            data = convert()
        elif name == 'inspect':
            from pdf_ocr import inspect_pdf
            data = inspect_pdf()
        elif name == 'page':
            from pdf_ocr import process_page
            data = process_page(int(sys.argv[3]), request)
        elif name == 'image':
            from pdf_ocr import process_image
            data = process_image(request)
        else:
            raise WorkerError('IMPORT_PROTOCOL_INVALID')
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        if len(raw) > LIMITS['responseBytes']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
    except WorkerError as exc:
        raw = json.dumps({'error': exc.code}).encode()
    except Exception:
        raw = json.dumps({'error': 'IMPORT_CONVERT_FAILED' if name == 'doc' else 'IMPORT_PARSE_FAILED'}).encode()
    (WORK / 'part.json').write_bytes(raw)


if __name__ == '__main__':
    try:
        assert_sandbox()
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (LIMITS['responseBytes'], LIMITS['responseBytes']))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        request = read_request()
        if len(sys.argv) > 1:
            if len(sys.argv) not in (3, 4) or sys.argv[1] != '--stage':
                raise WorkerError('IMPORT_PROTOCOL_INVALID')
            stage(sys.argv[2], request)
        else:
            # Reserve stdout for protocol: native libraries cannot contaminate it with diagnostics.
            output_fd = os.dup(sys.stdout.fileno())
            with open(os.devnull, 'w') as null:
                os.dup2(null.fileno(), sys.stdout.fileno())
                result = main(request)
                raw = encode(result)
            with os.fdopen(output_fd, 'wb') as output:
                output.write(raw)
    except Exception:
        # Invalid framing / fatal supervisor failure is a nonzero exit, never partial success.
        sys.exit(2)
