import { getDocumentImportReadiness } from '../../api/lib/novel-import/runtime.js'

// Internal operator command. No dotenv autodiscovery, HTTP server, DB, source file or
// synthetic document. Provision approved environment via the service manager/operator.
const status = await getDocumentImportReadiness()
process.stdout.write(JSON.stringify(status) + '\n')
if (!status.ready) process.exitCode = 1
