package main

import (
	"context"
	"image"
	"io"
	"net/http"
	"strings"
	"sync"
)

func downloadNativeFetchCover(ctx context.Context, client *http.Client, rawURL string) (data []byte, mime string, err error) {
	if rawURL == "" {
		return nil, "", errDownloadCoverUnavailable
	}
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
	if resp.StatusCode != http.StatusOK {
		return nil, "", downloadHTTPError{resp.StatusCode}
	}
	if resp.ContentLength > 16<<20 {
		return nil, "", errDownloadCoverLimit
	}
	if resp.Header.Get("Content-Range") != "" || resp.Uncompressed {
		return nil, "", errDownloadOptions
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > 16<<20 {
		return nil, "", errDownloadCoverLimit
	}
	if err = ctx.Err(); err != nil {
		return nil, "", err
	}
	mime = http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return nil, "", image.ErrFormat
	}
	return data, mime, nil
}
