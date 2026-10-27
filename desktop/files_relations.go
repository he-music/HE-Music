package main

import "github.com/egoist/mygo"

type directoryOverlap struct {
	token    string
	handle   *directoryHandle
	relation DirectoryRelation
}

// os.SameFile may lazily open Windows paths. Snapshot pointers on main, compute
// relationships on the bound goroutine, then let the caller recheck map identity.
func (s *nativeFilesState) directoryOverlaps(op *fileOperation, candidate *directoryHandle) ([]directoryOverlap, error) {
	var snapshot []ownedDirectory
	err := s.main(op.owner, func(parent *mygo.Window) error {
		if !s.owns(op.owner, op.epoch) || s.busy != op || parent != op.parent || op.phase.Load() != fileOpActive {
			return errFilesOwner
		}
		for _, entry := range s.grants {
			snapshot = append(snapshot, entry)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var overlaps []directoryOverlap
	for _, entry := range snapshot {
		if relation := directoryIdentityRelation(entry.handle, candidate); relation != DirectoryUnrelated {
			overlaps = append(overlaps, directoryOverlap{token: entry.grant.Token, handle: entry.handle, relation: relation})
		}
	}
	return overlaps, nil
}
