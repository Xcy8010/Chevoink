"""Runs only in the offline container, under the supervisor's 120-second deadline."""
import subprocess
import time
import zipfile

from protocol import LIMITS, WorkerError, make_artifact
from runtime import INPUT, WORK, read_bounded


def validate_doc():
    import olefile
    with INPUT.open('rb') as stream:
        if stream.read(8) != bytes.fromhex('d0cf11e0a1b11ae1'):
            raise WorkerError('FILE_TYPE_MISMATCH')
    with olefile.OleFileIO(str(INPUT), raise_defects=olefile.DEFECT_INCORRECT) as ole:
        if not ole.exists('WordDocument'):
            raise WorkerError('FILE_TYPE_MISMATCH')
        fib = ole.openstream('WordDocument').read(32)
        if len(fib) < 32 or fib[:2] != b'\xec\xa5':
            raise WorkerError('FILE_TYPE_MISMATCH')
        flags = int.from_bytes(fib[10:12], 'little')
        if flags & (0x0100 | 0x8000):
            raise WorkerError('IMPORT_PASSWORD_REQUIRED')
        if not ole.exists('1Table' if flags & 0x0200 else '0Table'):
            raise WorkerError('FILE_TYPE_MISMATCH')


def convert():
    validate_doc()
    import uno
    import unohelper
    from com.sun.star.task import XInteractionHandler

    class RejectInteractions(unohelper.Base, XInteractionHandler):
        def handle(self, request):
            # Deny password prompts, repairs, linked-resource and other interactive approval.
            for continuation in request.getContinuations():
                abort = continuation.queryInterface(uno.getTypeByName('com.sun.star.task.XInteractionAbort'))
                if abort:
                    abort.select()
                    return

    def prop(name, value):
        p = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
        p.Name, p.Value = name, value
        return p

    profile = WORK / 'lo-profile'
    (profile / 'user').mkdir(parents=True, exist_ok=True)
    (profile / 'user/registrymodifications.xcu').write_text(
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>'
        '</oor:items>', encoding='utf-8')
    proc = subprocess.Popen(['/usr/bin/libreoffice', '-env:UserInstallation=' + profile.as_uri(),
                             '--headless', '--nologo', '--nodefault', '--norestore',
                             '--accept=pipe,name=document_import;urp;StarOffice.ComponentContext'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            shell=False)
    doc = None
    try:
        ctx = uno.getComponentContext()
        resolver = ctx.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', ctx)
        until = time.monotonic() + 15
        remote = None
        while remote is None:
            try:
                remote = resolver.resolve('uno:pipe,name=document_import;urp;StarOffice.ComponentContext')
            except Exception:
                if time.monotonic() >= until or proc.poll() is not None:
                    raise WorkerError('IMPORT_CONVERT_FAILED') from None
                time.sleep(.1)
        desktop = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
        doc = desktop.loadComponentFromURL(INPUT.as_uri(), '_blank', 0, (
            prop('Hidden', True), prop('ReadOnly', True), prop('FilterName', 'MS Word 97'),
            prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),
            prop('UpdateDocMode', uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')),
            prop('InteractionHandler', RejectInteractions()),))
        if doc is None:
            raise WorkerError('IMPORT_CONVERT_FAILED')
        output = WORK / 'converted.docx'
        doc.storeAsURL(output.as_uri(), (prop('FilterName', 'Office Open XML Text'), prop('Overwrite', False)))
        if not output.is_file() or not 0 < output.stat().st_size <= LIMITS['artifactBytes']:
            raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        # Do not extract the ZIP. Re-check archive sizes and reject macro-bearing output.
        with zipfile.ZipFile(output) as archive:
            entries = archive.infolist()
            if (len(entries) > 3000 or sum(e.file_size for e in entries) > 200*1024**2 or
                    any(e.file_size > LIMITS['inputBytes'] or e.file_size > max(1, e.compress_size)*200 or
                        e.flag_bits & 1 or e.filename.startswith('/') or '..' in e.filename.split('/') or
                        'vbaproject' in e.filename.lower() for e in entries) or
                    'word/document.xml' not in archive.namelist()):
                raise WorkerError('IMPORT_LIMIT_EXCEEDED')
        return {'artifact': make_artifact('converted-docx', read_bounded(output, LIMITS['artifactBytes']),
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}
    finally:
        try:
            if doc is not None:
                doc.close(True)
        finally:
            # A document close exception must never skip process cleanup.
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
