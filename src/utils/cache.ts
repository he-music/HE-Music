type StorageType = "localStorage" | "sessionStorage";

interface CacheOptions {
  key: string;
  /** 缓存时长（分钟），-1 表示永久有效。 */
  time: number;
  storage?: StorageType;
  /** 是否读取缓存；false 时仍会用请求结果刷新缓存。 */
  useCache?: boolean;
}

/** 缓存不可用时回退到请求，只有请求本身的错误才向调用方抛出。 */
export const getCacheData = async <T, Args extends unknown[]>(
  promiseFunc: (...args: Args) => Promise<T>,
  options: CacheOptions,
  ...args: Args
): Promise<T> => {
  const { key, time, storage = "sessionStorage", useCache = true } = options;
  if (useCache) {
    try {
      const cachedData = window[storage].getItem(key);
      if (cachedData) {
        const cached: { value: T; expiry: number } | null = JSON.parse(cachedData);
        if (
          cached &&
          typeof cached === "object" &&
          Object.hasOwn(cached, "value") &&
          typeof cached.expiry === "number" &&
          (cached.expiry === -1 || cached.expiry === 0 || Date.now() < cached.expiry)
        ) {
          return cached.value;
        }
      }
    } catch (error) {
      console.warn(`读取缓存失败：${key}`, error);
    }
  }

  const result = await promiseFunc(...args);
  try {
    const expiry = time === -1 ? -1 : Date.now() + time * 60_000;
    window[storage].setItem(key, JSON.stringify({ value: result, expiry }));
  } catch (error) {
    console.warn(`写入缓存失败：${key}`, error);
  }
  return result;
};
