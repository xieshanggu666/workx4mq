// 服务端入口：node server/index.js [--port 8080] [--db data/server-wal.jsonl]
import { createApp } from './app.js'
import { createHttpServer } from './http.js'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}

const port = Number(arg('--port', process.env.PORT || 8080))
const dbFile = arg('--db', process.env.DB_FILE || 'data/server-wal.jsonl')
// --no-seed：迁移目标库模式（仅组织/权限/任务/卡券模板种子，无业务数据与余额）——
// 前端离线模式产生的本地台账快照可迁移进该空库，避免与原生业务种子双计余额/库存。
const noSeed = args.includes('--no-seed')

const app = await createApp({ dbFile, seed: noSeed ? 'org' : undefined })
const server = createHttpServer(app)

server.listen(port, () => {
  console.log(`🎲 抽奖履约服务端已启动：http://localhost:${port}`)
  console.log(`   WAL 事件库：${dbFile}（崩溃自动续办；租户/积分/库存/风控/对账/审计全链路）`)
  if (noSeed) console.log('   迁移目标库模式（--no-seed）：业务数据为空，等待离线快照迁移导入（POST /api/migration/run）')
  else console.log('   演示登录：POST /api/auth/customer-login {"userId":"u-1001"} / member-login {"memberId":"m-star-risk"}')
})

const shutdown = async () => {
  server.close()
  await app.k.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
