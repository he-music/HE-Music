package main

// Opaque view identities are only interpreted by the platform callback. Reject
// cycles, ambiguous WebViews, oversized trees and excessive nesting in full;
// finding an early match never bypasses verification of the remaining tree.
func findNetworkProxyWebview(root uintptr, inspect func(uintptr) (bool, []uintptr)) uintptr {
	type node struct {
		id    uintptr
		depth int
	}
	queue := []node{{root, 0}}
	visited := make(map[uintptr]bool)
	var found uintptr
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current.id == 0 || visited[current.id] || len(visited) >= 256 || current.depth > 32 {
			return 0
		}
		visited[current.id] = true
		match, children := inspect(current.id)
		if match {
			if found != 0 {
				return 0
			}
			found = current.id
		}
		if len(children) > 256 || len(queue)+len(children) > 256 {
			return 0
		}
		for _, child := range children {
			queue = append(queue, node{child, current.depth + 1})
		}
	}
	return found
}
