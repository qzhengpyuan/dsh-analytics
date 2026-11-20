// A minimal ZIP writer.
//
// Office files (.docx/.xlsx) are ZIP archives, and the plugin ships with no
// runtime dependencies on purpose, so this writes the archive itself: stored
// (uncompressed) entries, which every Office reader accepts. CRC-32 comes from
// node:zlib so it is the same polynomial everyone else uses.

import { crc32 } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
// Fixed timestamp (1980-01-01 00:00) keeps two runs of the same export byte
// identical, which makes the tests and diffing sane.
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1

/**
 * Build an archive from `{ name: string | Buffer }` entries.
 * @param {Record<string, string | Buffer>} files - path inside the archive.
 * @returns {Buffer} the ZIP bytes.
 */
export function buildZip(files) {
  const entries = Object.entries(files).map(([name, content]) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    return { name: Buffer.from(name, 'utf8'), data, crc: crc32(data) }
  })

  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = entry.name
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + entry.data.length
  }

  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_SIG, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBytes, end])
}

/** Escape text for an XML document body or attribute. */
export function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    // Control characters are not legal in XML 1.0 at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}
