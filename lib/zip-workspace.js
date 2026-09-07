import fs from "node:fs/promises";
import path from "node:path";

const ZIP32_MAX = 0xffffffff;
const UTF8_FLAG = 0x0800;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

async function workspaceFiles(root, directory = root) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await workspaceFiles(root, absolute));
    else if (entry.isFile()) files.push({ absolute, name: path.relative(root, absolute).replaceAll("\\", "/") });
  }
  return files;
}

async function createWorkspaceZip(workspace, archivePath) {
  const root = await fs.realpath(workspace);
  const files = await workspaceFiles(root);
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const file of files) {
    const [data, stat] = await Promise.all([fs.readFile(file.absolute), fs.stat(file.absolute)]);
    const name = Buffer.from(file.name, "utf8");
    if (data.length > ZIP32_MAX || offset > ZIP32_MAX) throw new Error("Workspace is too large for a ZIP32 handoff.");
    const checksum = crc32(data);
    const stamp = dosTimestamp(stat.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  if (files.length > 0xffff || centralSize > ZIP32_MAX || offset > ZIP32_MAX) {
    throw new Error("Workspace is too large for a ZIP32 handoff.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  await fs.writeFile(archivePath, Buffer.concat([...localRecords, ...centralRecords, end]));
  return { fileCount: files.length, size: (await fs.stat(archivePath)).size };
}

export { createWorkspaceZip };
