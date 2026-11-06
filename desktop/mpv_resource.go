package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/he-music/HE-Music/desktop/internal/audiodecrypt/transform"
)

type mpvResource struct {
	ctx       context.Context
	cancel    context.CancelFunc
	url       string
	token     string
	upstream  string
	file      *os.File
	info      os.FileInfo
	files     *NativeFiles
	lease     *directoryLease
	registry  *mpvResourceRegistry
	mu        sync.Mutex
	closed    bool
	closeOnce sync.Once
	readers   sync.WaitGroup
	stopLease func() bool
}

type mpvResourceRegistry struct {
	// 写入者持有 mutation 直到提交或撤销，禁止确认释放后、文件事务结束前出现新原生读者。
	mutation sync.Mutex
	mu       sync.Mutex
	entries  map[string]*mpvResource
}

var mpvResources = mpvResourceRegistry{entries: make(map[string]*mpvResource)}

func newMpvResource(ctx, owner context.Context, request MpvLoadRequest) (*mpvResource, error) {
	return mpvResources.create(ctx, owner, desktopFiles, desktopGateway, request)
}

func (registry *mpvResourceRegistry) create(ctx, owner context.Context, files *NativeFiles, gateway *NetworkGateway, request MpvLoadRequest) (*mpvResource, error) {
	registry.mutation.Lock()
	defer registry.mutation.Unlock()
	gateway.mu.RLock()
	host, prefix := gateway.host, gateway.prefix
	gateway.mu.RUnlock()
	if host == "" || prefix == "" {
		return nil, mpvFail("source", "current gateway is unavailable")
	}
	token, err := newDirectoryToken()
	if err != nil {
		return nil, err
	}
	runContext, cancel := context.WithCancel(ctx)
	resource := &mpvResource{ctx: runContext, cancel: cancel, token: token, registry: registry, files: files}
	resource.url = "http://" + host + prefix + "/__mpv/" + token
	if request.LocalRef != nil {
		lease, err := files.state.acquireDirectory(owner, request.FileEpoch, request.LocalRef.GrantToken)
		if err != nil {
			cancel()
			return nil, err
		}
		resource.lease = lease
		resource.stopLease = context.AfterFunc(lease.Context(), cancel)
		file, err := files.state.resolveLocalFile(lease, *request.LocalRef)
		if err != nil {
			resource.close()
			return nil, err
		}
		resource.file = file
		info, err := file.Stat()
		if err != nil {
			resource.close()
			return nil, err
		}
		resource.info = info
	} else {
		if err := validateMpvGatewayURL(request.URL, host, prefix); err != nil {
			resource.close()
			return nil, err
		}
		resource.upstream = request.URL
	}
	if err := runContext.Err(); err != nil {
		resource.close()
		return nil, err
	}
	registry.mu.Lock()
	registry.entries[token] = resource
	registry.mu.Unlock()
	return resource, nil
}

// 仅 Go 当前监听地址和随机前缀能授权资源；渲染进程提供的 origin 不能作为授权凭证。
func validateMpvGatewayURL(raw, host, prefix string) error {
	if len(raw) > desktopGatewayMaxTarget || strings.ContainsAny(raw, "\x00\r\n") {
		return mpvFail("source", "invalid gateway media URL")
	}
	value, err := url.Parse(raw)
	if err != nil || value.Scheme != "http" || value.Host != host || value.User != nil || value.Fragment != "" || value.Opaque != "" {
		return mpvFail("source", "media URL is outside the current gateway")
	}
	if value.EscapedPath() == prefix+"/__audio" {
		query, err := url.ParseQuery(value.RawQuery)
		if err != nil {
			return mpvFail("source", "invalid encrypted audio parameters")
		}
		_, paramErr := transform.Parse(query.Get("audio_params"))
		_, err = parseDesktopGatewayURL(query.Get("url"))
		if err != nil || paramErr != nil {
			return mpvFail("source", "invalid encrypted audio resource")
		}
		return nil
	}
	if target, ok := strings.CutPrefix(value.EscapedPath(), prefix+"/__proxy/"); ok {
		if value.RawQuery != "" {
			target += "?" + value.RawQuery
		}
		if _, err := parseDesktopGatewayURL(target); err == nil {
			return nil
		}
	}
	return mpvFail("source", "media route is not allowed")
}

