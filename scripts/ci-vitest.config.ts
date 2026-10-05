import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../vitest.config.js'
import CiTestSequencer from './ci-test-sequencer.js'

// Share all discovery, isolation, database setup and coverage settings. Only
// shard selection differs; Vitest 3 requires the sequencer constructor here.
export default mergeConfig(baseConfig, defineConfig({
  test: { sequence: { sequencer: CiTestSequencer } },
}))
