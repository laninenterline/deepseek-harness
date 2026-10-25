import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishImmutableObject } from '../src/store.ts'

const fsControl = vi.hoisted(() => ({ directoryErrors: new Map<string, string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const code = fsControl.directoryErrors.get(String(args[0]))
      if (args[1] === constants.O_RDONLY && code !== undefined) {
        const error = new Error(`mocked directory open failure: ${code}`) as NodeJS.ErrnoException
        error.code = code
        throw error
      }
      return actual.open(...args)
    },
  }
})

const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x10, 0x11, 0x12, 0x13])
const SHA256 = createHash('sha256').update(BYTES).digest('hex')

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-ancestor-durability-'))
  roots.push(root)
  return root
}

async function makeTarget(root: string): Promise<string> {
  return join(root, 'objects', SHA256.slice(0, 2), SHA256)
}

afterEach(async () => {
  fsControl.directoryErrors.clear()
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('ancestor directory durability', () => {
  it('publishes when an ancestor can be traversed but not opened', async () => {
    const root = await makeRoot()
    const target = await makeTarget(root)
    fsControl.directoryErrors.set(dirname(root), 'EACCES')

    await publishImmutableObject(root, target, BYTES, SHA256)

    expect(new Uint8Array(await readFile(target))).toEqual(BYTES)
  })

  it('reports an unrelated directory-sync failure', async () => {
    const root = await makeRoot()
    const target = await makeTarget(root)
    fsControl.directoryErrors.set(dirname(root), 'EIO')

    await expect(publishImmutableObject(root, target, BYTES, SHA256))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })
})
