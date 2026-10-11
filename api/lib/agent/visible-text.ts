// Author presentation is shared with history, reconnect and copy consumers.
// Model context and native reasoning/tool pairs never use this projection.
export {
  projectAgentAuthorText as humanizeAgentVisibleText,
  createAgentAuthorTextStream as createVisibleTextStreamer,
} from '../../../shared/agent-author-view.js'
