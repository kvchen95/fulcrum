[English](./README.md) · **简体中文**

# @fulcrum/sub-vite

微前端**子应用侧**的 vite 插件（与加载器无关，wujie / qiankun / micro-app 通用）。两个小插件，各管一件事：

| 插件 | 时机 | 作用 |
|---|---|---|
| `announce()` | dev server 启动 / 关闭 | POST 底座 `/__mf/announce`，让它**立刻**知道你在哪个端口 |
| `artifactManifest()` | build 之后 | 在产物目录写 `fulcrum-artifact.json`，底座据此免配置找到这份包 |

核心约束：**拿不到底座时必须静默跳过**。子应用单独 `pnpm dev`（底座没起）、
在 CI 里 build（底座不存在）都要正常跑完，不能因为"通知不了"就失败。

> 配套的底座侧插件：[@fulcrum/entry-vite](../entry-vite/README.zh-CN.md)

## 安装

```bash
pnpm add -D @fulcrum/sub-vite
```

## 快速开始

### 1. 在 `package.json` 里声明 `appName`

```json
{
  "name": "@fulcrum/child-two",
  "appName": "child2"
}
```

`appName` 是**微前端侧的 id**，必须等于底座 manifest 里该应用的 `name`。

为什么不用包名：包名带 scope（`@fulcrum/child-two`）、会随发布改名、私有 fork 可能重名，
而 `appName` 是稳定的。不写也能用（会回退到 `name` 并打印提示），但推荐写。

### 2. 挂上插件

```js
// vite.config.js
import { defineConfig } from 'vite';
import { announce, artifactManifest } from '@fulcrum/sub-vite';

export default defineConfig({
  base: '/child2/',
  plugins: [announce(), artifactManifest()],
});
```

也可以一次挂两个：

```js
import allPlugins from '@fulcrum/sub-vite';
plugins: [allPlugins()];
```

### 3. 正常开发

```bash
pnpm dev
```

终端输出：

```
[fulcrum-sub] 应用名 child2
[fulcrum-sub] 已告知底座：child2 在 :7002/child2/
```

底座那边立刻显示 `source: "announce"`，页面 0 延迟切换，不用等它扫描。

## 行为细节

### dev server 启动

- 在 `listening` 事件之后上报，此时端口已确定（包括几百毫秒内让出来的端口）
- 上报内容：`{ appName, port, base }`
- 底座会**再校验一次**（`GET {base}` 的 HTML 是否真带 base 前缀），不会盲信
- 底座没起 / 网络不通 → 打印一行提示后继续，**不影响 dev server**

### dev server 关闭

`close` 时 POST `/__mf/unannounce`，底座立刻释放认领，页面回落到产包或测试环境。
超时 300ms —— 进程马上就要退出了，不值得等。

### build 结束

`closeBundle` 在产物落盘之后执行，写：

```json
{
  "appName": "child2",
  "base": "/child2/",
  "builtAt": "2026-11-18T06:12:00.000Z",
  "commit": "a1b2c3d",
  "name": "@fulcrum/child-two"
}
```

`commit` 取 `GIT_COMMIT` / `CI_COMMIT_SHA`，没有就是 `null`。
写失败只 warn，**不影响产物**。

## 选项

### `announce(opts)`

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appName` | `string` | 读 `package.json` 的 `appName`，回退 `name` | 显式覆盖应用名 |
| `baseUrl` | `string` | `http://127.0.0.1:8000` | 底座地址，也可用 `MF_BASE_URL` 环境变量 |
| `quiet` | `boolean` | `false` | 关掉日志（CI 里更清爽） |

### `artifactManifest(opts)`

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appName` | `string` | 同上 | 显式覆盖应用名 |
| `quiet` | `boolean` | `false` | 关掉日志 |

产物目录取 vite 的 `build.outDir`，`base` 取 `config.base`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MF_BASE_URL` | 底座地址，覆盖默认的 `http://127.0.0.1:8000` |
| `GIT_COMMIT` / `CI_COMMIT_SHA` | 写进产物清单的 `commit` |

底座不在本机时（比如跑在另一台机器）：

```bash
MF_BASE_URL=http://192.168.1.20:8000 pnpm dev
```

## 不装这个插件行不行

行。底座会退化为**扫描模式**：每 2s 枚举本机 LISTEN 端口，反查 pid → cwd →
`package.json` → `appName`，再过一遍 HTTP 校验。

代价是**最多 2s 的发现延迟**，以及每次端口变化要做一次进程扫描（真机上约 10ms）。
不介意这两点就可以不装 —— 这也是零依赖的默认路径。

## 为什么不自己写个 HTTP 请求了事

可以，但有三处容易踩空，插件里都处理了：

1. **时序**：必须在 `listening` 之后才拿得到真实端口。在 `configureServer` 里直接读
   `server.config.server.port` 拿到的是配置值，如果端口被占、vite 让了端口，就是错的。
2. **静默失败**：底座没起时 `fetch` 会抛 `ECONNREFUSED`。不 try/catch 就是 dev server
   起不来的假故障。插件里超时 800ms 且吞掉错误。
3. **退出清理**：不报 `unannounce`，底座会认为你还在跑，页面一直指着一个已经死掉的端口，
   表现为转圈或 502。插件在 `close` 里发一次短超时的报告。

## 常见问题

**Q：底座重启后我要重启子应用吗？**
不用。底座启动 2s 内会自己扫到；装了这个插件的话，下次底座重启时你可以重新 `pnpm dev`，
也可以直接等扫描。想要 0 延迟就重启子应用的 dev server。

**Q：`base` 不一致会怎样？**
底座会拒绝认领并打印原因（`上报的 base "/x/" 与 manifest 的 "/child2/" 不一致`）。
这比"接上了但白屏"好查得多。

**Q：多个 worktree 同时起同一个应用？**
底座取端口较小的那个。想钉死某个端口，在底座 manifest 里写 `port`，或用 `pin: "remote"`
强制不走本地。

## License

MIT
