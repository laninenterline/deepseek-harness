import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishImmutableObject } from '../src/store.ts'

const fsControl = vi.hoisted(() => ({ linkErrors: [] as NodeJS.ErrnoException[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async link(...args: Parameters<typeof actual.link>): Promise<void> {
      const error = fsControl.linkErrors.shift()
      if (error !== undefined) throw error
      await actual.link(...args)
    },
  }
})

const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
const SHA256 = createHash('sha256').update(BYTES).digest('hex')

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-link-fallback-'))
  roots.push(root)
  return root
}

async function makeTarget(root: string): Promise<string> {
  return join(root, 'objects', SHA256.slice(0, 2), SHA256)
}

function linkFailure(code: string): NodeJS.ErrnoException {
  const error = new Error(`mocked link(2) failure: ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

afterEach(async () => {
  fsControl.linkErrors.length = 0
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('immutable object publication on filesystems without hard links', () => {
  it('publishes an exclusive copy when link(2) is refused', async () => {
    const root = await makeRoot()
    const target = await makeTarget(root)
    fsControl.linkErrors.push(linkFailure('EPERM'))

    await publishImmutableObject(root, target, BYTES, SHA256)

    expect(new Uint8Array(await readFile(target))).toEqual(BYTES)
    expect((await stat(target)).mode & 0o777).toBe(0o400)
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('keeps digest-verified deduplication when the copy collides with an existing object', async () => {
    const root = await makeRoot()
    const target = await makeTarget(root)
    await publishImmutableObject(root, target, BYTES, SHA256)

    fsControl.linkErrors.push(linkFailure('EACCES'))
    await publishImmutableObject(root, target, BYTES, SHA256)

    expect(new Uint8Array(await readFile(target))).toEqual(BYTES)
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('reports an unrelated link failure instead of copying', async () => {
    const root = await makeRoot()
    const target = await makeTarget(root)
    fsControl.linkErrors.push(linkFailure('EIO'))

    await expect(publishImmutableObject(root, target, BYTES, SHA256))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })
})
