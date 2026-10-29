# 下载持久化接缝交接

本线程只新增持久化 leaf 与存储测试；已有生产文件未修改。完整候选位于 `/tmp/hemusic-download-candidates/localDownloadSession.candidate.ts`，须由父线程通过 hashline 替换现有 session 后才成为生产实现。候选真实类的独立测试通过，不代表生产接线已完成。未启动 App、未访问外网、未读取用户数据库。

## 新增文件及契约

- `src/platform/localDownloadPersistence.ts`：`LocalDownloadSnapshot` 为持久化白名单；`LocalDownloadPersistence.load/save` 为可注入适配器；`createLocalDownloadPersistence()` 使用 localforage `name=local-data/storeName=local_download_history/key=history-v1` 独立存储。
- `src/platform/localDownloadPersistence.test.ts`：13 项测试，包括字段脱敏、11 格式、大字节数、保存快照复制、乱序保护、写失败恢复、坏数据及读失败保护。
- 格式共用 `validLocalDownloadFormat`，支持 mp3/wav/flac/aac/webm/m4a/mp4/ogg/aiff/aif/ape。
- 只保存 id/label/filename/quality/source(id/platform/name、links name/quality/format)/targetDirectory(displayPath)/phase/done/committed/received/total。source.links 不保存 size/url；不保存 grant/ref/epoch/URL/gateway/Blob/函数。
- 必须先成功 load，save 才允许写入；损坏和未知版本会报错，原值保留。保存队列按调用顺序写入，单次失败不阻塞后续保存。

## 会话候选

候选新增依赖：

```ts
persistence?: LocalDownloadPersistence;
directoryPath?(token: string): string | undefined;
directoryToken?(path: string): string | undefined;
resolveURL?: LocalDownloadResolver;
```

新增公开 `restored: Promise<void>`、`persistenceError: ShallowRef<string | undefined>`，以及 task 可选 `interrupted`。

以定义名作为定位锚点：

- `restore()`：全量校验后再合并；当前记录和 touched id 优先，晚 load 不覆盖正在下载的新记录；dispose 后不恢复。
- `archivedTask()`：成功和失败保留；未完成记录显示 failed/done/interrupted，不恢复任何旧轮询或授权。
- `retryArchived()`：通过 targetDirectory 查当前 token 和 access，调用纯 resolver 重新取 URL；等待返回后再次检查授权/path，随后 start 生成全新 operationId。归档 recipe 只补空 size 以满足原 resolver 入参类型，不恢复旧 size/url。
- `retire()`：归档直接删除元数据，无需旧 backend forget；当前 epoch 记录仍保留原 forget、pending、retrying 和 refresh guard。
- `publish()`：合并 live/archive，load 成功后串行保存白名单快照；任何保存失败写入可见 error ref。dispose 清理 live 授权不覆盖最后保存的历史。
- 删除 records>=64 拒绝新下载；保留同时最多 2 个未完成任务。
- 删除 MAX_BYTES 和 expires/2 分钟总寿命，仅保留每次 API 调用 3 秒 ACK deadline、字节非负安全整数与单调进度校验。未知 ACK 仍只查询原 id；未形成替代下载。

## 父线程已有文件精确接线

`src/platform/filesSession.ts`：

1. import `createLocalDownloadPersistence`；从纯 API 工具模块取得 resolver，禁止 import mygoFileModals（会循环 import FilesSession）。若父提供 `FilesSessionDependencies.resolveURL`，按该依赖接入。
2. 在 `new LocalDownloadSession({ access, ... })` 增加：

```ts
persistence: createLocalDownloadPersistence(),
directoryPath: (token) => this.directoryGrants.value.find(
  (grant) => grant.token === token && grant.epoch === this.epoch,
)?.displayPath,
directoryToken: (path) => this.directoryGrants.value.find(
  (grant) => grant.displayPath === path && grant.epoch === this.epoch,
)?.token,
resolveURL: deps?.resolveURL,
```

3. `initialize()` 在 begin 返回 epoch 后、发布 ready/构造 LocalFilesSession 之前调用 provider.restoreDirectories(epoch)，再次检查 disposed/epoch，安装返回 grants。unavailable 列表给用户可见提示。不要把 displayPath 当授权，所有操作仍经当前 token/access。
4. 目录已恢复后再构造 LocalFilesSession；其构造器会触发 scan，请避免重复 scan。下载历史可以提前 load，归档重试实际执行时才查当前 grants。

`src/components/Modal/MygoDownload.vue`：import `validLocalDownloadFormat`，替换原 87 行 quality filter 和 177 行 resolved format 验证的 mp3|flac 正则；展示 `session.persistenceError.value` 和 interrupted 提示并走现有 i18n。已恢复历史仍从 session.tasks 渲染、retry/retire。

`src/utils/mygoFileModals.ts`：`createMygoDownloadResolver` 原 mp3|flac 检查改用统一格式函数；推荐把 resolver factory 移至不依赖 UI/FilesSession 的纯叶模块，由 API songUrl 创建共享 resolver。保留 URL 协议/凭据/hash 校验和异常脱敏。

旧测试因明确需求变化须修改：`localDownloadSession.test.ts` 原 153 行的 2**40 拒绝项改为超安全整数；原 173 行两分钟停轮询断言改持续轮询；原 240 行 64 条历史阻止新下载改不阻止；原 273 行 wav 拒绝改允许；`localDownloadSession.retire.test.ts` 原 68 行也含 64 条容量断言。取消、撤销、unknown ACK 和 stale response 测试应继续保留。

## 独立候选验证与限制

`/tmp/hemusic-download-candidates/localDownloadSession.persistence.test.ts` 为 9 项候选类真实测试，覆盖恢复/新授权和新 id 重试/解析中撤权/晚 load/退出保存保护/读取错误不覆盖/串行保存与错误可见/无 32MiB 和 2min 限制/70 条历史不占活跃容量。父接线后可复制测试、将 import `./localDownloadSession.candidate` 改为生产 `./localDownloadSession`，并补 UI 和 FilesSession 目录恢复的集成证据。

已执行：leaf vitest 13/13；leaf ESLint；生产现状 `pnpm typecheck:web`；候选 fixture vitest 9/9；候选单独 tsc，均通过。首次 prettier 因 node_modules 缺失失败，后按授权软链主仓依赖重跑格式化成功。未执行最终生产会话测试，因为候选尚未接线；未做实际 UI 验证。所有检查使用指定 Node 24.22.1。

验收仍需父线程完成已有文件接线、更新需求冲突的旧测试、完整相关测试与 review。不能宣称持久化 UI 或 native 目录恢复已完成。
