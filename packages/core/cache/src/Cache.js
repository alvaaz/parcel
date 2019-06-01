// @flow

import type {Readable} from 'stream';

import type {FilePath} from '@parcel/types';

import * as fs from '@parcel/fs';
import {createReadStream, createWriteStream} from 'fs';
import invariant from 'assert';
import path from 'path';
import logger from '@parcel/logger';
import {DefaultMap, serialize, deserialize} from '@parcel/utils';

// Do not construct this directly! This is the default export only so that it
// can be referenced by the deserializer.
// Instead, use the exported `getCacheByDir` below to get the unique instance
// corresponding to a given cache directory.
export default class Cache {
  dir: FilePath;
  invalidated: Set<FilePath>;

  constructor(cacheDir: FilePath) {
    this.dir = cacheDir;
    this.invalidated = new Set();
  }

  static deserialize(opts: {cacheDir: FilePath}) {
    return getCacheByDir(opts.cacheDir);
  }

  serialize() {
    return {
      cacheDir: this.dir
    };
  }

  getCachePath(cacheId: string, extension: string = '.json'): FilePath {
    return path.join(
      this.dir,
      cacheId.slice(0, 2),
      cacheId.slice(2) + extension
    );
  }

  getStream(key: string): Readable {
    return createReadStream(this.getCachePath(key, '.blob'));
  }

  async setStream(key: string, stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      stream
        .pipe(createWriteStream(this.getCachePath(key, '.blob')))
        .on('error', reject)
        .on('finish', () => resolve(key));
    });
  }

  async get(key: string) {
    try {
      // let extension = path.extname(key);
      // TODO: support more extensions
      let data = await fs.readFile(this.getCachePath(key), {encoding: 'utf8'});

      // if (extension === '.json') {
      invariant(typeof data === 'string');
      return deserialize(data);
      //}

      //return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      } else {
        throw err;
      }
    }
  }

  async set(key: string, value: any) {
    try {
      // TODO: support more than just JSON
      let blobPath = this.getCachePath(key);
      let data = serialize(value);

      await fs.writeFile(blobPath, data);
      return key;
    } catch (err) {
      logger.error(`Error writing to cache: ${err.message}`);
    }
  }
}

const cacheByDir: DefaultMap<FilePath, Cache> = new DefaultMap(dir => {
  return new Cache(dir);
});

export async function createCacheDir(dir: FilePath): Promise<void> {
  // First, create the main cache directory if necessary.
  await fs.mkdirp(dir);

  // In parallel, create sub-directories for every possible hex value
  // This speeds up large caches on many file systems since there are fewer files in a single directory.
  let dirPromises = [];
  for (let i = 0; i < 256; i++) {
    dirPromises.push(
      fs.mkdirp(path.join(dir, ('00' + i.toString(16)).slice(-2)))
    );
  }

  await dirPromises;
}

export function getCacheByDir(dir: FilePath): Cache {
  return cacheByDir.get(dir);
}
