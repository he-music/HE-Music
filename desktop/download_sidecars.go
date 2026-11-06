package main

import (
	"os"
	"path"
	"strings"
)

type downloadStagedSidecar struct {
	private *downloadOwnedPrivate
	public  string
	stage   string
}

func (t *downloadTransfer) prepareSidecars(root *os.Root, target string, owned *[]*downloadOwnedPrivate) ([]downloadStagedSidecar, error) {
	o := t.job.options
	if o == nil || !o.SaveSidecars || o.Metadata == nil {
		return nil, nil
	}
	var items []downloadStagedSidecar
	stage := func(public, kind string, data []byte) error {
		p, err := downloadNewPrivate(root, "sidecar", t.job.io)
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
		items = append(items, downloadStagedSidecar{p, public, kind})
		return nil
	}
	base := strings.TrimSuffix(path.Base(target), path.Ext(target))
	if o.WriteLyrics && o.Metadata.Lyrics != "" {
		if err := stage(base+".lrc", "lyrics_file", []byte(o.Metadata.Lyrics)); err != nil {
			if err := t.optionalFailure("lyrics_file", err); err != nil {
				return nil, err
			}
		}
	}
	if o.WriteCover {
		data, _, err := downloadNativeFetchCover(t.job.ctx, t.coordinator.client, o.Metadata.CoverURL)
		if err == nil {
			err = stage(base+".jpg", "cover_file", data)
		}
		if err != nil {
			if err := t.optionalFailure("cover_file", err); err != nil {
				return nil, err
			}
		}
	}
	return items, nil
}
