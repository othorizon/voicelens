import { PassThrough, type Readable } from "node:stream";
import { buffer as collect } from "node:stream/consumers";
import JSZip from "jszip";
import * as yauzl from "yauzl";
import { getObjectRange, objectSize } from "@/lib/storage";

/**
 * The two ways the importer gets at a zip.
 *
 * A demo archive is built in memory and read there (`openZipBuffer`). An
 * uploaded archive lives in the bucket, and reading it back through the web
 * process byte for byte is what used to force a size ceiling — so
 * `openZipObject` reads it *in place* with ranged GETs: the central directory
 * first, then one range per entry. Peak memory is a single entry, not the
 * whole archive, whether the zip is 50MB or 50GB.
 */

export interface ZipEntry {
  /** Path inside the archive, as stored. */
  path: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export interface ZipArchive {
  entries: ZipEntry[];
  close(): Promise<void>;
}

/** Read an archive already held in memory. */
export async function openZipBuffer(data: ArrayBuffer): Promise<ZipArchive> {
  const zip = await JSZip.loadAsync(data);
  const entries: ZipEntry[] = [];

  zip.forEach((path, file) => {
    if (file.dir) return;
    entries.push({
      path,
      text: () => file.async("string"),
      bytes: () => file.async("uint8array"),
    });
  });

  return { entries, close: async () => {} };
}

/** Read an archive that is sitting in the bucket, without downloading it. */
export async function openZipObject(path: string): Promise<ZipArchive> {
  const total = await objectSize(path);
  const zipFile = await yauzl.fromRandomAccessReaderPromise(new RangeReader(path, total), total, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: false,
  });

  const entries: ZipEntry[] = [];
  try {
    for await (const entry of zipFile.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      entries.push({
        path: entry.fileName,
        bytes: async () => new Uint8Array(await readEntry(zipFile, entry)),
        text: async () => (await readEntry(zipFile, entry)).toString("utf8"),
      });
    }
  } catch (err) {
    zipFile.close();
    throw err;
  }

  return {
    entries,
    close: async () => {
      zipFile.close();
    },
  };
}

async function readEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return collect(await zipFile.openReadStreamPromise(entry));
}

/** Bytes pulled ahead when a sequential scan is detected. */
const PREFETCH = 256 * 1024;
/** Windows kept from those scans. Only scans populate them, so a few is plenty. */
const MAX_WINDOWS = 4;

/**
 * Serves yauzl's seeks as HTTP range requests against the bucket.
 *
 * The reads come in two very different shapes, and treating them the same is
 * what makes this slow: walking the central directory is thousands of 6–46
 * byte reads in strict order, while opening an entry is one scattered 30-byte
 * read for its local header followed by a large streamed one for the data.
 *
 * So a read that continues where the last one stopped is taken as a scan and
 * pulls a window ahead — the whole directory then costs a handful of round
 * trips instead of three or four per entry. A scattered read gets exactly the
 * bytes it asked for, because prefetching past a local file header would only
 * re-download the entry data that is about to be streamed anyway.
 */
class RangeReader extends yauzl.RandomAccessReader {
  private windows: { start: number; data: Buffer }[] = [];
  private nextSequential = -1;

  constructor(
    private readonly path: string,
    private readonly totalSize: number,
  ) {
    super();
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null) => void,
  ): void {
    this.serve(buffer, offset, length, position).then(
      () => callback(null),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }

  private async serve(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<void> {
    const end = position + length;

    const hit = this.windows.find((w) => position >= w.start && end <= w.start + w.data.length);
    if (hit) {
      hit.data.copy(buffer, offset, position - hit.start, position - hit.start + length);
      this.nextSequential = end;
      return;
    }

    const scanning = position === this.nextSequential;
    const want = scanning ? Math.max(length, PREFETCH) : length;
    const data = await collect(
      this.stream(position, Math.min(position + want, this.totalSize) - 1),
    );
    if (data.length < length) throw new Error(`读取 ${this.path} 时越过了对象末尾`);

    data.copy(buffer, offset, 0, length);
    this.nextSequential = end;

    if (scanning) {
      this.windows.push({ start: position, data });
      if (this.windows.length > MAX_WINDOWS) this.windows.shift();
    }
  }

  // yauzl asks for [start, end); an HTTP range is inclusive at both ends.
  _readStreamForRange(start: number, end: number): Readable {
    return this.stream(start, end - 1);
  }

  close(callback: (err: Error | null) => void): void {
    this.windows = [];
    callback(null);
  }

  private stream(start: number, endInclusive: number): Readable {
    const out = new PassThrough();
    getObjectRange(this.path, start, endInclusive).then(
      (body) => {
        body.on("error", (err: Error) => out.destroy(err));
        body.pipe(out);
      },
      (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
    );
    return out;
  }
}
