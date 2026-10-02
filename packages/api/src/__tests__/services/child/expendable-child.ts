// Started by host.test.ts: becomes expendable, says so, and stays up
import { becomeExpendable } from '../../../services/child/serve'

becomeExpendable()
process.send!({ ready: true })
setInterval(() => {}, 1000)
