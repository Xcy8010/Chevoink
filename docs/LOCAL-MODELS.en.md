# Local models and relays

Select a local OpenAI-compatible relay, LM Studio, or Ollama in model settings. The computer serving the model runs an outbound connector; the cloud API never fetches the user's loopback/private endpoint.

1. Start the model service, enter its actual model ID, endpoint and context size, and save the local connection profile. This sends no model request and leaves the model disabled.
2. Install Node.js 22 on that computer. Download `chevoink-local-connector.mjs` and `chevoink-connector.local.json`. Set `apiKey` in the local file only if the local service needs authentication; otherwise leave it empty.
3. Run `node chevoink-local-connector.mjs chevoink-connector.local.json` and keep it running. Ctrl+C stops it. It opens no listening port and offers no shell or generic proxy.
4. Edit and enable the model in Chevoink, then validate and save. Validation makes at most seven small synthetic requests; the upstream service may charge. It uses no manuscript. Unverified capabilities remain unknown; native tools require verifiable responses.

Targets must be explicit loopback or RFC1918 IPs over HTTP/HTTPS, with optional ports. Redirects, URL credentials, metadata addresses, arbitrary hostnames and public endpoints are rejected. TLS certificate verification remains enabled. OpenAI-compatible relays usually use `/v1`; Ollama uses native `/api/chat` with explicit context/output limits.

The upstream key stays in the local file and is sent only to its pinned local endpoint. The dedicated cloud connection credential is not an account session and cannot execute tools. Protect this file and never commit/share it. Model deletion, account banning and session-version revocation invalidate access. Create a new profile to change the endpoint/model identity; old runs retain their route. If the file is lost, delete the profile and pair a new one.

Main and auxiliary text calls share this transport while cloud tool permissions, manuscript revisions, recovery and usage evidence remain authoritative. Unverified native tools cannot run Agent requests. Unsupported Ollama parameters, including forced tool choice/response formats, fail explicitly. Non-thinking reviews still require evidence that thinking can be disabled; compatibility cannot waive a required check.

Text, tools and actual reasoning streams are preserved. Existing custom-model Credits exemption remains; an upstream relay can still charge. Missing usage is not zero. Cancellation, disconnection and unknown results never automatically resend the model request. One request per local model runs at a time; transient transport currently assumes one API process.

The model computer must remain online. Cloud development/builds can continue with the home computer off, but its local model cannot. Manuscripts and tools still use the cloud: this is not fully offline writing. Real devices/models, speed and literary quality require separate acceptance.
