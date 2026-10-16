import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@hermes\/plugin-sdk$/, replacement: path.join(here, 'stub-sdk.mjs') }]
  },
  test: {
    environment: 'jsdom',
    include: ['*.test.mjs']
  }
})
