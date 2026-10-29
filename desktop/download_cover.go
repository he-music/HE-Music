package main

import (
	"context"
	"io"
	"net/http"
	"sync"
)

func downloadNativeFetchCover(ctx context.Context, client *http.Client, rawURL string) (data []byte, mime string, err error) {
	if !downloadNativeCoverURL(rawURL) {
		return nil, "", errDownloadOptions
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	var once sync.Once
	var closeErr error
	closeBody := func() { once.Do(func() { closeErr = resp.Body.Close() }) }
	stop := context.AfterFunc(ctx, closeBody)
	defer func() {
		stop()
		closeBody()
		if err == nil {
			err = closeErr
		}
	}()
	if resp.StatusCode != 200 || resp.ContentLength > 16<<20 || resp.Header.Get("Content-Range") != "" || resp.Uncompressed {
		return nil, "", errDownloadOptions
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > 16<<20 {
		return nil, "", errDownloadOptions
	}
	if err = ctx.Err(); err != nil {
		return nil, "", err
	}
	mime = http.DetectContentType(data)
	return data, mime, nil
}
