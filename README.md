# 重大虎溪小助手 · 在线版

重庆大学虎溪校区新生的校园助手：课表、校历、学校攻略、办事入口、校园地图和周边资料放在一个页面里。纯静态前端，无后端、无账号，个人记录只存在本机浏览器。

这个仓库是 v0.6.0 发布产物的快照，用于 GitHub Pages 在线预览；源码、构建脚本和测试不在这个仓库里。

## 在线体验

仓库 Settings → Pages 里开启后，地址是 `https://<你的用户名>.github.io/<仓库名>/`。

## 本地打开

- Windows：双击 `index.html`；macOS / Linux：同样双击 `index.html`，用 Chrome、Edge 或 Safari 打开。
- 不需要安装 Node.js，不需要联网，不需要注册。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` | 单页入口 |
| `js/` | 4 个首屏脚本（bundle-base / bundle-content / search / bundle-ui）、Service Worker 和 28 个学业资料分片 |
| `css/` | 10 个样式表 |
| `content/` | 资料目录与搜索索引 |
| `sources/` | 攻略引用的原始文件（PDF / Word / 表格） |
| `assets/` | 图片、图标、地图底图 |

## 工程指标

- 首屏 4 个脚本、约 160 KB（Brotli），整页 20 个请求
- Lighthouse：移动端 96 / 100 / 100，桌面端 100 / 100 / 100
- 离线可用（Service Worker 预缓存），768×1024 与 1024×768 下无横向溢出
