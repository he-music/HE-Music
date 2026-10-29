package main

import (
	"context"
	"net/http"
	"os"
	"path"
	"strings"
)

type downloadStagedSidecar struct {
	private *downloadOwnedPrivate
	public  string
}

func downloadNativePrepareSidecars(ctx context.Context, client *http.Client, root *os.Root, target string, o *DownloadOptions, d downloadIO, owned *[]*downloadOwnedPrivate) ([]downloadStagedSidecar, error) {
	if o == nil || !o.SaveSidecars || o.Metadata == nil {
		return nil, nil
	}
	var items []downloadStagedSidecar
	stage := func(public string, data []byte) error {
		p, err := downloadNewPrivate(root, "sidecar", d)
		if p != nil {
			*owned = append(*owned, p)
		}
		if err != nil {
			return err
		}
		if err = p.write(data); err != nil {
			return err
		}
		if err = p.sync(); err != nil {
			return err
		}
		if err = p.close(); err != nil {
			return err
		}
		items = append(items, downloadStagedSidecar{p, public})
		return nil
	}
	base := strings.TrimSuffix(path.Base(target), path.Ext(target))
	if o.WriteLyrics && o.Metadata.Lyrics != "" {
		if err := stage(base+".lrc", []byte(o.Metadata.Lyrics)); err != nil {
			return nil, err
		}
	}
	if o.WriteCover {
		data, _, err := downloadNativeFetchCover(ctx, client, o.Metadata.CoverURL)
		if err != nil {
			return nil, err
		}
		if err = stage(base+".jpg", data); err != nil {
			return nil, err
		}
	}

	return items, nil
}
