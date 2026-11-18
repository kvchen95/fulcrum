# fulcrum-toolchain

微前端工作流的命令行：起底座、代起子应用、打站点、收尸、校验、模拟测试环境。

```bash
pnpm add -D fulcrum-toolchain
```

装完得到 `fulcrum` 命令。

## 命令

```bash
fulcrum dev                    # 起底座（不代起子应用）
fulcrum dev -- child child2    # 顺带代起仓库内子应用（--all 全起）
fulcrum build [names...]       # 打站点 → dist/site（--clean 全清，--with <name> 跨仓构建）
fulcrum preview [port]         # 静态伺服 dist/site，寻址方式与线上一致
fulcrum stop                   # 收尸：pid 文件丢了也能按端口反查
fulcrum check                  # 6 道闸门
fulcrum mock-env <port> [dir]  # 起一个"测试环境"静态替身
```

`cwd` 就是项目根；manifest 从 `cwd` 向上找最多 3 层，所以从 `src/`、`app/` 这种子目录里跑也能找到。

## 为什么 CLI 是一个独立包

CLI 要用 entry 侧插件的内部实现（manifest 解析、三级回落目标计算、产物清单、端口反查）。
如果把这些模块各自 `export` 出去，它们就被固化成公共 API——改个内部函数名就破坏 semver。

所以 `fulcrum-entry-vite` 只开一个门：

```js
import { loadManifest, buildProxy, resolveArtifact } from 'fulcrum-entry-vite/internal';
```

门上的牌子写着 `internal`，语义是"插件是公开 API，这些是实现细节"。CLI 作为独立包依赖它，
版本在同一个 monorepo 里联动发布；插件本身保持"只有 `fulcrum()` 一个导出"的干净边界。

另一个好处：只想装插件的人不会被塞一个 CLI；想全局装 CLI（`pnpm add -g fulcrum-toolchain`）也不用连插件一起装。

## `dev` 做了什么

```
[dev] 1/6 读 manifest
[dev] 2/6 端口体检（底座 8000，不代起任何子应用）
[dev] 3/6 生成 proxy（manifest 写错会在这里就炸）
[dev] 4/6 跳过：不代起子应用
[dev] 5/6 跳过：没有代起的子应用
[dev] 6/6 起底座
```

六步打点，卡在哪一步一眼可见——这是被"pnpm run dev 一直挂着、一行输出都没有"坑过之后的产物。

关键行为：

- **不代起任何子应用是默认**：子应用在自己仓库里 `pnpm dev`，底座 2s 内扫到端口
- **底座已在跑就复用**：靠 `GET /__mf/status` 验证占用 8000 的是不是本模板的底座，是就只起本次的子应用，不抢端口
- **不静默换端口**：端口被占直接失败并说清是谁占的
- **vite 不走 npx**：直接 `node <找到的 vite>/bin/vite.js`，避免 npx 在本地没装时交互式询问（脚本里表现为永远挂着），也少一层 `sh -c`，Ctrl-C 后不留孤儿

## `build` 做了什么

```bash
fulcrum build              # 底座 + 全部子应用 → dist/site（清空重建）
fulcrum build -- child     # 增量：只重打 A，其它应用的产物保留
fulcrum build -- --clean   # 强制全清
fulcrum build --with child # 进子应用仓库跑它自己的 build，再收集产物
```

产物是一个 root 覆盖全部应用，不用给每个子应用配 alias：

```
dist/site/
  index.html        底座
  assets/…          底座资源
  child/index.html  A → /child/
  child2/index.html B → /child2/
dist/fulcrum-manifest.json   本次构建清单
dist/nginx.conf              可直接用的示例配置
```

跨仓拿不到源码时，现打失败会**退回复用上次产物并告警**，不会让整次发版挂掉——静默用旧包是最难查的事故。

## `check` 的 6 道闸门

| 闸门 | 查什么 |
|---|---|
| 1 | manifest 结构与 `base` 前缀冲突（`/child` 会吃掉 `/child2`） |
| 2 | 每个 remote 都能算出一个目标（本地 / 产物 / remote 至少有一个） |
| 3 | 代理规则与 manifest 一致，且都带 `ws: true` 与超时 |
| 4 | 基座源码里没有子应用地址字面量（扫整个基座目录，跳过注释与测试文件） |
| 5 | 打包产物里 `__MF_*__` 注入已被替换成字面量 |
| 6 | `.mf-dev-local.json` 这类本机覆盖没有被提交 |

第 4 道闸门**不写死文件清单**：写死的话换个目录结构这条闸门就悄悄失效了。

## `stop` 为什么这么长

不依赖 `ss` / `lsof` 是否存在：先看 `.dev-pids.json`，再按 manifest 端口反查 PID
（`ss` → `lsof` → 直读 `/proc/net/tcp` 与 fd），最后用真实 TCP 连接复核，不谎报"端口已释放"。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MF_MANIFEST` | 指定 manifest 路径（如切到 `apps.manifest.demo.json`） |
| `MF_APPS_DIR` | 跨仓查找产物时搜索的根目录 |
| `MF_LOCAL_APPS` | 本次本机起了哪几个应用（不依赖磁盘文件） |
| `MF_HOST` | 验收时指向的底座地址 |

## License

MIT
