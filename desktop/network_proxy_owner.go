package main

import "context"

// Network work runs outside the UI thread, between two main-thread checks.
// The authorization callback is the same lifecycle gate used by Apply/Current.
func (p *NetworkProxy) testForOwner(ctx context.Context, c NetworkProxyConfig, authorize func(context.Context) error) (NetworkProxyTestResult, error) {
	if err := authorize(ctx); err != nil {
		return NetworkProxyTestResult{}, err
	}
	result, err := p.test(ctx, c)
	if ownerErr := authorize(ctx); ownerErr != nil {
		return NetworkProxyTestResult{}, ownerErr
	}
	return result, err
}
