import { createApp } from '@/app.js'
import { fleetHosts, PORT, sshUser } from '@/config.js'

// A bad FM_HOST_IPS or a missing FM_SSH_USER stops the boot here, naming the
// variable, rather than surfacing as a 500 on the first fleet request.
fleetHosts()
sshUser()

const app = await createApp()
await app.listen({ port: PORT, host: '0.0.0.0' })