func (r *mpvResource) close() {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.cancel()
		r.mu.Unlock()
		if r.registry != nil {
			r.registry.mu.Lock()
			delete(r.registry.entries, r.token)
			r.registry.mu.Unlock()
		}
		r.readers.Wait()
		if r.file != nil {
			_ = r.file.Close()
		}
		if r.stopLease != nil {
			r.stopLease()
		}
		if r.lease != nil {
			r.lease.Release()
		}
	})
}

func (g *NetworkGateway) serveMpvResource(w http.ResponseWriter, request *http.Request, token string) {
	mpvResources.serve(g, w, request, token)
}

func (registry *mpvResourceRegistry) serve(gateway *NetworkGateway, w http.ResponseWriter, request *http.Request, token string) {
	if request.Method != "GET" && request.Method != "HEAD" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	registry.mu.Lock()
	resource := registry.entries[token]
	registry.mu.Unlock()
	if resource == nil || request.URL.RawQuery != "" {
		http.NotFound(w, request)
		return
	}
	resource.mu.Lock()
	if resource.closed || resource.ctx.Err() != nil {
		resource.mu.Unlock()
		http.NotFound(w, request)
		return
	}
	resource.readers.Add(1)
	resource.mu.Unlock()
	defer resource.readers.Done()
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(resource.ctx, func() {
		cancel()
		// 取消时中断阻塞的本地响应写入，防止 Windows 标签提交期间遗留文件读者。
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
	})
	defer func() { stop(); cancel() }()
	w.Header().Set("Cache-Control", "no-store")
	if resource.file != nil {
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, request.WithContext(ctx), resource.info.Name(), resource.info.ModTime(), io.NewSectionReader(resource.file, 0, resource.info.Size()))
		return
	}
	upstream, err := http.NewRequestWithContext(ctx, request.Method, resource.upstream, nil)
	if err != nil {
		http.Error(w, "invalid media resource", http.StatusBadRequest)
		return
	}
	upstream.Header = request.Header.Clone()
	upstream.Host = upstream.URL.Host
	gateway.serveHTTP(&mpvMediaWriter{ResponseWriter: w}, upstream)
}

// 网关负责上游重定向与播放列表重写；原生入口仅接受独立音频，禁止向 libmpv 透传重定向和清单。
type mpvMediaWriter struct {
	http.ResponseWriter
	rejected bool
}

func (w *mpvMediaWriter) WriteHeader(status int) {
	header := w.Header()
	mime := strings.ToLower(header.Get("Content-Type"))
	if status >= 300 && status < 400 || strings.Contains(mime, "mpegurl") || strings.Contains(mime, "dash+xml") {
		w.rejected = true
		header.Del("Location")
		header.Del("Content-Length")
		header.Set("Content-Type", "text/plain")
		w.ResponseWriter.WriteHeader(http.StatusUnsupportedMediaType)
		return
	}
	header.Del("Location")
	w.ResponseWriter.WriteHeader(status)
}

func (w *mpvMediaWriter) Write(data []byte) (int, error) {
	if w.rejected {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}
func (w *mpvMediaWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (registry *mpvResourceRegistry) prepareMutation(ctx context.Context, files *NativeFiles, info os.FileInfo, session *mpvSession) (func(), error) {
	registry.mutation.Lock()
	if err := ctx.Err(); err != nil {
		registry.mutation.Unlock()
		return nil, err
	}
	registry.mu.Lock()
	var matching []*mpvResource
	for _, resource := range registry.entries {
		if resource.files == files && resource.info != nil && os.SameFile(resource.info, info) {
			matching = append(matching, resource)
			resource.cancel()
		}
	}
	registry.mu.Unlock()
	session.mu.Lock()
	var err error
	if session.resource != nil && session.resource.files == files && session.resource.info != nil && os.SameFile(session.resource.info, info) {
		session.snapshot.Session++
		session.intent = false
		err = session.stopLocked()
		session.emitLocked("emptied")
	}
	session.mu.Unlock()
	for _, resource := range matching {
		resource.close()
	}
	if err != nil {
		registry.mutation.Unlock()
		return nil, err
	}
	return registry.mutation.Unlock, nil
}
