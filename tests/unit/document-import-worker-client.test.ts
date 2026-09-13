// Keep the sandbox supervisor's hermetic contract tests in the main CI gate.
// Native Docker/OCR tests remain separately opt-in and must not be claimed here.
import '../../workers/document-import/tests/client.test.js'
