'use strict';

// ─── 版本 ───────────────────────────────────────────────────────────────────
// 缓存名带版本号：activate 时删掉所有旧名字的缓存，等于强制重新预缓存。
// 发版时和 package.json 的 "version" 一起改；tests/pwa.test.cjs 会校验两处一致。
const CACHE_VERSION = '0.6.0';
const CACHE = 'cqu-huxi-shell-v' + CACHE_VERSION;

// ─── 策略参数 ───────────────────────────────────────────────────────────────
// 导航请求等网络的上限：弱网或校园网认证页跳转时，3 秒没回来就先给缓存的外壳，别白屏。
const NAVIGATION_TIMEOUT = 3000;

// 单个响应超过 6 MB 不进缓存（校历原图、地图编辑原图这类大图继续走网络）。
const MAX_ENTRY_BYTES = 6 * 1024 * 1024;

// 缓存条目上限；超出后按写入时间淘汰最旧的，外壳文件受保护（见 pruneCache）。
const MAX_ENTRIES = 250;

// 图片缓存 30 天：命中过期缓存时先给旧图，同时用网络覆盖。
const IMAGE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// 写入时间记在响应头里：Cache API 只能存响应，没有别的字段放元数据。
const CACHED_AT_HEADER = 'x-sw-cached-at';

// 发布构建给公开文件加的内容版本号，见 tools/build-release.cjs 的 versionFiles。
const VERSIONED_QUERY = /[?&]v=[0-9a-f]{10}(?:&|$)/;

// 图片兜底占位：请求失败时回落到缓存里的图标，不另外造占位图文件。
const FALLBACK_ICON = 'assets/icons/icon-192.png?v=014f83eef1';

// ─── 预缓存外壳 ─────────────────────────────────────────────────────────────
// 只列真正必需的小文件；首屏其余的 js/css 在 install 时从 index.html 里解析出来，
// 这样以后新增模块不用回来改这份清单（手抄 27 个脚本一定会漏，漏了离线首屏就缺文件）。
// sources/ 下的原始资料一律不预缓存，也不进运行时缓存。
const CORE_SHELL = [
  'index.html',
  'js/bundle-base.js?v=a2e9195ec0',
  'js/bundle-content.js?v=5526d1bb71',
  'js/bundle-ui.js?v=6a3967b7ac',
  'offline.html',
  'manifest.webmanifest',
  'css/theme.css?v=d75194442a',
  'css/timetable.css?v=743249fd90',
  'css/polish.css?v=9bddf67c73',
  'css/pwa-status.css?v=4144be49f9',
  'assets/huxi-logo.svg?v=facb22e616',
  'assets/favicon.svg?v=f6976e27b0',
  'assets/icons/icon-192.png?v=014f83eef1',
  'assets/icons/icon-512.png?v=476393805b',
  'assets/icons/icon-maskable-512.png?v=2b591a0f6a',
  'assets/icons/apple-touch-icon-180.png?v=581e76ca7a',
  // 地图页的底图不经过 index.html 引用，单独列入首屏外壳，断网也能看到底图。
  'assets/huxi-map-clean.webp?v=2a07ecdab8',
  'assets/campus-reference.svg?v=47732a1403'
];

// index.html 里引入的 js/ 与 css/ 文件，就是首屏要用的全部资源。
// 注意：注释里不要出现 src= 或 href= 后面跟引号的写法，发布构建会把它们当成真实依赖。
const SHELL_REFERENCE = /<(?:script|link)\b[^>]*?\b(?:src|href)="((?:js|css)\/[^"]+)"/g;

self.addEventListener('install', function (event) {
  // 不再无条件 skipWaiting：新版本先等着，页面上的「有新版本」按钮发消息后才放行。
  event.waitUntil(precacheShell());
});

async function precacheShell() {
  const cache = await caches.open(CACHE);
  try {
    await cache.addAll(CORE_SHELL);
  } catch {
    // addAll 是「全有或全无」：某个文件 404 就会整批失败；退化成逐个添加，能装多少装多少。
    await Promise.all(CORE_SHELL.map(url => cache.add(url).catch(() => null)));
  }
  const shell = await shellFromIndex(cache);
  await Promise.all(shell.map(url => cache.add(url).catch(() => null)));
}

// 从刚缓存好的 index.html 里解析首屏脚本与样式，避免维护第二份清单。
async function shellFromIndex(cache) {
  try {
    const shell = await cache.match('index.html');
    if (!shell) return [];
    const html = await shell.text();
    const urls = [];
    for (const match of html.matchAll(SHELL_REFERENCE)) {
      if (!urls.includes(match[1])) urls.push(match[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      const stale = keys.filter(function (key) {
        return key !== CACHE;
      });
      await Promise.all(
        stale.map(function (key) {
          return caches.delete(key);
        })
      );
      await self.clients.claim();
    })()
  );
});

// 页面点了「有新版本 · 点此刷新」才跳过等待：不打断正在进行的操作，也不混用新旧资源。
self.addEventListener('message', function (event) {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  // 只接管同源 GET；POST、跨域、Range 分段请求（PDF / 视频）交给浏览器。
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/sources/')) return; // 原始资料不缓存

  if (request.mode === 'navigate') {
    event.respondWith(navigateWithTimeout(event));
    return;
  }
  // 发布包里的地址带 ?v=<内容哈希>：同一个地址的内容永远不变，缓存命中就直接用，
  // 而且必须按完整地址匹配——忽略查询参数会让新页面拿到旧版本的同名文件。
  if (isVersioned(url)) {
    event.respondWith(cacheFirstVersioned(event));
    return;
  }
  if (isImage(url)) {
    event.respondWith(cacheFirstImage(event));
    return;
  }
  event.respondWith(staleWhileRevalidate(event));
});

