import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pruneOldBackups, listSnapshots } from '../../../src/main/database/migrations'

/**
 * 迁移快照的清理与清点（1.0.49，修主用户 0c05da32）
 *
 * ── 为什么这件事值得一组单测 ──
 *
 * `user.db.backup-v<n>-<时间戳>` 是**完整库快照**（含 projects / agents /
 * memos / agent_grants），跟导出的 JSON 完全是两回事 —— 2026-09-22
 * 环境恢复事故里，正是它把数据救了回来。所以"还剩几份快照"
 * 直接等于"还剩几条退路"，而这个数字此前是**错的**。
 *
 * 原实现把 `-wal` / `-shm` 也各算一份快照：
 * - 一份快照占 3 个文件名 → `keep=2` 实际保住不到 1 份；
 * - 按 mtime 排序删时主文件与 sidecar 顺序可能不挨着 → 留下
 *   "只有孤儿 `-shm`、主文件已不见"的目录，人看了以为还有备份。
 *
 * 这组用例把"成组删除"和"只数主文件"两件事分别钉住。
 * 用真实临时目录 + 真实 fs，不 mock —— 这里要验的正是文件系统行为。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-snapshot-prune-'))
const dbPath = path.join(dir, 'user.db')
const PREFIX = 'user.db.backup-'

/** 造一份"看起来像真快照"的文件（主文件 + 可选 sidecar） */
function makeSnapshot(
  stamp: string,
  opts: { wal?: boolean; shm?: boolean; mtimeOffsetMs?: number; bytes?: number } = {}
): string {
  const main = `${PREFIX}v19-${stamp}`
  const size = opts.bytes ?? 1024
  fs.writeFileSync(path.join(dir, main), Buffer.alloc(size))
  if (opts.wal) fs.writeFileSync(path.join(dir, `${main}-wal`), Buffer.alloc(64))
  if (opts.shm) fs.writeFileSync(path.join(dir, `${main}-shm`), Buffer.alloc(32))

  // 显式设 mtime，让"新旧"可控（不依赖真实写入顺序）
  if (opts.mtimeOffsetMs !== undefined) {
    const t = new Date(Date.now() + opts.mtimeOffsetMs)
    fs.utimesSync(path.join(dir, main), t, t)
  }
  return main
}

function cleanDir() {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(PREFIX)) fs.unlinkSync(path.join(dir, f))
  }
}

beforeEach(cleanDir)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('pruneOldBackups（快照轮转）', () => {
  it('保留最近 2 份，删掉更旧的', () => {
    makeSnapshot('2026-01-01T00-00-00', { mtimeOffsetMs: -3000 })
    makeSnapshot('2026-01-02T00-00-00', { mtimeOffsetMs: -2000 })
    makeSnapshot('2026-01-03T00-00-00', { mtimeOffsetMs: -1000 })

    pruneOldBackups(dbPath, 2)

    const { snapshots } = listSnapshots(dbPath)
    expect(snapshots).toHaveLength(2)
    // 最新的两份留下，最旧的被删
    expect(snapshots.map((s) => s.name).join()).not.toContain('2026-01-01')
  })

  /**
   * 核心修复 1：`-wal` / `-shm` 不能各算一份快照。
   *
   * 3 份快照各带 sidecar = 9 个文件。旧实现按文件数切 keep=2，
   * 会把最新那份的 sidecar 当成"第 2 份快照"留下、却删掉第 2 份主文件 ——
   * 于是目录里只剩 1 份可用快照，人却看到 3 个文件名。
   */
  it('带 sidecar 的快照按「主文件」计数，不是按文件名计数', () => {
    makeSnapshot('2026-01-01T00-00-00', { mtimeOffsetMs: -3000, wal: true, shm: true })
    makeSnapshot('2026-01-02T00-00-00', { mtimeOffsetMs: -2000, wal: true, shm: true })
    makeSnapshot('2026-01-03T00-00-00', { mtimeOffsetMs: -1000, wal: true, shm: true })

    pruneOldBackups(dbPath, 2)

    const { snapshots, orphanSidecars } = listSnapshots(dbPath)
    // 3 份 → 留 2 份（旧实现这里只会留 1 份）
    expect(snapshots).toHaveLength(2)
    // 被删那份的 sidecar 必须一起走，不能留孤儿
    expect(orphanSidecars).toEqual([])
  })

  it('删掉最旧那份时，它的 -wal/-shm 一起删（不留孤儿）', () => {
    const old = makeSnapshot('2026-01-01T00-00-00', { mtimeOffsetMs: -3000, wal: true, shm: true })
    makeSnapshot('2026-01-02T00-00-00', { mtimeOffsetMs: -2000, wal: true, shm: true })
    makeSnapshot('2026-01-03T00-00-00', { mtimeOffsetMs: -1000, wal: true, shm: true })

    pruneOldBackups(dbPath, 2)

    expect(fs.existsSync(path.join(dir, old))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${old}-wal`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${old}-shm`))).toBe(false)
  })

  it('保留数以内不删任何东西', () => {
    makeSnapshot('2026-01-01T00-00-00')
    makeSnapshot('2026-01-02T00-00-00')
    pruneOldBackups(dbPath, 2)
    expect(listSnapshots(dbPath).snapshots).toHaveLength(2)
  })
})

describe('listSnapshots（清点可用退路）', () => {
  it('只数主文件，不把 sidecar 当快照', () => {
    makeSnapshot('2026-01-01T00-00-00', { wal: true, shm: true })
    makeSnapshot('2026-01-02T00-00-00')

    const { snapshots } = listSnapshots(dbPath)
    expect(snapshots).toHaveLength(2)
    // 名字里不能出现 -wal/-shm
    expect(snapshots.every((s) => !s.name.endsWith('-wal') && !s.name.endsWith('-shm'))).toBe(true)
  })

  it('报出孤儿 sidecar —— 主文件不见了，退路其实少一条', () => {
    const gone = makeSnapshot('2026-01-01T00-00-00', { wal: true, shm: true })
    // 模拟"主文件被搬走、sidecar 留下"（2026-09-22 环境恢复的痕迹）
    fs.unlinkSync(path.join(dir, gone))

    const { snapshots, orphanSidecars } = listSnapshots(dbPath)
    expect(snapshots).toHaveLength(0)
    expect(orphanSidecars.sort()).toEqual([`${gone}-shm`, `${gone}-wal`].sort())
  })

  it('新→旧排序，并带上大小', () => {
    makeSnapshot('2026-01-01T00-00-00', { mtimeOffsetMs: -2000, bytes: 512 })
    makeSnapshot('2026-01-02T00-00-00', { mtimeOffsetMs: -1000, bytes: 2048 })

    const { snapshots } = listSnapshots(dbPath)
    expect(snapshots[0].name).toContain('2026-01-02')
    expect(snapshots[0].sizeBytes).toBe(2048)
    expect(snapshots[1].sizeBytes).toBe(512)
  })

  it('目录不存在时返回空，不抛错（doctor 不该因此挂掉）', () => {
    const res = listSnapshots(path.join(dir, 'no-such-subdir', 'user.db'))
    expect(res.snapshots).toEqual([])
    expect(res.orphanSidecars).toEqual([])
  })
})
