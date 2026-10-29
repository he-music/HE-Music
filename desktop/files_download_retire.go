package main

import (
	"context"

	"github.com/egoist/mygo"
)

// Retired IDs contain no request data and are never evicted within an owner.
// At the limit, callers must begin a new file session before retiring more jobs.
const downloadMaxForgotten = 4096

func (f *NativeFiles) ForgetDownload(ctx context.Context, epoch uint64, operationID string) (bool, error) {
	return downloadCoordinatorFor(&f.state).forget(&f.state, ctx, epoch, operationID)
}

func (c *downloadCoordinator) forget(s *nativeFilesState, ctx context.Context, epoch uint64, id string) (bool, error) {
	forgotten := false
	err := s.main(ctx, func(parent *mygo.Window) error {
		if !s.owns(ctx, epoch) {
			return errFilesOwner
		}
		decoded, err := decodeDirectoryToken(id)
		if err != nil || len(decoded) != 32 {
			return errDownload
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.owner != ctx || c.epoch != epoch {
			return nil
		}
		j := c.jobs[id]
		if j == nil {
			// A lost acknowledgement can be retried without reviving the consumed nonce.
			_, forgotten = c.forgotten[id]
			return nil
		}
		if j.retired || j.lease.owner != ctx || j.lease.epoch != epoch {
			return errDownload
		}
		grant, ok := s.grants[j.lease.token]
		if !ok || grant.handle != j.lease.handle || grant.handle.retired.Load() || parent != j.lease.parent {
			return errFilesLease
		}
		// Done in the state alone is insufficient: cleanup owns this channel.
		select {
		case <-j.done:
		default:
			return errFilesBusy
		}
		if !j.state.Done {
			return errFilesBusy
		}
		if len(c.forgotten) >= downloadMaxForgotten {
			return errFilesBusy
		}
		if c.forgotten == nil {
			c.forgotten = make(map[string]struct{})
			context.AfterFunc(ctx, func() {
				c.mu.Lock()
				defer c.mu.Unlock()
				if c.owner == ctx && c.epoch == epoch {
					c.forgotten = nil
				}
			})
		}
		c.forgotten[id] = struct{}{}
		// Stops grant/owner callbacks and drops the ref before removing the job.
		// The worker has already released its lease and active permit.
		c.retireLocked(j)
		delete(c.jobs, id)
		forgotten = true
		return nil
	})
	return forgotten, err
}