// ─── 导航：网络优先 + 3 秒超时，超时或失败回落到缓存外壳 ──────────────────
async function navigateWithTimeout(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const network = fetch(request);
  try {
    const response = await withTimeout(network, NAVIGATION_TIMEOUT);
    if (response && response.ok) await storeResponse(cache, request, response.clone());
    return response;
  } catch {
    // 超时并不代表网络断了：让它继续跑，跑完把最新外壳写进缓存（不阻塞本次返回）。
    network
      .then(function (late) {
        return late && late.ok ? storeResponse(cache, request, late.clone()) : null;
      })
      .catch(function () {});
    const cached = await matchShell(cache, request);
    // 第一次访问就断网时，给一个看得懂的离线页，而不是浏览器自己的网络错误页。
    return cached || (await cache.match('offline.html')) || Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new Error('sw: 导航请求超过 ' + ms + 'ms'));
    }, ms);
    promise.then(
      function (value) {
        clearTimeout(timer);
        resolve(value);
      },
      function (error) {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function matchShell(cache, request) {
  const exact = await cache.match(request, { ignoreSearch: true });
  if (exact) return exact;
  // 直接访问目录（部署在子路径下的 /）时请求 URL 不是 index.html，单独回落一次。
  return (await cache.match('index.html')) || (await caches.match('index.html')) || null;
}

// ─── 带版本号的文件：按完整地址缓存优先，内容不会变 ────────────────────────
async function cacheFirstVersioned(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) await storeResponse(cache, request, response.clone());
    return response;
  } catch (error) {
    return assetFallback(request, error);
  }
}

function isVersioned(url) {
  return VERSIONED_QUERY.test(url.search);
}

// ─── 图片：缓存优先，30 天后过期；失败时回落到图标 ────────────────────────
async function cacheFirstImage(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached && isFresh(cached)) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) await storeResponse(cache, request, response.clone());
    return response;
  } catch {
    if (cached) return cached; // 过期了也比破图好
    const icon = await cache.match(FALLBACK_ICON);
    return icon || Response.error();
  }
}

// ─── 其他静态资源：stale-while-revalidate，先给缓存，后台更新 ──────────────
function staleWhileRevalidate(event) {
  const request = event.request;
  const cachePromise = caches.open(CACHE);
  const network = cachePromise.then(function (cache) {
    return fetchAndStore(cache, request);
  });
  // 后台更新必须挂在 waitUntil 上，而且要同步调用（事件还在派发中），否则会被浏览器掐掉。
  event.waitUntil(
    network.then(
      function () {},
      function () {}
    )
  );
  return cachePromise
    .then(function (cache) {
      // 按完整地址匹配：没带版本号的开发文件也不该拿到别的查询参数下的另一份内容。
      return cache.match(request);
    })
    .then(function (cached) {
      return cached || network;
    })
    .catch(function (error) {
      return assetFallback(request, error);
    });
}

async function fetchAndStore(cache, request) {
  const response = await fetch(request);
  if (response && response.ok) await storeResponse(cache, request, response.clone());
  return response;
}

// 静态资源彻底失败时：同源 assets/ 给缓存里的图标，其它交给浏览器报错。
async function assetFallback(request, error) {
  if (isImage(new URL(request.url))) {
    const icon = await caches.match(FALLBACK_ICON);
    if (icon) return icon;
  }
  throw error;
}

// ─── 缓存写入：体积、来源、类型三道过滤 + 条目数上限 ──────────────────────
async function storeResponse(cache, request, response) {
  if (!response || !response.ok || response.type !== 'basic') return;
  const url = new URL(request.url);
  if (url.pathname.includes('/sources/')) return; // 原始资料一律跳过
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ENTRY_BYTES) return; // 已知超限，连读都不用读
  let body;
  try {
    body = await response.arrayBuffer();
  } catch {
    return; // 读不出正文的响应（如 opaque）放弃缓存
  }
  if (body.byteLength > MAX_ENTRY_BYTES) return; // content-length 没给准时实测一次
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  try {
    await cache.put(
      request,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      })
    );
    await pruneCache(cache);
  } catch {
    // 配额满等写入失败不影响页面使用，下次访问再试。
  }
}

function isFresh(response) {
  const at = Number(response.headers.get(CACHED_AT_HEADER)) || 0;
  // 预缓存写入的图标没有时间戳：它们只在发版时更换，而发版会换缓存名，可以一直用。
  if (!at) return true;
  return Date.now() - at < IMAGE_MAX_AGE;
}

// cache.keys() 按写入时间排序，最旧的在前；外壳文件跳过，避免把离线首屏淘汰掉。
async function pruneCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const shell = await shellFromIndex(cache);
  shell.push('index.html');
  const protectedPaths = shell.map(function (path) {
    return '/' + path;
  });
  const removable = keys.filter(function (key) {
    return !protectedPaths.some(function (path) {
      return key.url.endsWith(path);
    });
  });
  const excess = keys.length - MAX_ENTRIES;
  await Promise.all(
    removable.slice(0, excess).map(function (key) {
      return cache.delete(key);
    })
  );
}

function isImage(url) {
  if (url.pathname.includes('/assets/')) return true;
  return /\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname);
}
