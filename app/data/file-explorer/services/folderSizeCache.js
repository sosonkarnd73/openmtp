/**
 * In-memory cache of computed recursive folder sizes, so navigating back to a
 * directory shows its folder sizes instantly.
 *
 * Keys are scoped by device type and MTP storage. Any mutation on a device
 * (delete, rename, new folder, transfer) or an explicit refresh invalidates
 * that device's entries. A per-device generation counter makes sure that a
 * computation started before an invalidation can't write a stale value back.
 */
const cache = new Map();
const generations = {};

const makeKey = ({ deviceType, storageId, filePath }) =>
  `${deviceType}|${storageId ?? ''}|${filePath}`;

export const folderSizeCache = {
  get(args) {
    return cache.get(makeKey(args));
  },

  generation(deviceType) {
    return generations[deviceType] ?? 0;
  },

  /**
   * Stores [size] only if no invalidation happened since [generation] was read.
   */
  set(args, size, generation) {
    if (generation !== this.generation(args.deviceType)) {
      return;
    }

    cache.set(makeKey(args), size);
  },

  invalidate(deviceType) {
    const prefix = `${deviceType}|`;

    generations[deviceType] = this.generation(deviceType) + 1;

    Array.from(cache.keys()).forEach((key) => {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    });
  },
};
