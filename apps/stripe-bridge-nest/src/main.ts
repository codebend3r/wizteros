import { createApp } from '@/app.js'
import { PORT } from '@/config.js'

const app = await createApp()
await app.listen({ port: PORT, host: '0.0.0.0' })
