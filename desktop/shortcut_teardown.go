package main

import (
	"context"
	"errors"
)

func (s *shortcutState) teardown(ctx context.Context, generation uint64) error {
	if s.owner == nil && generation != 0 && s.generation == generation+1 {
		return nil
	}
	if !s.owns(ctx, generation) {
		return errors.New("shortcut owner or generation is no longer active")
	}
	s.revoke()
	return nil
}
