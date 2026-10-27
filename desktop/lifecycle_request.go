package main

func (s *lifecycleState) requestClose() uint64 {
	s.nextRequest++
	s.pending = s.nextRequest
	s.acknowledged = false
	return s.pending
}

func (s *lifecycleState) matchesRequest(requestID uint64) bool {
	return s.ready() && requestID != 0 && s.pending == requestID
}

func (s *lifecycleState) acknowledge(requestID uint64) bool {
	if !s.matchesRequest(requestID) {
		return false
	}
	s.acknowledged = true
	return true
}

func (s *lifecycleState) clearRequest() {
	s.pending = 0
	s.acknowledged = false
}

func (s *lifecycleState) expireRequest(requestID uint64) bool {
	if !s.matchesRequest(requestID) || s.acknowledged {
		return false
	}
	s.invalidate()
	return true
}
