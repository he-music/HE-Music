package main

// A cleanup acceptance may contain several joined queued results (clear and
// close). Every error leaf must be queued; errors.Is would also swallow a real
// native failure joined with a queued result.
func taskbarQueuedCleanup(err error) bool {
	if err == errTaskbarQueued {
		return true
	}
	if err == nil {
		return false
	}
	switch wrapped := err.(type) {
	case interface{ Unwrap() []error }:
		leaves := wrapped.Unwrap()
		if len(leaves) == 0 {
			return false
		}
		for _, leaf := range leaves {
			if !taskbarQueuedCleanup(leaf) {
				return false
			}
		}
		return true
	case interface{ Unwrap() error }:
		return taskbarQueuedCleanup(wrapped.Unwrap())
	default:
		return false
	}
}
