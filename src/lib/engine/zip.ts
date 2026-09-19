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
  const zipFile = await yauzl.fromRandomAccessReaderPromise(new RangeReader(path), total, {
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

/**
 * Serves yauzl's seeks as HTTP range requests against the bucket. Each read is
 * an independent GET, so the importer can still pull several entries at once.
 */
class RangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly path: string) {
    super();
  }

  // yauzl asks for [start, end); an HTTP range is inclusive at both ends.
  _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    getObjectRange(this.path, start, end - 1).then(
      (body) => {
        body.on("error", (err: Error) => out.destroy(err));
        body.pipe(out);
      },
      (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
    );
    return out;
  }
}
