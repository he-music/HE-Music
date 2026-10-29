# 标签保存的平台目录持久化接线候选

父集成状态：以下策略已接入生产保存流程，新增 Darwin 生产流程的 unsupported/真实 I/O error 注入回归，并通过独立窄复核。Windows 仍只有静态交叉编译，具体验证见 [第十轮迁移日志](../docs/plans/mygo-migration-log.md#第十轮本地音乐与下载持久化及多格式)。

本 lane 只新增叶文件，不改既有生产文件。父会话已确认：Windows 保留 `os.Root.Rename`、文件 `Sync` 和恢复副本，允许保存并发布新引用，但明确返回 `durability_uncertain`，不宣称断电持久性。

## 证据和边界

本机 Go 1.27.3 源码：

- `src/syscall/syscall_windows.go:755`：`Fsync` 直接调用 `FlushFileBuffers`。
- `src/os/root_windows.go:386`：`renameat` 调用内部 `windows.Renameat`。
- `src/internal/syscall/windows/at_windows.go:439`：以源目录 handle 打开源项，使用 `NtSetInformationFile(FileRenameInformationEx)` 和目标 `RootDirectory`，不支持时 fallback `FileRenameInformation`。没有可请求 write-through 的 rename flag。
- `root.Open(".")` 给的是只读目录 handle；不能用其 `Sync` 冒充普通用户可用的目录 fsync。既有逻辑在 rename 前即因此失败。

Windows API 文档参考（本次未联网抓取）：

- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)：要求 GENERIC_WRITE；整卷 flush 需要管理员，超出约束。
- [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)：WRITE_THROUGH 的明确 flush 描述针对 copy/delete，不能据此保证本次同卷 rename 的目录持久性；路径 API 也不提供当前 pinned os.Root 授权语义。
- [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)：REPLACEFILE_WRITE_THROUGH 不受支持。

因此不添加路径重建、卷句柄或额外 syscall。Windows helper 返回 `(false, nil)` 表示已明确建模的平台持久性限制；closed root 等真实 I/O 错误返回 `(false, err)`。POSIX 仍严格调用 pinned root 的目录 `Sync`，并返回打开、同步、关闭错误。不把 POSIX 文件系统不支持目录同步的错误当作成功。

文件内容的 Sync 成功也不保证 Windows rename 和备份目录项在断电后保留；恢复副本只是当前可见且已同步文件内容的独立副本，不能声称其目录项已 durable。不得因该限制阻止所有 Windows 保存，也不得将其映射为 `ok`。

## 父会话精确接线

新增叶文件可直接进入 desktop 包；它们不依赖 SDK。以下变更由父会话对其现有 WIP 的 `desktop/files_metadata.go` 执行。

1. 原 `metadataSyncDirectory(parent)` 的预提交调用替换为 `metadataPrepareCommitDirectory(parent)`。位置仍在 `backup.Sync()`、`work.Sync()` 之后，在最后一轮 route/identity/hash/lease/claim 检查之前。
2. 原 `parent.Rename(workName, path.Base(req.Ref.RelativePath))` 原样保留。保留 `keepBackup = true`、`recovery` 和所有提交前授权、取消、identity/hash、route 检查；不得把本 helper 当作 identity 校验。
3. 原 `result := MetadataResult{Code: "ok", Committed: true, RecoveryName: recovery}` 之后的 `parent.Open(".")`、`dir.Sync()`、`dir.Close()` 整段替换为：

```go
directoryDurable, err := metadataCommitDirectoryDurability(parent)
if err != nil {
    return MetadataResult{Code: "durability_uncertain", Committed: true, RecoveryName: recovery}
}
if !directoryDurable {
    result.Code = "durability_uncertain"
}
```

真实提交后同步错误继续保留原错误处理语义；Windows 的平台限制 `false, nil` 继续往下发布新引用。不能写成 `if !directoryDurable { return ... }`。

4. 保留后续 `registerLocalFile`、旧 alias 失效、重新 hash，以及填充 `result.Ref`、`result.Info`、`result.SHA256` 的完整路径。仅在这三个字段赋值之后、`parent.Remove(backupName)` 之前插入：

```go
if !directoryDurable {
    return result
}
```

这样 Windows 返回 `durability_uncertain + committed:true + freshRef + info + sha256 + recoveryName`，`keepBackup` 保持 true，备份不会自动删除。POSIX 只有目录同步成功才继续原清理流程。后续注册/hash/owner 错误沿用既有 committed 错误结果，不伪造完整字段。

5. 原私有 `metadataSyncDirectory` 在没有其他调用时可删除，或保留但不可继续用于该保存路径。不改全局文件下载/其他持久化路径。

## 现有前端合同检查

只读核查了 `src/platform/localMetadataSession.ts:296`：对于 committed 结果按 grant/path 范围验证 ref，所有 committed code 都执行 refreshLibrary；通过对象展开保留 ref/info/sha256/recoveryName，没有仅接受 ok 的限制。

`src/components/Modal/MygoSongInfoEditor.vue:212`：任何 committed 结果都会结束 busy 并清空旧 baseline；非 ok 展示 committed_needs_review，存在 recoveryName 时展示 recovery_hint。它没有直接把返回的新 Info/SHA256 装回当前表单；这符合当前需要复核的合同，后续编辑需重新读取。父会话应确认其 WIP 未改变这套逻辑。

父接线验收应加入实际 saveMetadata 路径回归：Windows 策略得到 uncertain 时仍发布 freshRef/Info/SHA256、旧 alias 失效、backup 仍在；真正目录 I/O 错误不进入 successful publication；POSIX durable 分支继续原清理。当前叶测试不替代这些父接线测试。

## 验证

- macOS 运行独立叶文件测试：目录同步、closed-root 错误、独立 backup、替换后新 identity、Root 越界拒绝、目录路由被 symlink 替换后仍只操作 pinned 目录。
- Windows amd64/arm64 交叉编译同一策略与替换测试；未运行 Windows 二进制。Windows 实机普通账户及实际文件系统行为仍待验证。
- 不执行 SDK 安装、不联网、不启动 App，不修改父目录。
- 现有 `files_metadata_other.go` 在当前子仓仍是 `!darwin`，与 Linux/Windows 属性 leaf 重复定义；这是既有接线问题，本 lane 不修改。父会话如已修复需保留其更精确 build tag。为避免该无关基线冲突，验证使用明确文件列表。
